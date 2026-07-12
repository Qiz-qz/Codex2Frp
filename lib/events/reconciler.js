'use strict';

const crypto = require('node:crypto');
const { EventFeed } = require('./event-feed');
const { createSessionNormalizer } = require('./session-normalizer');
const { safePublicType } = require('./desktop-activity-classifier');

const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'interrupted']);
const PUBLIC_AGENT_PHASES = new Set(['commentary', 'planning', 'plan', 'final_answer']);
const MAX_INCREMENTAL_ITEMS = 256;
const MAX_INCREMENTAL_TEXT_LENGTH = 64 * 1024;
const DELEGATED_NOTIFICATION_METHODS = new Set([
  'item/started', 'item/completed', 'turn/started', 'turn/completed',
]);
const PRIVACY_IGNORED_NOTIFICATION_METHODS = new Set([
  'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
  'command/exec/outputDelta', 'process/outputDelta', 'process/exited',
  'item/mcpToolCall/progress', 'item/mcpToolCall/result', 'rawResponseItem/completed',
  'serverRequest/resolved', 'thread/status/changed', 'thread/started', 'thread/archived',
  'thread/deleted', 'thread/unarchived', 'thread/closed', 'thread/name/updated',
  'thread/goal/updated', 'thread/goal/cleared', 'thread/settings/updated', 'thread/tokenUsage/updated',
  'skills/changed', 'hook/started', 'hook/completed', 'account/updated', 'account/rateLimits/updated',
  'app/list/updated', 'remoteControl/status/changed', 'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed', 'fs/changed', 'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated', 'model/rerouted', 'model/verification', 'turn/moderationMetadata',
  'model/safetyBuffering/updated', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
  'windows/worldWritableWarning', 'windowsSandbox/setupCompleted', 'account/login/completed',
]);

function notificationTimestamp(notification = {}) {
  const params = notification.params || {};
  const timestampMs = Number(params.completedAtMs || params.startedAtMs || 0);
  return String(notification.timestamp || params.timestamp ||
    (Number.isFinite(timestampMs) && timestampMs > 0 ? new Date(timestampMs).toISOString() : ''));
}

function notificationTurnId(notification = {}, fallbackTurnId = '') {
  const params = notification.params || {};
  const turn = params.turn && typeof params.turn === 'object' ? params.turn : {};
  return String(turn.id || params.turnId || fallbackTurnId || '').trim();
}

function notificationItemId(notification = {}) {
  const params = notification.params || {};
  const item = params.item && typeof params.item === 'object' ? params.item : {};
  return String(params.itemId || item.id || '').trim();
}

function publicAgentPhase(value) {
  const phase = String(value || '').trim().toLowerCase();
  return PUBLIC_AGENT_PHASES.has(phase) ? phase : '';
}

function safePlanText(params = {}) {
  const parts = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  };
  add(params.explanation);
  add(params.text);
  add(params.planText);
  if (typeof params.plan === 'string') add(params.plan);
  const plan = Array.isArray(params.plan)
    ? params.plan
    : params.plan && typeof params.plan === 'object' && Array.isArray(params.plan.plan)
      ? params.plan.plan
      : [];
  if (params.plan && typeof params.plan === 'object' && !Array.isArray(params.plan)) {
    add(params.plan.explanation);
  }
  for (const entry of plan) {
    if (typeof entry === 'string') add(entry);
    else if (entry && typeof entry === 'object') add(entry.step || entry.text || entry.title);
  }
  return [...new Set(parts)].join('\n').slice(0, MAX_INCREMENTAL_TEXT_LENGTH);
}

function turnStatusValue(turn = {}) {
  if (turn.status && typeof turn.status === 'object') return String(turn.status.type || '');
  return String(turn.status || '');
}

function completedTaskKind(turn) {
  const status = turnStatusValue(turn).toLowerCase();
  if (status.includes('interrupt') || status.includes('cancel')) return 'task_interrupted';
  if (status.includes('fail') || status.includes('error')) return 'task_failed';
  return 'task_complete';
}

function rpcNotificationToRollout(notification = {}) {
  const params = notification.params || {};
  const timestamp = notificationTimestamp(notification);
  const turn = params.turn || {};
  const turnId = String(turn.id || params.turnId || '');
  if (notification.method === 'turn/started' && turnId) {
    return { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: turnId } };
  }
  if (notification.method === 'turn/completed' && turnId) {
    return {
      type: 'event_msg',
      timestamp,
      payload: { type: completedTaskKind(turn), turn_id: turnId },
    };
  }
  if (!['item/started', 'item/completed'].includes(notification.method)
    || !params.item || typeof params.item !== 'object') return null;

  const item = params.item;
  const itemType = String(item.type || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const rawItemStatus = [item.status && typeof item.status === 'object' ? item.status.type : item.status,
    item.decision, item.action, item.outcome].map(value => String(value || '').toLowerCase()).join(' ');
  const lifecycleState = notification.method === 'item/started'
    ? 'running'
    : rawItemStatus.includes('fail') || rawItemStatus.includes('error') || item.success === false
      ? 'failed'
      : rawItemStatus.includes('cancel') || rawItemStatus.includes('interrupt') || rawItemStatus.includes('declin')
        || rawItemStatus.includes('denied') || rawItemStatus.includes('reject') || rawItemStatus.includes('abort')
        || rawItemStatus.includes('timeout') || rawItemStatus.includes('timedout')
        ? 'cancelled'
        : 'succeeded';
  if (itemType === 'collabagenttoolcall') {
    const receiverIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    const receiverId = String(receiverIds[0] || '');
    const isCompletedClose = String(item.tool || '').toLowerCase() === 'closeagent'
      && notification.method === 'item/completed'
      && String(item.status || '').toLowerCase() === 'completed';
    if (!isCompletedClose || !receiverId) return null;
    return {
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'sub_agent_activity',
        kind: 'closed',
        agentThreadId: receiverId,
        id: item.id,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    };
  }
  if (itemType === 'subagentactivity') {
    return {
      type: 'event_msg',
      timestamp,
      payload: {
        ...item,
        type: 'sub_agent_activity',
        kind: notification.method === 'item/started' ? 'started' : item.kind,
      },
    };
  }
  if (itemType === 'agentmessage' || itemType === 'usermessage') {
    const role = itemType === 'agentmessage' ? 'assistant' : 'user';
    const text = String(item.text || item.message || '');
    return {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        id: item.id,
        role,
        ...(role === 'assistant' ? { phase: item.phase || 'commentary' } : {}),
        content: role === 'user' && Array.isArray(item.content)
          ? item.content
          : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    };
  }
  if (itemType === 'reasoning') {
    return {
      type: 'response_item',
      timestamp,
      payload: {
        ...item,
        type: 'reasoning',
        lifecycle_state: lifecycleState,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    };
  }
  if (itemType === 'plan') {
    return {
      type: 'response_item',
      timestamp,
      payload: {
        ...item,
        type: 'plan',
        lifecycle_state: lifecycleState,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    };
  }
  return {
    type: 'response_item',
    timestamp,
    payload: {
      ...item,
      ...(itemType === 'contextcompaction' ? { id: `context-compaction:${turnId}` } : {}),
      app_server_item: true,
      lifecycle_state: lifecycleState,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function rawTurnDescriptor(item = {}) {
  if (item.type !== 'event_msg' || !item.payload) return null;
  const kind = item.payload.type;
  const state = kind === 'task_started'
    ? 'started'
    : kind === 'task_complete'
      ? 'completed'
      : kind === 'task_failed'
        ? 'failed'
        : kind === 'task_interrupted'
          ? 'interrupted'
          : '';
  const turnId = String(item.payload.turn_id || '');
  return state && turnId ? { turnId, state } : null;
}

function safeEventKey(event) {
  if (event.type === 'turn') {
    return JSON.stringify({ type: 'turn', turnId: event.turnId, state: event.state });
  }
  if (event.type === 'message') {
    return JSON.stringify({
      type: 'message',
      role: event.role,
      phase: event.phase || '',
      turnId: event.turnId || '',
      text: event.text || '',
    });
  }
  if (event.summaryKind === 'subagent') {
    return JSON.stringify({
      type: 'summary',
      summaryKind: 'subagent',
      turnId: event.turnId || '',
      name: event.subagent && event.subagent.name,
      status: event.subagent && event.subagent.status,
    });
  }
  if (event.summaryKind === 'reasoning' && event.turnId) {
    return JSON.stringify({
      type: 'summary',
      summaryKind: 'reasoning',
      turnId: event.turnId,
    });
  }
  return JSON.stringify({
    type: event.type,
    summaryKind: event.summaryKind || '',
    toolKind: event.toolKind || '',
    turnId: event.turnId || '',
    state: event.state || '',
    count: Number.isFinite(event.count) ? event.count : null,
    text: event.text || '',
    body: event.body || '',
    time: event.time || '',
  });
}

function eventIdFor(event) {
  if (event.sourceKey) {
    return crypto.createHash('sha256').update(JSON.stringify({
      sourceKey: event.sourceKey,
      turnId: event.role === 'user' ? '' : event.turnId || '',
      type: event.type,
      summaryKind: event.summaryKind || '',
    })).digest('hex');
  }
  return crypto.createHash('sha256').update(safeEventKey(event)).digest('hex');
}

function safePlanMetadata(params = {}) {
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const step of Array.isArray(params.plan) ? params.plan : []) {
    const status = String(step && step.status || '');
    const key = status === 'in_progress' || status === 'inProgress' ? 'inProgress' : status;
    if (Object.hasOwn(counts, key)) counts[key] += 1;
  }
  return { stepCounts: counts, hasExplanation: typeof params.explanation === 'string' && params.explanation.trim().length > 0 };
}

function safeDiffMetadata(diffValue) {
  const diff = typeof diffValue === 'string' ? diffValue : '';
  const sections = diff.split(/^diff --git /m).slice(1);
  const fileCounts = { total: sections.length, added: 0, deleted: 0, modified: 0 };
  for (const section of sections) {
    if (/^new file mode /m.test(section)) fileCounts.added += 1;
    else if (/^deleted file mode /m.test(section)) fileCounts.deleted += 1;
    else fileCounts.modified += 1;
  }
  return { fileCounts };
}

function mergeAttachmentRows(previous = [], incoming = []) {
  const result = previous.map(item => ({ ...item }));
  const keys = new Set(result.map(item => item.filePath || item.url || item.name));
  for (const item of incoming) {
    const key = item.filePath || item.url || item.name;
    if (!key || keys.has(key)) continue;
    keys.add(key);
    result.push({ ...item });
  }
  return result.slice(0, 20);
}

function orderFor(item, fallback) {
  const stableOrder = Number(item && item._stableOrder);
  if (Number.isFinite(stableOrder)) return stableOrder;
  const timestamp = Date.parse(item && item.timestamp || '');
  return Number.isFinite(timestamp) ? timestamp : Number(fallback) || 0;
}

function normalizeRehydrateInput(value) {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value && value.entries)
      ? value.entries
      : Array.isArray(value && value.items)
        ? value.items
        : [];
  return rows.map((row, index) => row && Object.hasOwn(row, 'item')
    ? row
    : { item: row, offset: index, nextOffset: index + 1 });
}

class EventReconciler {
  constructor(options = {}) {
    this.serverInstanceId = String(options.serverInstanceId || '').trim();
    if (!this.serverInstanceId) throw new TypeError('EventReconciler requires serverInstanceId.');
    this.session = options.session || {};
    this.fullRehydrate = typeof options.fullRehydrate === 'function' ? options.fullRehydrate : null;
    this.feed = options.feed || new EventFeed({ serverInstanceId: this.serverInstanceId });
    this.lastRpcSequence = 0;
    this.resetNormalizationState();
  }

  resetNormalizationState() {
    this.normalizer = createSessionNormalizer({ session: this.session });
    this.seenEventIds = new Set();
    this.userAttachmentsByEventId = new Map();
    this.turnStates = new Map();
    this.incrementalItems = new Map();
    this.agentMessagePhases = new Map();
    this.notificationOrdinal = 0;
  }

  currentTurnId() {
    const entries = [...this.turnStates.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [turnId, state] = entries[index];
      if (!TERMINAL_TURN_STATES.has(state)) return turnId;
    }
    return '';
  }

  appendIncrementalText(key, delta, order) {
    if (typeof delta !== 'string' || delta.length === 0) return null;
    const existing = this.incrementalItems.get(key);
    const value = {
      text: `${existing ? existing.text : ''}${delta}`.slice(0, MAX_INCREMENTAL_TEXT_LENGTH),
      order: existing ? existing.order : Number(order) || 0,
    };
    this.incrementalItems.set(key, value);
    while (this.incrementalItems.size > MAX_INCREMENTAL_ITEMS) {
      this.incrementalItems.delete(this.incrementalItems.keys().next().value);
    }
    return value;
  }

  incrementalRollout(notification, sequence) {
    const method = String(notification.method || '');
    const params = notification.params || {};
    const timestamp = notificationTimestamp(notification);
    const fallbackTurnId = this.currentTurnId();
    const explicitTurnId = notificationTurnId(notification);
    const turnId = explicitTurnId || fallbackTurnId;
    const itemId = notificationItemId(notification);
    const order = Number.isFinite(Number(sequence)) ? Number(sequence) : ++this.notificationOrdinal;
    const metadata = { turn_id: turnId };

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta'
      || method === 'item/agentMessage/delta') {
      if (!explicitTurnId || !itemId) return null;
      let phase = '';
      if (method === 'item/agentMessage/delta') {
        phase = publicAgentPhase(params.phase || (params.item && params.item.phase))
          || this.agentMessagePhases.get(`${turnId}:${itemId}`) || '';
        if (!phase) return null;
      }
      const kind = method === 'item/reasoning/summaryTextDelta'
        ? 'reasoning'
        : method === 'item/plan/delta' ? 'plan' : `agent-message:${phase}`;
      const sourceKey = `rpc-delta:${kind}:${turnId}:${itemId}`;
      const accumulated = this.appendIncrementalText(sourceKey, params.delta, order);
      if (!accumulated) return null;
      if (kind === 'reasoning') {
        return {
          type: 'response_item', timestamp, _eventSourceKey: sourceKey, _stableOrder: accumulated.order,
          payload: {
            type: 'reasoning', id: sourceKey, lifecycle_state: 'running',
            summary: [{ type: 'summary_text', text: accumulated.text }],
            internal_chat_message_metadata_passthrough: metadata,
          },
        };
      }
      if (kind === 'plan') {
        return {
          type: 'response_item', timestamp, _eventSourceKey: sourceKey, _stableOrder: accumulated.order,
          payload: {
            type: 'plan', id: sourceKey, lifecycle_state: 'running', text: accumulated.text,
            internal_chat_message_metadata_passthrough: metadata,
          },
        };
      }
      return {
        type: 'response_item', timestamp, _eventSourceKey: sourceKey, _stableOrder: accumulated.order,
        payload: {
          type: 'message', id: itemId, role: 'assistant', phase,
          content: [{ type: 'output_text', text: accumulated.text }],
          internal_chat_message_metadata_passthrough: metadata,
        },
      };
    }

    if (method === 'turn/plan/updated') {
      if (!turnId) return null;
      const sourceKey = `turn-plan:${turnId}`;
      return {
        type: 'response_item', timestamp, _eventSourceKey: sourceKey,
        payload: {
          type: 'plan', id: sourceKey, lifecycle_state: 'running',
          ...safePlanMetadata(params),
          internal_chat_message_metadata_passthrough: metadata,
        },
      };
    }

    if (method === 'turn/diff/updated') {
      if (!turnId) return null;
      const sourceKey = `turn-diff:${turnId}`;
      return { type: 'response_item', timestamp, _eventSourceKey: sourceKey, payload: {
        type: 'turnDiff', id: sourceKey, lifecycle_state: 'running', ...safeDiffMetadata(params.diff),
        internal_chat_message_metadata_passthrough: metadata,
      } };
    }

    if (method === 'thread/compacted' || method === 'contextCompaction') {
      if (!turnId) return null;
      const sourceKey = `context-compaction:${turnId}`;
      return {
        type: 'response_item', timestamp, _eventSourceKey: sourceKey,
        payload: {
          type: 'contextCompaction', id: sourceKey, lifecycle_state: 'succeeded',
          internal_chat_message_metadata_passthrough: metadata,
        },
      };
    }

    if (method === 'error' || ['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(method)) {
      if (!turnId) return null;
      const sourceKey = `rpc-${method}:${turnId}`;
      if (method === 'error') {
        return {
          type: 'response_item', timestamp, _eventSourceKey: sourceKey,
          payload: {
            type: 'error', id: sourceKey, message: 'Codex reported an error.',
            willRetry: params.willRetry === true,
            internal_chat_message_metadata_passthrough: metadata,
          },
        };
      }
      return { type: 'response_item', timestamp, _eventSourceKey: sourceKey, payload: {
        type: 'notice', id: sourceKey, noticeKind: method, lifecycle_state: 'succeeded',
        internal_chat_message_metadata_passthrough: metadata,
      } };
    }

    if (DELEGATED_NOTIFICATION_METHODS.has(method) || PRIVACY_IGNORED_NOTIFICATION_METHODS.has(method)) return null;
    const safeMethod = safePublicType(method);
    const sourceKey = `rpc-unknown:${safeMethod}:${turnId || 'unscoped'}:${itemId || ''}`;
    return { type: 'response_item', timestamp, _eventSourceKey: sourceKey, payload: {
      type: 'unknown', id: itemId || sourceKey, publicType: safeMethod, lifecycle_state: 'unknown',
      internal_chat_message_metadata_passthrough: metadata,
    } };
  }

  isStaleTurn(item) {
    const descriptor = rawTurnDescriptor(item);
    if (!descriptor) return false;
    const existing = this.turnStates.get(descriptor.turnId);
    return TERMINAL_TURN_STATES.has(existing) && existing !== descriptor.state;
  }

  normalizeRows(entries, source) {
    const ordered = (Array.isArray(entries) ? entries : [])
      .filter(entry => entry && entry.item && typeof entry.item === 'object')
      .slice()
      .sort((left, right) => orderFor(left.item, left.nextOffset) - orderFor(right.item, right.nextOffset));
    const rows = [];
    for (const entry of ordered) {
      if (this.isStaleTurn(entry.item)) continue;
      const normalized = this.normalizer.normalize(entry.item);
      if (!normalized) continue;
      const internalSourceKey = String(entry.item._eventSourceKey || '').trim();
      const eventId = eventIdFor(internalSourceKey ? { ...normalized, sourceKey: internalSourceKey } : normalized);
      const { sourceKey: _sourceKey, ...publicEventValue } = normalized;
      let publicEvent = publicEventValue;
      if (normalized.type === 'message' && normalized.role === 'user') {
        const attachments = mergeAttachmentRows(
          this.userAttachmentsByEventId.get(eventId),
          normalized.attachments,
        );
        this.userAttachmentsByEventId.set(eventId, attachments);
        while (this.userAttachmentsByEventId.size > MAX_INCREMENTAL_ITEMS) {
          this.userAttachmentsByEventId.delete(this.userAttachmentsByEventId.keys().next().value);
        }
        if (attachments.length) publicEvent = { ...publicEvent, attachments };
      }
      const transientUpdate = normalized.type === 'summary'
        && normalized.summaryKind === 'reasoning'
        && Boolean(normalized.turnId);
      const lifecycleUpdate = Boolean(normalized.sourceKey || internalSourceKey);
      if (this.seenEventIds.has(eventId) && !transientUpdate && !lifecycleUpdate) continue;
      if (normalized.type === 'turn' && normalized.turnId) {
        const existing = this.turnStates.get(normalized.turnId);
        if (TERMINAL_TURN_STATES.has(existing) && existing !== normalized.state) continue;
        this.turnStates.set(normalized.turnId, normalized.state);
      }
      this.seenEventIds.add(eventId);
      rows.push({
        ...publicEvent,
        eventId,
        order: orderFor(entry.item, entry.nextOffset),
        source,
      });
    }
    return rows;
  }

  ingestFileEntries(entries) {
    return this.feed.publish(this.normalizeRows(entries, 'file'));
  }

  rehydrate(input) {
    this.resetNormalizationState();
    const rows = this.normalizeRows(normalizeRehydrateInput(input), 'rehydrate');
    return this.feed.replaceSnapshot(rows);
  }

  async ingestRpcNotification(notification = {}) {
    const sequence = Number(notification.sequence);
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      if (this.lastRpcSequence > 0 && sequence <= this.lastRpcSequence) {
        return { accepted: [], duplicate: true, rehydrated: false };
      }
      if (this.lastRpcSequence > 0 && sequence > this.lastRpcSequence + 1) {
        const details = {
          serverInstanceId: this.serverInstanceId,
          expectedSequence: this.lastRpcSequence + 1,
          receivedSequence: sequence,
        };
        if (!this.fullRehydrate) {
          return { accepted: [], duplicate: false, rehydrated: false, rehydrateRequired: true, details };
        }
        const input = await this.fullRehydrate(details);
        this.lastRpcSequence = sequence;
        const snapshot = this.rehydrate(input);
        return { accepted: [], duplicate: false, rehydrated: true, snapshot };
      }
      this.lastRpcSequence = sequence;
    }

    if (this.session.isSubagent === true) {
      return { accepted: [], duplicate: false, rehydrated: false };
    }
    const params = notification.params || {};
    if (['item/started', 'item/completed'].includes(notification.method)
      && params.item && typeof params.item === 'object') {
      const itemType = String(params.item.type || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const turnId = notificationTurnId(notification);
      const itemId = notificationItemId(notification);
      const phase = publicAgentPhase(params.item.phase);
      if (itemType === 'agentmessage' && turnId && itemId && phase) {
        this.agentMessagePhases.set(`${turnId}:${itemId}`, phase);
      }
    }
    const item = this.incrementalRollout(notification, sequence) || rpcNotificationToRollout(notification);
    if (!item) return { accepted: [], duplicate: false, rehydrated: false };
    const rows = this.normalizeRows([{
      item,
      offset: sequence,
      nextOffset: sequence,
    }], 'rpc');
    return {
      accepted: this.feed.publish(rows),
      duplicate: false,
      rehydrated: false,
    };
  }

  turnSnapshot() {
    return [...this.turnStates.entries()]
      .map(([turnId, state]) => ({ turnId, state }))
      .sort((left, right) => left.turnId.localeCompare(right.turnId));
  }

  snapshot() {
    return { ...this.feed.snapshot(), turns: this.turnSnapshot() };
  }

  read(request) {
    return { ...this.feed.read(request), turns: this.turnSnapshot() };
  }
}

module.exports = {
  EventReconciler,
};
