'use strict';

const { classifyCodexServiceError } = require('../codex/codex-service');
const { CommandCoordinator } = require('../control/command-coordinator');
const { createDiagnosticReport } = require('../diagnostics/diagnostic-report');
const { ATTACHMENT_ID_PATTERN } = require('../attachments/attachment-store');
const { TurnInputRouter } = require('../queue/turn-input-queue');
const { sanitizeDisplayText } = require('../events/display-text');

class ApiRouteError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'ApiRouteError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = { ...details };
  }
}

const THREAD_ACTION_METHODS = Object.freeze({
  resume: 'resumeThread',
  fork: 'forkThread',
  archive: 'archiveThread',
  unarchive: 'unarchiveThread',
  rename: 'setThreadName',
  compact: 'compactThread',
  settings: 'updateThreadSettings',
  startTurn: 'startTurn',
  interrupt: 'interruptTurn',
});
const QUEUE_CONTROL_FIELDS = Object.freeze([
  'observedThreadId',
  'desktopThreadId',
  'requireObservedTargetMatch',
]);
const NEW_THREAD_MATERIALIZATION_WINDOW_MS = 30_000;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function startedThreadId(response) {
  const confirmedThreadId = response
    && response.status === 'confirmed'
    && response.operation === 'thread.start'
    && response.observation
    && response.observation.threadId;
  if (confirmedThreadId) return String(confirmedThreadId).trim();
  const thread = response && response.thread && typeof response.thread === 'object'
    ? response.thread
    : response;
  return String(thread && (thread.id || thread.threadId) || '').trim();
}

function pickDefined(source, fields) {
  const input = objectOrEmpty(source);
  const result = {};
  for (const field of fields) {
    if (input[field] !== undefined) result[field] = input[field];
  }
  return result;
}

function parseBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function eventCursorParams(searchParams) {
  const serverInstanceId = searchParams.get('serverInstanceId');
  const snapshotVersionValue = searchParams.get('snapshotVersion');
  const cursorValue = searchParams.get('cursor');
  const snapshotVersion = snapshotVersionValue === null ? undefined : Number(snapshotVersionValue);
  const cursor = cursorValue === null ? undefined : Number(cursorValue);
  if ((snapshotVersionValue !== null && (!Number.isSafeInteger(snapshotVersion) || snapshotVersion <= 0))
    || (cursorValue !== null && (!Number.isSafeInteger(cursor) || cursor < 0))
    || (serverInstanceId !== null && serverInstanceId.length > 128)) {
    throw new ApiRouteError(
      'INVALID_EVENT_CURSOR',
      'Event cursor metadata is invalid.',
      400,
    );
  }
  return pickDefined({
    serverInstanceId: serverInstanceId || undefined,
    snapshotVersion,
    cursor,
  }, ['serverInstanceId', 'snapshotVersion', 'cursor']);
}

function requestUrl(request = {}) {
  try {
    return new URL(request.url || request.path || '/', 'http://codex2frp.local');
  } catch {
    throw new ApiRouteError('INVALID_REQUEST_URL', 'The request URL is invalid.');
  }
}

function listThreadParams(searchParams) {
  return pickDefined({
    ancestorThreadId: searchParams.get('ancestorThreadId') || undefined,
    archived: parseBoolean(searchParams.get('archived')),
    cursor: searchParams.get('cursor') || undefined,
    cwd: searchParams.get('cwd') || undefined,
    limit: parsePositiveInteger(searchParams.get('limit')),
    parentThreadId: searchParams.get('parentThreadId') || undefined,
    searchTerm: searchParams.get('searchTerm') || undefined,
    sortDirection: searchParams.get('sortDirection') || undefined,
    sortKey: searchParams.get('sortKey') || undefined,
    useStateDbOnly: parseBoolean(searchParams.get('useStateDbOnly')),
  }, [
    'ancestorThreadId',
    'archived',
    'cursor',
    'cwd',
    'limit',
    'parentThreadId',
    'searchTerm',
    'sortDirection',
    'sortKey',
    'useStateDbOnly',
  ]);
}

function listModelParams(searchParams) {
  return pickDefined({
    cursor: searchParams.get('cursor') || undefined,
    limit: parsePositiveInteger(searchParams.get('limit')),
    includeHidden: parseBoolean(searchParams.get('includeHidden')),
  }, ['cursor', 'limit', 'includeHidden']);
}

function isActiveTurn(turn) {
  const status = String(turn && turn.status || '').toLowerCase();
  return status === 'inprogress' || status === 'active' || status === 'running';
}

function isSteerableTurn(turn) {
  if (!turn || turn.steerable === false) return false;
  const kind = String(turn.kind || turn.type || '').toLowerCase();
  return kind !== 'review' && kind !== 'compact' && kind !== 'compaction';
}

function deriveThreadStatus(response, requestedThreadId) {
  const thread = response && response.thread && typeof response.thread === 'object'
    ? response.thread
    : {};
  const threadId = String(thread.id || requestedThreadId || '');
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const active = [...turns].reverse().find(isActiveTurn);
  return {
    threadId,
    status: thread.status === undefined ? { type: 'unknown' } : thread.status,
    activeTurn: active ? {
      threadId,
      turnId: String(active.id || ''),
      status: 'active',
      steerable: isSteerableTurn(active),
    } : null,
  };
}

function terminalTurn(turn) {
  const status = String(turn && turn.status || '').toLowerCase();
  return ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(status);
}

function deriveQueueDispatchState(response, requestedThreadId) {
  const thread = response && response.thread && typeof response.thread === 'object'
    ? response.thread
    : {};
  const rawStatus = thread.status;
  const status = typeof rawStatus === 'string'
    ? rawStatus.toLowerCase()
    : String(rawStatus && rawStatus.type || '').toLowerCase();
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  return {
    threadId: String(thread.id || requestedThreadId || ''),
    threadStatus: status,
    terminal: terminalTurn(latestTurn),
  };
}

function queuedTurnInput(item) {
  const input = [];
  if (typeof item.text === 'string' && item.text.trim()) {
    input.push({ type: 'text', text: item.text });
  }
  for (const attachment of Array.isArray(item.attachments) ? item.attachments : []) {
    if (!attachment || typeof attachment !== 'object') continue;
    if (attachment.input && typeof attachment.input === 'object') {
      input.push({ ...attachment.input });
    } else if (['image', 'localImage', 'mention', 'skill'].includes(attachment.type)) {
      input.push({ ...attachment });
    }
  }
  return input;
}

function isStoredAttachmentDescriptor(attachment) {
  return Boolean(
    attachment
    && typeof attachment === 'object'
    && ATTACHMENT_ID_PATTERN.test(String(attachment.id || '')),
  );
}

function attachmentUpload(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  if (Object.hasOwn(attachment, 'dataUrl')) return attachment;
  if (attachment.type === 'image' && typeof attachment.url === 'string'
    && attachment.url.startsWith('data:')) {
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataUrl: attachment.url,
    };
  }
  const nested = attachment.input;
  if (nested && typeof nested === 'object' && nested.type === 'image'
    && typeof nested.url === 'string' && nested.url.startsWith('data:')) {
    return {
      name: attachment.name || nested.name,
      mimeType: attachment.mimeType || nested.mimeType,
      dataUrl: nested.url,
    };
  }
  return null;
}

function containsUnnormalizedDataUrl(attachment) {
  try {
    return /data:[^,;]+;base64,/i.test(JSON.stringify(attachment));
  } catch {
    return true;
  }
}

function statusForError(error, classified) {
  if (Number.isInteger(error && error.statusCode)) return error.statusCode;
  switch (classified.kind) {
    case 'forbidden': return 403;
    case 'notFound': return 404;
    case 'conflict': return 409;
    case 'timeout':
    case 'uncertain':
    case 'unavailable': return 503;
    case 'incompatible':
    case 'protocol': return 502;
    default: return 400;
  }
}

function errorResponse(error, options = {}) {
  const classified = classifyCodexServiceError(error, {
    mutation: options.mutation === true && error && error.mutationAttempted !== false,
  });
  return {
    handled: true,
    statusCode: statusForError(error, classified),
    body: {
      error: {
        code: String(error && error.code || classified.code || 'UNKNOWN'),
        kind: classified.kind,
        message: String(error && error.message || 'Request failed.'),
        details: objectOrEmpty(error && error.details),
        retryable: classified.retryable,
        uncertain: classified.uncertain,
      },
    },
  };
}

function success(body, statusCode = 200) {
  return { handled: true, statusCode, body: body === undefined ? {} : body };
}

const PUBLIC_SUBAGENT_STATES = new Set(['running', 'completed', 'failed', 'interrupted']);
const PUBLIC_SUBAGENT_EVENT_FIELDS = Object.freeze([
  'schemaVersion', 'type', 'summaryKind', 'eventId', 'id', 'sequence', 'cursor',
  'sourceOrdinal', 'order', 'turnId', 'time', 'timestamp', 'text', 'state', 'phase', 'source',
]);

function projectPublicSubagentEvent(event = {}) {
  if (event.summaryKind !== 'subagent') return event;
  const source = objectOrEmpty(event.subagent);
  const name = sanitizeDisplayText(source.name).trim().slice(0, 64);
  const state = String(source.state || source.status || '').toLowerCase();
  if (!name || !PUBLIC_SUBAGENT_STATES.has(state)) return null;
  const projected = {};
  for (const field of PUBLIC_SUBAGENT_EVENT_FIELDS) {
    if (Object.hasOwn(event, field)) projected[field] = event[field];
  }
  if (typeof projected.text === 'string') projected.text = sanitizeDisplayText(projected.text);
  projected.subagent = { name, state };
  return projected;
}

function projectPublicEventFeed(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Array.isArray(result.events)) return result;
  return {
    ...result,
    events: result.events.map(projectPublicSubagentEvent).filter(Boolean),
  };
}

class V3ApiRouter {
  constructor(options = {}) {
    if (!options.runtime || typeof options.runtime.getMeta !== 'function'
      || typeof options.runtime.withService !== 'function') {
      throw new TypeError('V3ApiRouter requires an AppServerRuntime-compatible runtime.');
    }
    this.runtime = options.runtime;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.locallyStartedEmptyThreads = new Map();
    this.eventRuntime = options.eventRuntime || null;
    if (this.eventRuntime && (
      typeof this.eventRuntime.read !== 'function'
      || typeof this.eventRuntime.snapshot !== 'function'
      || typeof this.eventRuntime.cursor !== 'function'
    )) {
      throw new TypeError('V3ApiRouter eventRuntime must expose read(), snapshot(), and cursor().');
    }
    this.protectionRegistry = options.protectionRegistry || null;
    if (this.protectionRegistry && (
      typeof this.protectionRegistry.status !== 'function'
      || typeof this.protectionRegistry.protect !== 'function'
      || typeof this.protectionRegistry.unprotect !== 'function'
    )) {
      throw new TypeError('V3ApiRouter protectionRegistry must expose status(), protect(), and unprotect().');
    }
    this.queue = options.queue || null;
    this.attachmentStore = options.attachmentStore || null;
    this.diagnosticContext = typeof options.diagnosticContext === 'function'
      ? options.diagnosticContext
      : () => ({});
    this.diagnosticTokens = Array.isArray(options.diagnosticTokens)
      ? [...options.diagnosticTokens]
      : [];
    this.queueCommandCoordinator = options.queueCommandCoordinator || null;
    if (this.queue && !this.queueCommandCoordinator) {
      const guard = options.protectedThreadGuard || options.guard;
      if (!guard || typeof guard.assertAllowed !== 'function') {
        throw new TypeError(
          'V3ApiRouter queue mutations require a queueCommandCoordinator or protected thread guard.',
        );
      }
      this.queueCommandCoordinator = new CommandCoordinator({ guard });
    }
    if (this.queueCommandCoordinator && typeof this.queueCommandCoordinator.run !== 'function') {
      throw new TypeError('V3ApiRouter queueCommandCoordinator must expose run(context, operation).');
    }
    this.pendingRequestStore = options.pendingRequestStore || null;
    this.pendingRequestCommandCoordinator = options.pendingRequestCommandCoordinator
      || options.queueCommandCoordinator
      || null;
    if (this.pendingRequestStore) {
      if (typeof this.pendingRequestStore.list !== 'function'
        || typeof this.pendingRequestStore.respond !== 'function') {
        throw new TypeError('V3ApiRouter pendingRequestStore must expose list() and respond().');
      }
      if (!this.pendingRequestCommandCoordinator) {
        const guard = options.protectedThreadGuard || options.guard;
        if (!guard || typeof guard.assertAllowed !== 'function') {
          throw new TypeError(
            'V3ApiRouter pending request responses require a command coordinator or protected thread guard.',
          );
        }
        this.pendingRequestCommandCoordinator = new CommandCoordinator({ guard });
      }
    }
    if (this.pendingRequestCommandCoordinator
      && typeof this.pendingRequestCommandCoordinator.run !== 'function') {
      throw new TypeError(
        'V3ApiRouter pendingRequestCommandCoordinator must expose run(context, operation).',
      );
    }
  }

  async handle(request = {}) {
    let url;
    try {
      url = requestUrl(request);
    } catch (error) {
      return errorResponse(error, { mutation: false });
    }
    const method = String(request.method || 'GET').toUpperCase();
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (method === 'GET' && pathname === '/codex/v3/meta') {
        return success(this.runtime.getMeta());
      }
      if (method === 'GET' && pathname === '/codex/v3/capabilities') {
        return success(this.runtime.getMeta().capabilities);
      }
      if (method === 'GET' && pathname === '/codex/v3/diagnostics') {
        return success(this.createDiagnostics());
      }
      if (method === 'GET' && pathname === '/codex/v3/catalogs/models') {
        return success(await this.invokeService('listModels', listModelParams(url.searchParams)));
      }
      if (method === 'GET' && pathname === '/codex/v3/catalogs/collaboration-modes') {
        return success(await this.invokeService('listCollaborationModes', {}));
      }
      if (method === 'POST' && (
        pathname === '/codex/v3/thread-input'
        || pathname === '/codex/thread-input'
      )) {
        const body = objectOrEmpty(request.body);
        const result = await this.handleThreadInput(body);
        if (body.mode === 'enqueue-next-turn') {
          return success({
            mode: 'enqueue-next-turn',
            state: result.state,
            threadId: result.threadId,
            clientRequestId: result.clientRequestId,
            item: result,
          }, 202);
        }
        return success(result, 200);
      }
      if (method === 'GET' && pathname === '/codex/v3/threads') {
        const result = await this.invokeService('listThreads', listThreadParams(url.searchParams));
        return success(result);
      }
      if (method === 'POST' && pathname === '/codex/v3/threads') {
        const body = objectOrEmpty(request.body);
        const result = await this.invokeService(
          'startThread',
          objectOrEmpty(body.params),
          objectOrEmpty(body.control),
        );
        const threadId = startedThreadId(result);
        if (threadId) this.locallyStartedEmptyThreads.set(threadId, this.now());
        return success(result, 201);
      }

      const eventSnapshotMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/events\/snapshot$/);
      if (method === 'GET' && eventSnapshotMatch) {
        const threadId = decodeURIComponent(eventSnapshotMatch[1]);
        return success(projectPublicEventFeed(await this.requireEventRuntime().snapshot(threadId)));
      }

      const eventCursorMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/events\/cursor$/);
      if (method === 'GET' && eventCursorMatch) {
        const threadId = decodeURIComponent(eventCursorMatch[1]);
        return success(await this.requireEventRuntime().cursor(threadId));
      }

      const eventMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/events$/);
      if (method === 'GET' && eventMatch) {
        const threadId = decodeURIComponent(eventMatch[1]);
        return success(projectPublicEventFeed(await this.requireEventRuntime().read(
          threadId,
          eventCursorParams(url.searchParams),
        )));
      }

      const protectionMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/protection$/);
      if (protectionMatch && (method === 'GET' || method === 'PUT')) {
        const threadId = decodeURIComponent(protectionMatch[1]);
        const registry = this.requireProtectionRegistry();
        if (method === 'GET') return success(registry.status(threadId));
        const body = objectOrEmpty(request.body);
        if (typeof body.protected !== 'boolean') {
          throw new ApiRouteError(
            'PROTECTION_VALUE_REQUIRED',
            'A boolean protected value is required.',
            400,
          );
        }
        const options = Object.hasOwn(body, 'expectedRevision')
          ? { expectedRevision: body.expectedRevision }
          : {};
        return success(body.protected
          ? registry.protect(threadId, options)
          : registry.unprotect(threadId, options));
      }

      const pendingRequestRespondMatch = pathname.match(
        /^\/codex\/v3\/threads\/([^/]+)\/requests\/([^/]+)\/respond$/,
      );
      if (method === 'POST' && pendingRequestRespondMatch) {
        const threadId = decodeURIComponent(pendingRequestRespondMatch[1]);
        const handle = decodeURIComponent(pendingRequestRespondMatch[2]);
        const body = objectOrEmpty(request.body);
        const response = { ...body };
        delete response.control;
        const result = await this.runPendingRequestMutation(
          threadId,
          body.control,
          () => this.requirePendingRequestStore().respond(threadId, handle, response),
        );
        return success({ threadId, item: result });
      }

      const pendingRequestListMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/requests$/);
      if (method === 'GET' && pendingRequestListMatch) {
        const threadId = decodeURIComponent(pendingRequestListMatch[1]);
        const store = this.requirePendingRequestStore();
        if (typeof store.synchronize === 'function') await store.synchronize(threadId);
        return success({
          threadId,
          items: store.list(threadId),
        });
      }

      const queueReorderMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/queue\/reorder$/);
      if (method === 'POST' && queueReorderMatch) {
        const threadId = decodeURIComponent(queueReorderMatch[1]);
        const body = objectOrEmpty(request.body);
        const result = await this.runQueueMutation(
          'queue.reorder',
          threadId,
          body.control,
          () => this.requireQueue().reorder(threadId, body.orderedIds),
        );
        return success({ threadId, items: result });
      }

      const queueFlushMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/queue\/flush$/);
      if (method === 'POST' && queueFlushMatch) {
        const threadId = decodeURIComponent(queueFlushMatch[1]);
        const result = await this.flushQueue(threadId, objectOrEmpty(request.body));
        return success({ item: result });
      }

      const threadQueueMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/queue$/);
      if (threadQueueMatch) {
        const threadId = decodeURIComponent(threadQueueMatch[1]);
        if (method === 'GET') return success({ threadId, items: this.requireQueue().list(threadId) });
        if (method === 'POST') {
          const body = objectOrEmpty(request.body);
          const requestParams = {
            ...body,
            control: undefined,
            threadId,
          };
          const result = await this.runQueueMutation(
            'queue.enqueue',
            threadId,
            body.control,
            async () => this.requireQueue().enqueue({
              ...requestParams,
              attachments: this.normalizeAttachments(requestParams.attachments),
            }),
          );
          return success({ item: result }, 202);
        }
      }

      const queueRetryMatch = pathname.match(/^\/codex\/v3\/queue\/([^/]+)\/retry$/);
      if (method === 'POST' && queueRetryMatch) {
        const item = this.requireQueueItem(decodeURIComponent(queueRetryMatch[1]));
        const body = objectOrEmpty(request.body);
        const result = await this.runQueueMutation(
          'queue.retry',
          item.threadId,
          body.control,
          () => this.requireQueue().retry(item.id, { revision: body.revision }),
        );
        return success({ item: result });
      }

      const queueConvertMatch = pathname.match(/^\/codex\/v3\/queue\/([^/]+)\/convert-to-steer$/);
      if (method === 'POST' && queueConvertMatch) {
        const item = this.requireQueueItem(decodeURIComponent(queueConvertMatch[1]));
        const body = objectOrEmpty(request.body);
        const control = objectOrEmpty(body.control);
        const result = await this.runQueueMutation(
          'queue.steer',
          item.threadId,
          control,
          () => this.requireQueue().convertToSteer(item.id, {
            revision: body.revision,
            expectedTurnId: body.expectedTurnId,
            steer: async queued => {
              const inputRouter = new TurnInputRouter({
                queue: this.queue,
                // turn/steer atomically validates this exact pair. A preliminary
                // thread/read is both redundant and racy while a new rollout is
                // being materialized or a large history is still loading.
                getActiveTurn: async (targetThreadId, expectedTurnId) => ({
                  threadId: targetThreadId,
                  turnId: expectedTurnId,
                  status: 'active',
                  steerable: true,
                }),
                steer: params => this.invokeService('steerTurn', params, control),
                buildInput: request => this.buildTurnInput(request),
              });
              try {
                return await inputRouter.deliver({
                  mode: 'steer-current',
                  threadId: queued.threadId,
                  expectedTurnId: body.expectedTurnId,
                  clientRequestId: queued.clientRequestId,
                  text: queued.text,
                  attachments: queued.attachments,
                });
              } catch (error) {
                const classified = classifyCodexServiceError(error, { mutation: true });
                if (classified.uncertain && error && typeof error === 'object') error.uncertain = true;
                throw error;
              }
            },
          }),
        );
        return success({ item: result });
      }

      const queueReconcileMatch = pathname.match(/^\/codex\/v3\/queue\/([^/]+)\/reconcile$/);
      if (method === 'POST' && queueReconcileMatch) {
        const item = this.requireQueueItem(decodeURIComponent(queueReconcileMatch[1]));
        const body = objectOrEmpty(request.body);
        const evidence = { ...body, control: undefined };
        const result = await this.runQueueMutation(
          'queue.reconcile',
          item.threadId,
          body.control,
          () => this.requireQueue().reconcile(item.id, evidence),
        );
        return success({ item: result });
      }

      const queueItemMatch = pathname.match(/^\/codex\/v3\/queue\/([^/]+)$/);
      if (queueItemMatch && (method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
        const item = this.requireQueueItem(decodeURIComponent(queueItemMatch[1]));
        const body = objectOrEmpty(request.body);
        const editing = method === 'PATCH' || method === 'PUT';
        const action = editing ? 'queue.edit' : 'queue.cancel';
        const result = await this.runQueueMutation(
          action,
          item.threadId,
          body.control,
          async () => editing
            ? this.requireQueue().edit(item.id, {
              ...body,
              control: undefined,
              ...(Object.hasOwn(body, 'attachments')
                ? { attachments: this.normalizeAttachments(body.attachments) }
                : {}),
            })
            : this.requireQueue().cancel(item.id, { revision: body.revision }),
        );
        return success({ item: result });
      }

      const statusMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/status$/);
      if (method === 'GET' && statusMatch) {
        const threadId = decodeURIComponent(statusMatch[1]);
        const result = await this.invokeService('readThread', { threadId, includeTurns: true });
        return success(deriveThreadStatus(result, threadId));
      }

      const actionMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)\/actions$/);
      if (method === 'POST' && actionMatch) {
        const threadId = decodeURIComponent(actionMatch[1]);
        const body = objectOrEmpty(request.body);
        const serviceMethod = THREAD_ACTION_METHODS[String(body.action || '')];
        if (!serviceMethod) {
          throw new ApiRouteError(
            'UNKNOWN_THREAD_ACTION',
            'Unknown thread action was rejected.',
            400,
            { action: String(body.action || '') },
          );
        }
        const params = { ...objectOrEmpty(body.params), threadId };
        const result = await this.invokeService(serviceMethod, params, objectOrEmpty(body.control));
        return success(result);
      }

      const readMatch = pathname.match(/^\/codex\/v3\/threads\/([^/]+)$/);
      if (method === 'GET' && readMatch) {
        const threadId = decodeURIComponent(readMatch[1]);
        const includeTurns = parseBoolean(url.searchParams.get('includeTurns'));
        const params = { threadId };
        if (includeTurns !== undefined) params.includeTurns = includeTurns;
        const result = await this.invokeService('readThread', params);
        return success(result);
      }

      return { handled: false };
    } catch (error) {
      return errorResponse(error, { mutation: method !== 'GET' });
    }
  }

  invokeService(method, params, control) {
    return this.runtime.withService(service => {
      if (!service || typeof service[method] !== 'function') {
        throw new ApiRouteError(
          'SERVICE_OPERATION_UNAVAILABLE',
          `Codex service operation is unavailable: ${method}`,
          503,
          { method },
        );
      }
      return control === undefined
        ? service[method](params)
        : service[method](params, control);
    });
  }

  createDiagnostics() {
    const meta = objectOrEmpty(this.runtime.getMeta());
    const context = objectOrEmpty(this.diagnosticContext());
    const queueItems = this.queue && typeof this.queue.allItems === 'function'
      ? this.queue.allItems()
      : [];
    const sync = this.eventRuntime && typeof this.eventRuntime.diagnostics === 'function'
      ? objectOrEmpty(this.eventRuntime.diagnostics())
      : objectOrEmpty(context.sync);
    return createDiagnosticReport({
      ...context,
      versions: meta.versions,
      protocol: meta.protocol,
      appServer: meta.appServer,
      capabilities: meta.capabilities,
      sync,
      queue: { items: queueItems },
    }, { tokens: this.diagnosticTokens });
  }

  requireEventRuntime() {
    if (!this.eventRuntime) {
      throw new ApiRouteError(
        'EVENT_SYNC_UNAVAILABLE',
        'The read-only event synchronizer is unavailable.',
        503,
      );
    }
    return this.eventRuntime;
  }

  requireProtectionRegistry() {
    if (!this.protectionRegistry) {
      throw new ApiRouteError(
        'PROTECTION_UNAVAILABLE',
        'Task protection is unavailable.',
        503,
      );
    }
    return this.protectionRegistry;
  }

  requireQueue() {
    if (!this.queue || !this.queueCommandCoordinator) {
      throw new ApiRouteError(
        'QUEUE_UNAVAILABLE',
        'The persistent input queue is unavailable.',
        503,
      );
    }
    return this.queue;
  }

  requirePendingRequestStore() {
    if (!this.pendingRequestStore || !this.pendingRequestCommandCoordinator) {
      throw new ApiRouteError(
        'PENDING_REQUESTS_UNAVAILABLE',
        'Pending task requests are unavailable.',
        503,
      );
    }
    return this.pendingRequestStore;
  }

  requireQueueItem(id) {
    const item = this.requireQueue().get(id);
    if (!item) {
      throw new ApiRouteError(
        'QUEUE_ITEM_NOT_FOUND',
        'The queued input no longer exists.',
        404,
        { id },
      );
    }
    return item;
  }

  runQueueMutation(action, threadId, control, operation) {
    this.requireQueue();
    const context = {
      ...pickDefined(control, QUEUE_CONTROL_FIELDS),
      action,
      mode: 'queue',
      threadId: String(threadId || '').trim(),
    };
    return this.queueCommandCoordinator.run(context, operation);
  }

  runPendingRequestMutation(threadId, control, operation) {
    this.requirePendingRequestStore();
    const context = {
      ...pickDefined(control, QUEUE_CONTROL_FIELDS),
      action: 'turn.steer',
      mode: 'rpc',
      threadId: String(threadId || '').trim(),
    };
    return this.pendingRequestCommandCoordinator.run(context, operation);
  }

  normalizeAttachments(value) {
    const attachments = Array.isArray(value) ? value : [];
    if (attachments.length === 0) return [];
    const uploadRows = attachments.map(attachmentUpload);
    const requiresStore = attachments.some((attachment, index) => (
      Boolean(uploadRows[index]) || isStoredAttachmentDescriptor(attachment)
    ));
    if (requiresStore && !this.attachmentStore) {
      throw new ApiRouteError(
        'ATTACHMENT_STORE_UNAVAILABLE',
        'Attachment persistence is unavailable.',
        503,
      );
    }

    const uploads = uploadRows.filter(Boolean);
    const saved = uploads.length > 0 ? this.attachmentStore.saveBatch(uploads) : [];
    let savedIndex = 0;
    return attachments.map((attachment, index) => {
      if (!attachment || typeof attachment !== 'object') {
        throw new ApiRouteError('ATTACHMENT_INVALID', 'Attachment is invalid.');
      }
      if (uploadRows[index]) return saved[savedIndex++];
      if (isStoredAttachmentDescriptor(attachment)) {
        const metadata = this.attachmentStore.getMetadata(attachment.id);
        if (!metadata) {
          throw new ApiRouteError(
            'ATTACHMENT_NOT_FOUND',
            'Attachment is missing or expired.',
            404,
            { id: String(attachment.id || '') },
          );
        }
        return metadata;
      }
      if (containsUnnormalizedDataUrl(attachment)) {
        throw new ApiRouteError(
          'ATTACHMENT_DATA_URL_INVALID',
          'Inline attachment data must use a supported image field.',
        );
      }
      return { ...attachment };
    });
  }

  buildTurnInput(request = {}) {
    const input = queuedTurnInput(request);
    for (const attachment of Array.isArray(request.attachments) ? request.attachments : []) {
      if (!isStoredAttachmentDescriptor(attachment)) continue;
      if (!this.attachmentStore) {
        throw new ApiRouteError(
          'ATTACHMENT_STORE_UNAVAILABLE',
          'Attachment persistence is unavailable.',
          503,
        );
      }
      const stored = this.attachmentStore.read(attachment.id);
      if (!stored) {
        throw new ApiRouteError(
          'ATTACHMENT_NOT_FOUND',
          'Attachment is missing or expired.',
          404,
          { id: String(attachment.id || '') },
        );
      }
      if (!stored.metadata.mimeType.startsWith('image/')) {
        throw new ApiRouteError(
          'ATTACHMENT_INPUT_UNSUPPORTED',
          'This attachment type cannot be sent to Codex app-server.',
          400,
          { mimeType: stored.metadata.mimeType },
        );
      }
      input.push({
        type: 'image',
        url: `data:${stored.metadata.mimeType};base64,${stored.data.toString('base64')}`,
      });
    }
    return input;
  }

  async readThreadStatus(threadId, expectedTurnId = '') {
    // Pulling every turn before a steer makes guidance time out on long-lived
    // tasks. The desktop turn/steer RPC already validates expectedTurnId
    // atomically, so this preflight only needs the lightweight thread state.
    let response;
    try {
      response = await this.invokeService('readThread', { threadId, includeTurns: false });
    } catch (error) {
      // This read happens before turn/steer, so a failure is safe to retry and
      // must never be presented as an uncertain mutation.
      if (error && typeof error === 'object') error.mutationAttempted = false;
      throw error;
    }
    const status = deriveThreadStatus(response, threadId);
    const rawStatus = status.status;
    const statusType = typeof rawStatus === 'string'
      ? rawStatus.toLowerCase()
      : String(rawStatus && rawStatus.type || '').toLowerCase();
    if (!status.activeTurn && statusType === 'active' && String(expectedTurnId || '').trim()) {
      status.activeTurn = {
        threadId: status.threadId,
        turnId: String(expectedTurnId).trim(),
        status: 'active',
        steerable: true,
      };
    }
    return status;
  }

  async handleThreadInput(body) {
    this.requireQueue();
    const mode = String(body.mode || '');
    if (mode !== 'steer-current' && mode !== 'enqueue-next-turn') {
      throw new ApiRouteError(
        'DELIVERY_MODE_REQUIRED',
        'Choose steer-current or enqueue-next-turn.',
      );
    }
    const threadId = String(body.threadId || '').trim();
    const control = objectOrEmpty(body.control);
    const request = { ...body, control: undefined };
    const inputRouter = new TurnInputRouter({
      queue: this.queue,
      // The expected turn id is mandatory and turn/steer performs the only
      // authoritative, atomic active-turn check. Avoid a preflight read that
      // can fail before a fresh rollout has written its first metadata row.
      getActiveTurn: async (targetThreadId, expectedTurnId) => ({
        threadId: targetThreadId,
        turnId: expectedTurnId,
        status: 'active',
        steerable: true,
      }),
      steer: params => this.invokeService('steerTurn', params, control),
      buildInput: inputRequest => this.buildTurnInput(inputRequest),
    });
    return this.runQueueMutation(
      mode === 'steer-current' ? 'queue.steer' : 'queue.enqueue',
      threadId,
      control,
      () => inputRouter.deliver({
        ...request,
        attachments: this.normalizeAttachments(request.attachments),
      }),
    );
  }

  async flushQueue(threadId, body) {
    this.requireQueue();
    const observedItem = this.queue.list(threadId)
      .find(item => item.state === 'queued' || item.state === 'dispatching') || null;
    const startedAt = this.locallyStartedEmptyThreads.get(threadId);
    const locallyStartedEmpty = Number.isFinite(startedAt)
      && this.now() - startedAt <= NEW_THREAD_MATERIALIZATION_WINDOW_MS;
    if (!locallyStartedEmpty && startedAt !== undefined) {
      this.locallyStartedEmptyThreads.delete(threadId);
    }
    let dispatchState;
    try {
      const response = await this.invokeService('readThread', { threadId, includeTurns: true });
      dispatchState = deriveQueueDispatchState(response, threadId);
      const turns = response && response.thread && Array.isArray(response.thread.turns)
        ? response.thread.turns
        : [];
      if (turns.length > 0) this.locallyStartedEmptyThreads.delete(threadId);
      if (turns.length === 0 && locallyStartedEmpty) {
        dispatchState.threadStatus = 'idle';
        dispatchState.terminal = true;
      }
    } catch (error) {
      const classified = classifyCodexServiceError(error);
      if (!locallyStartedEmpty || classified.kind !== 'invalidRequest') throw error;
      dispatchState = { threadId, threadStatus: 'idle', terminal: true };
    }
    if (dispatchState.threadStatus !== 'idle' || dispatchState.terminal !== true) return null;
    const control = objectOrEmpty(body.control);
    const dispatched = await this.runQueueMutation('queue.dispatch', threadId, control, () => (
      this.queue.dispatchNext(threadId, {
        threadStatus: 'idle',
        startTurn: async item => {
          try {
            const started = await this.invokeService('startTurn', {
              threadId,
              input: this.buildTurnInput(item),
              clientUserMessageId: item.clientRequestId,
            }, control);
            this.locallyStartedEmptyThreads.delete(threadId);
            return {
              turnId: String(started && (
                started.turnId
                || (started.turn && started.turn.id)
                || (started.observation && started.observation.turnId)
              ) || ''),
            };
          } catch (error) {
            const classified = classifyCodexServiceError(error, { mutation: true });
            if (classified.uncertain && error && typeof error === 'object') error.uncertain = true;
            throw error;
          }
        },
      })
    ));
    if (dispatched || !observedItem) return dispatched;
    const coalesced = this.queue.get(observedItem.id);
    return coalesced && ['accepted', 'failed', 'needs_reconcile'].includes(coalesced.state)
      ? coalesced
      : null;
  }
}

module.exports = {
  ApiRouteError,
  THREAD_ACTION_METHODS,
  V3ApiRouter,
  deriveQueueDispatchState,
  deriveThreadStatus,
  errorResponse,
};
