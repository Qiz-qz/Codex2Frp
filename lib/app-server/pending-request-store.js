'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const REQUEST_KINDS = Object.freeze({
  'item/commandExecution/requestApproval': 'commandApproval',
  'item/fileChange/requestApproval': 'fileApproval',
  'item/permissions/requestApproval': 'permissionsApproval',
  'item/tool/requestUserInput': 'userInput',
  'mcpServer/elicitation/request': 'mcpElicitation',
  'item/tool/call': 'dynamicToolRequest',
});
const APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const STRUCTURED_APPROVAL_DECISIONS = Object.freeze({
  acceptWithExecpolicyAmendment: Object.freeze({
    requestField: 'proposedExecpolicyAmendment', responseField: 'execpolicy_amendment',
  }),
  applyNetworkPolicyAmendment: Object.freeze({
    requestField: 'proposedNetworkPolicyAmendments', responseField: 'network_policy_amendment',
  }),
});
const MCP_ACTIONS = new Set(['accept', 'decline', 'cancel']);
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const INTERNAL_FIELD_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_PERMISSION_KINDS = new Map([
  ['network', 'network'],
  ['filesystem', 'filesystem'],
  ['fileSystem', 'filesystem'],
  ['computerUse', 'computerUse'],
  ['microphone', 'microphone'],
  ['camera', 'camera'],
  ['fullAccess', 'fullAccess'],
]);

class PendingRequestError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'PendingRequestError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = {};
  }
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeText(value, maxLength = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeBasename(value) {
  const text = safeText(value, 4096).replaceAll('/', '\\');
  if (!text) return '';
  const name = safeText(path.win32.basename(text), 160);
  return name === '.' || name === '..' || /(?:secret|token|password|private[_-]?key)/iu.test(name) ? '' : name;
}

function safeReason(value, fallback) {
  const text = safeText(value, 500);
  if (!text) return fallback;
  const sensitive = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[^\s/]+\/)|https?:\/\/|\b(?:token|secret|password|key)\s*=|\$env:)/iu;
  return sensitive.test(text) ? fallback : text;
}

function safeActionKinds(value) {
  const allowed = new Set(['read', 'search', 'listFiles', 'write', 'delete', 'copy', 'move', 'network', 'execute']);
  return [...new Set((Array.isArray(value) ? value : []).slice(0, 32).map(action => {
    const type = safeText(action && action.type, 64);
    return allowed.has(type) ? type : 'other';
  }))];
}

function serverRequestKey(requestId, connectionEpoch, connectionSource = 'independentAppServer') {
  const type = typeof requestId;
  const epoch = Number(connectionEpoch);
  if ((type !== 'string' && type !== 'number')
    || (type === 'number' && !Number.isFinite(requestId))
    || !Number.isSafeInteger(epoch) || epoch <= 0) return '';
  const source = safeText(connectionSource, 64) || 'independentAppServer';
  return `${source}:${epoch}:${type}:${String(requestId)}`;
}

function safeInternalField(value) {
  const field = safeText(value, 256);
  return INTERNAL_FIELD_PATTERN.test(field) && !RESERVED_OBJECT_KEYS.has(field) ? field : '';
}

function assertOnlyKeys(value, allowed) {
  const object = objectOrNull(value);
  if (!object || Object.keys(object).some(key => !allowed.has(key))) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'The pending request response is invalid.',
    );
  }
  return object;
}

function approvalResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['decision']));
  const decisionObject = objectOrNull(response.decision);
  if (decisionObject) {
    if (entry.kind !== 'commandApproval' || Object.keys(decisionObject).length !== 1) {
      throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'Choose an allowed approval decision.');
    }
    const [decisionName] = Object.keys(decisionObject);
    const descriptor = STRUCTURED_APPROVAL_DECISIONS[decisionName];
    const body = objectOrNull(decisionObject[decisionName]);
    if (!descriptor || !body || Object.keys(body).length !== 1
      || !Object.hasOwn(body, descriptor.responseField)
      || entry.amendments[decisionName] === undefined
      || !isDeepStrictEqual(body[descriptor.responseField], entry.amendments[decisionName])) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'The approval amendment does not match this request.',
      );
    }
    return { decision: copy(decisionObject) };
  }
  const decision = typeof response.decision === 'string' ? response.decision : '';
  if (!APPROVAL_DECISIONS.has(decision)) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'Choose an allowed approval decision.',
    );
  }
  if (entry.kind !== 'permissionsApproval') return { decision };
  if (decision === 'decline' || decision === 'cancel') return { permissions: {}, scope: 'turn' };
  return {
    permissions: copy(entry.permissions),
    scope: decision === 'acceptForSession' ? 'session' : 'turn',
  };
}

function userInputResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['answers']));
  const answers = objectOrNull(response.answers);
  if (!answers) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'User input answers are required.',
    );
  }
  const result = {};
  for (const [handle, answerValues] of Object.entries(answers)) {
    const questionId = entry.fields.get(handle);
    if (!questionId || !Array.isArray(answerValues) || answerValues.length > 8
      || answerValues.some(answer => typeof answer !== 'string' || answer.length > 4000)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'User input answers do not match this request.',
      );
    }
    result[questionId] = { answers: [...answerValues] };
  }
  return { answers: result };
}

function validMcpValue(type, value) {
  if (type === 'string') return typeof value === 'string' && value.length <= 4000;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function mcpResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['action', 'values']));
  const action = String(response.action || '');
  if (!MCP_ACTIONS.has(action)) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'Choose an allowed elicitation action.',
    );
  }
  if (action !== 'accept') {
    if (response.values !== undefined) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Declined elicitation cannot include values.',
      );
    }
    return { action };
  }
  const values = objectOrNull(response.values) || {};
  const content = {};
  for (const [handle, fieldValue] of Object.entries(values)) {
    const field = entry.fields.get(handle);
    if (!field || !validMcpValue(field.type, fieldValue)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Elicitation values do not match this request.',
      );
    }
    content[field.name] = fieldValue;
  }
  for (const field of entry.fields.values()) {
    if (field.required && !Object.hasOwn(content, field.name)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Required elicitation values are missing.',
      );
    }
  }
  return { action, content };
}

function dynamicToolResult(value) {
  const response = assertOnlyKeys(value, new Set(['contentItems', 'success']));
  if (typeof response.success !== 'boolean' || !Array.isArray(response.contentItems) || response.contentItems.length > 32) {
    throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
  }
  const contentItems = response.contentItems.map(itemValue => {
    const item = objectOrNull(itemValue);
    if (!item || (item.type !== 'inputText' && item.type !== 'inputImage')) {
      throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
    }
    const field = item.type === 'inputText' ? 'text' : 'imageUrl';
    assertOnlyKeys(item, new Set(['type', field]));
    const content = safeText(item[field], 64 * 1024);
    if (!content) throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
    return { type: item.type, [field]: content };
  });
  return { contentItems, success: response.success };
}

function cancellationResult(kind) {
  if (kind === 'dynamicToolRequest') return { contentItems: [], success: false };
  if (kind === 'mcpElicitation') return { action: 'cancel' };
  if (kind === 'userInput') return { answers: {} };
  if (kind === 'permissionsApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'cancel' };
}

function settleSilently(respond, result) {
  try {
    Promise.resolve(respond(result)).catch(() => {});
  } catch {}
}

class PendingRequestStore {
  constructor(options = {}) {
    this.maxEntries = Number.isSafeInteger(options.maxEntries)
      && options.maxEntries > 0 && options.maxEntries <= 512
      ? options.maxEntries
      : 64;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.createHandle = typeof options.createHandle === 'function'
      ? options.createHandle
      : () => crypto.randomBytes(24).toString('base64url');
    this.entries = new Map();
    this.serverRequestHandles = new Map();
    this.terminalHandles = new Map();
    this.maxTerminalEntries = Math.max(this.maxEntries, Math.min(2048, this.maxEntries * 4));
    this.synchronizer = null;
  }

  setSynchronizer(synchronizer) {
    if (synchronizer !== null && typeof synchronizer !== 'function') {
      throw new TypeError('PendingRequestStore synchronizer must be a function or null.');
    }
    this.synchronizer = synchronizer;
  }

  async synchronize(threadId) {
    if (this.synchronizer) await this.synchronizer(safeText(threadId, 256));
  }

  nowMs() {
    const value = this.now();
    const numeric = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
  }

  activeHandles() {
    const handles = new Set([...this.entries.keys(), ...this.terminalHandles.keys()]);
    for (const entry of this.entries.values()) {
      for (const handle of entry.fields.keys()) handles.add(handle);
    }
    return handles;
  }

  allocateHandle(reserved = []) {
    const active = this.activeHandles();
    for (const handle of reserved) active.add(handle);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const handle = String(this.createHandle() || '').trim();
      if (HANDLE_PATTERN.test(handle) && !active.has(handle)) return handle;
    }
    throw new PendingRequestError(
      'PENDING_REQUEST_HANDLE_UNAVAILABLE',
      'A pending request handle could not be created.',
      503,
    );
  }

  rememberTerminal(handle, state) {
    this.terminalHandles.delete(handle);
    this.terminalHandles.set(handle, state);
    while (this.terminalHandles.size > this.maxTerminalEntries) {
      this.terminalHandles.delete(this.terminalHandles.keys().next().value);
    }
  }

  removeEntry(entry, state) {
    if (!entry) return false;
    this.entries.delete(entry.handle);
    if (entry.serverRequestKey) this.serverRequestHandles.delete(entry.serverRequestKey);
    this.rememberTerminal(entry.handle, state);
    return true;
  }

  resolveServerRequest(request = {}) {
    const key = serverRequestKey(request.requestId, request.connectionEpoch, request.connectionSource);
    if (!key) return false;
    const handle = this.serverRequestHandles.get(key);
    const entry = handle ? this.entries.get(handle) : null;
    const threadId = safeText(request.threadId, 256);
    if (!entry || (threadId && entry.threadId !== threadId)) return false;
    return this.removeEntry(entry, 'resolved');
  }

  expireConnectionEpoch(connectionEpoch, connectionSource = 'independentAppServer') {
    const epoch = Number(connectionEpoch);
    if (!Number.isSafeInteger(epoch) || epoch <= 0) return 0;
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.connectionEpoch === epoch && entry.connectionSource === connectionSource
        && this.removeEntry(entry, 'expired')) removed += 1;
    }
    return removed;
  }

  capture(request = {}) {
    const method = String(request.method || '');
    const kind = REQUEST_KINDS[method];
    const params = objectOrNull(request.params);
    const threadId = safeText(params && params.threadId, 256);
    if (!kind || typeof request.respond !== 'function') return null;
    if (!params || !threadId) {
      settleSilently(request.respond, cancellationResult(kind));
      return null;
    }
    const nowMs = this.nowMs();
    if (this.entries.size >= this.maxEntries) {
      return null;
    }

    const handle = this.allocateHandle();
    const fields = new Map();
    const dto = {
      handle,
      kind,
      state: 'pending',
      title: {
        commandApproval: '命令执行请求',
        fileApproval: '文件修改请求',
        permissionsApproval: '权限请求',
        userInput: '需要你的输入',
        mcpElicitation: 'MCP 请求输入',
      }[kind],
      createdAt: new Date(nowMs).toISOString(),
    };
    const connectionSource = safeText(request.connectionSource, 64) || 'independentAppServer';
    const requestKey = serverRequestKey(request.requestId, request.connectionEpoch, connectionSource);
    const entry = {
      handle,
      kind,
      method,
      threadId,
      fields,
      respond: request.respond,
      createdAtMs: nowMs,
      requestId: request.requestId,
      connectionEpoch: Number(request.connectionEpoch) || 0,
      connectionSource,
      serverRequestKey: requestKey,
      dto,
      permissions: {},
      amendments: {},
    };

    if (kind === 'commandApproval' || kind === 'fileApproval' || kind === 'permissionsApproval') {
      dto.decisions = ['accept', 'acceptForSession'];
      if (kind === 'commandApproval') {
        for (const [decisionName, descriptor] of Object.entries(STRUCTURED_APPROVAL_DECISIONS)) {
          if (params[descriptor.requestField] === undefined) continue;
          entry.amendments[decisionName] = copy(params[descriptor.requestField]);
          dto.decisions.push(decisionName);
        }
        const actionKinds = safeActionKinds(params.commandActions);
        dto.context = {
          actionCount: Array.isArray(params.commandActions) ? Math.min(params.commandActions.length, 32) : 1,
          actionKinds: actionKinds.length ? actionKinds : ['other'],
          workingDirectoryName: safeBasename(params.cwd),
          reason: safeReason(params.reason, '需要额外授权才能执行此命令。'),
        };
      }
      if (kind === 'fileApproval') {
        dto.context = {
          fileName: safeBasename(params.path),
          grantRootName: safeBasename(params.grantRoot),
          changeCount: Array.isArray(params.changes) ? Math.min(params.changes.length, 999) : 0,
        };
      }
      dto.decisions.push('decline', 'cancel');
      if (kind === 'permissionsApproval') {
        entry.permissions = copy(objectOrNull(params.permissions) || {});
        dto.permissionKinds = [...new Set(Object.keys(entry.permissions)
          .map(key => SAFE_PERMISSION_KINDS.get(key))
          .filter(Boolean))];
        dto.reason = safeReason(params.reason, '需要额外权限。');
      }
    } else if (kind === 'userInput') {
      const questions = Array.isArray(params.questions) ? params.questions.slice(0, 3) : [];
      const seenIds = new Set();
      dto.questions = [];
      for (const question of questions) {
        const raw = objectOrNull(question);
        const id = safeInternalField(raw && raw.id);
        const prompt = safeText(raw && raw.question, 2000);
        if (!id || !prompt || seenIds.has(id)) continue;
        seenIds.add(id);
        const fieldHandle = this.allocateHandle([handle, ...fields.keys()]);
        fields.set(fieldHandle, id);
        const publicQuestion = {
          handle: fieldHandle,
          header: safeText(raw.header, 120),
          question: prompt,
          options: (Array.isArray(raw.options) ? raw.options : []).slice(0, 3).map(option => ({
            label: safeText(option && option.label, 200),
            description: safeText(option && option.description, 500),
          })).filter(option => option.label),
        };
        dto.questions.push(publicQuestion);
      }
      if (dto.questions.length === 0) {
        settleSilently(request.respond, cancellationResult(kind));
        return null;
      }
    } else if (kind === 'mcpElicitation') {
      dto.message = safeText(params.message, 2000);
      dto.actions = [...MCP_ACTIONS];
      dto.fields = [];
      const schema = objectOrNull(params.requestedSchema)
        || objectOrNull(params.schema)
        || objectOrNull(objectOrNull(params.elicitation) && params.elicitation.schema);
      const properties = objectOrNull(schema && schema.properties) || {};
      const required = new Set(Array.isArray(schema && schema.required) ? schema.required.map(String) : []);
      for (const [name, definitionValue] of Object.entries(properties).slice(0, 20)) {
        const internalName = safeInternalField(name);
        const definition = objectOrNull(definitionValue);
        const type = String(definition && definition.type || '');
        if (!internalName || !['string', 'number', 'integer', 'boolean'].includes(type)) continue;
        const fieldHandle = this.allocateHandle([handle, ...fields.keys()]);
        const field = { name: internalName, type, required: required.has(name) };
        fields.set(fieldHandle, field);
        dto.fields.push({
          handle: fieldHandle,
          title: safeText(definition.title || name, 200),
          type,
          required: field.required,
        });
      }
    }

    this.entries.set(handle, entry);
    if (requestKey) this.serverRequestHandles.set(requestKey, handle);
    return copy(dto);
  }

  list(threadId) {
    const normalized = safeText(threadId, 256);
    return [...this.entries.values()]
      .filter(entry => entry.threadId === normalized)
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map(entry => copy(entry.dto));
  }

  requireEntry(threadId, handle) {
    const entry = this.entries.get(String(handle || ''));
    if (!entry) {
      const terminal = this.terminalHandles.get(String(handle || ''));
      if (terminal === 'resolved') {
        throw new PendingRequestError(
          'PENDING_REQUEST_RESOLVED', 'The pending request was already resolved.', 409,
        );
      }
      if (terminal === 'expired') {
        throw new PendingRequestError(
          'PENDING_REQUEST_EXPIRED', 'The pending request belongs to a closed connection.', 410,
        );
      }
      throw new PendingRequestError(
        'PENDING_REQUEST_NOT_FOUND',
        'The pending request is missing or expired.',
        404,
      );
    }
    if (entry.threadId !== safeText(threadId, 256)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_THREAD_MISMATCH',
        'The pending request belongs to a different task.',
        409,
      );
    }
    return entry;
  }

  async respond(threadId, handle, value = {}) {
    const entry = this.requireEntry(threadId, handle);
    const result = entry.kind === 'userInput'
      ? userInputResult(entry, value)
      : entry.kind === 'mcpElicitation'
        ? mcpResult(entry, value)
        : entry.kind === 'dynamicToolRequest'
          ? dynamicToolResult(value)
          : approvalResult(entry, value);
    try {
      await entry.respond(result);
    } catch (error) {
      if (error && error.code === 'APP_SERVER_PROTOCOL_ERROR') {
        this.removeEntry(entry, 'resolved');
        throw new PendingRequestError(
          'PENDING_REQUEST_RESOLVED', 'The pending request was already resolved.', 409,
        );
      }
      if (error && error.code === 'APP_SERVER_CONNECTION_CLOSED') {
        this.removeEntry(entry, 'expired');
        throw new PendingRequestError(
          'PENDING_REQUEST_EXPIRED', 'The pending request belongs to a closed connection.', 410,
        );
      }
      throw new PendingRequestError(
        'PENDING_REQUEST_CONFLICT', 'The pending request could not be resolved; refresh and retry.', 409,
      );
    }
    this.removeEntry(entry, 'resolved');
    return { handle: entry.handle, kind: entry.kind, state: 'resolved' };
  }
}

module.exports = {
  PendingRequestError,
  PendingRequestStore,
  REQUEST_KINDS,
};
