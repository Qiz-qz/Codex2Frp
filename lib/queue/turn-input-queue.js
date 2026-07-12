'use strict';

const crypto = require('node:crypto');
const { QueueStore } = require('./queue-store');

const VISIBLE_QUEUE_STATES = new Set(['queued', 'dispatching', 'failed', 'needs_reconcile']);

class QueueError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = [
      'REVISION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'TURN_MISMATCH',
      'RECONCILE_EVIDENCE_MISMATCH',
      'QUEUE_ITEM_NOT_RECONCILABLE',
    ].includes(code) ? 409 : 400;
    this.details = { ...details };
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digestRequest(request) {
  const payload = {
    text: typeof request.text === 'string' ? request.text : '',
    attachments: Array.isArray(request.attachments) ? request.attachments : [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === 'string' ? value : '';
}

class TurnInputQueue {
  constructor(options = {}) {
    this.store = options.store || new QueueStore();
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.createId = typeof options.createId === 'function' ? options.createId : () => crypto.randomUUID();
    this.state = this.store.read();
    let recovered = false;
    this.state.items.forEach(item => {
      if (item.state === 'dispatching') {
        item.state = 'needs_reconcile';
        item.updatedAt = this.isoNow();
        item.revision = Number(item.revision || 0) + 1;
        recovered = true;
      }
    });
    this.recomputePositions();
    if (recovered) this.persist();
  }

  isoNow() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  persist() {
    this.store.write(this.state);
  }

  allItems(threadId = '') {
    const normalized = normalizeText(threadId).trim();
    return this.state.items.filter(item => !normalized || item.threadId === normalized);
  }

  list(threadId) {
    return this.allItems(threadId)
      .filter(item => VISIBLE_QUEUE_STATES.has(item.state))
      .sort((left, right) => Number(left.position || 0) - Number(right.position || 0))
      .map(copy);
  }

  get(id) {
    const item = this.state.items.find(candidate => candidate.id === id);
    return item ? copy(item) : null;
  }

  requireItem(id) {
    const item = this.state.items.find(candidate => candidate.id === id);
    if (!item) throw new QueueError('QUEUE_ITEM_NOT_FOUND', 'The queued input no longer exists.');
    return item;
  }

  recomputePositions(threadId = '') {
    const groups = new Map();
    this.state.items.forEach(item => {
      if (threadId && item.threadId !== threadId) return;
      if (!groups.has(item.threadId)) groups.set(item.threadId, []);
      groups.get(item.threadId).push(item);
    });
    groups.forEach(items => {
      const visible = items
        .filter(item => VISIBLE_QUEUE_STATES.has(item.state))
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0));
      visible.forEach((item, index) => { item.position = index + 1; });
      items.filter(item => !VISIBLE_QUEUE_STATES.has(item.state)).forEach(item => { item.position = null; });
    });
  }

  enqueue(request = {}) {
    const threadId = normalizeText(request.threadId).trim();
    const clientRequestId = normalizeText(request.clientRequestId).trim();
    const text = normalizeText(request.text);
    const attachments = Array.isArray(request.attachments) ? copy(request.attachments) : [];
    if (!threadId) throw new QueueError('TARGET_THREAD_REQUIRED', 'A target task is required.');
    if (!clientRequestId) throw new QueueError('CLIENT_REQUEST_ID_REQUIRED', 'A stable client request id is required.');
    if (!text.trim() && attachments.length === 0) throw new QueueError('EMPTY_INPUT', 'Queued input cannot be empty.');

    const bodyDigest = digestRequest({ text, attachments });
    const existing = this.state.items.find(item =>
      item.threadId === threadId && item.clientRequestId === clientRequestId && item.mode === 'enqueue-next-turn');
    if (existing) {
      if (existing.bodyDigest !== bodyDigest) {
        throw new QueueError('IDEMPOTENCY_CONFLICT', 'The client request id was already used for different input.');
      }
      return copy(existing);
    }

    const createdAt = this.isoNow();
    const item = {
      id: this.createId(),
      threadId,
      mode: 'enqueue-next-turn',
      text,
      attachments,
      position: this.list(threadId).length + 1,
      state: 'queued',
      clientRequestId,
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
      lastError: null,
      revision: 1,
      bodyDigest,
      turnId: null,
    };
    this.state.items.push(item);
    this.persist();
    return copy(item);
  }

  edit(id, update = {}) {
    const item = this.requireItem(id);
    if (!['queued', 'failed'].includes(item.state)) {
      throw new QueueError('QUEUE_ITEM_NOT_EDITABLE', 'Only queued or failed input can be edited.');
    }
    this.assertRevision(item, update.revision);
    const text = Object.hasOwn(update, 'text') ? normalizeText(update.text) : item.text;
    const attachments = Object.hasOwn(update, 'attachments')
      ? (Array.isArray(update.attachments) ? copy(update.attachments) : [])
      : item.attachments;
    if (!text.trim() && attachments.length === 0) throw new QueueError('EMPTY_INPUT', 'Queued input cannot be empty.');
    item.text = text;
    item.attachments = attachments;
    item.bodyDigest = digestRequest({ text, attachments });
    item.state = 'queued';
    item.lastError = null;
    item.revision += 1;
    item.updatedAt = this.isoNow();
    this.persist();
    return copy(item);
  }

  reorder(threadId, orderedIds) {
    const current = this.list(threadId).filter(item => item.state === 'queued');
    const requested = Array.isArray(orderedIds) ? orderedIds.map(String) : [];
    const currentIds = current.map(item => item.id).sort();
    if (requested.length !== current.length || requested.slice().sort().some((id, index) => id !== currentIds[index])) {
      throw new QueueError('INVALID_QUEUE_ORDER', 'Queue order must contain each editable queued item exactly once.');
    }
    requested.forEach((id, index) => {
      const item = this.requireItem(id);
      item.position = index + 1;
      item.revision += 1;
      item.updatedAt = this.isoNow();
    });
    this.persist();
    return this.list(threadId);
  }

  cancel(id, options = {}) {
    const item = this.requireItem(id);
    this.assertRevision(item, options.revision);
    if (!VISIBLE_QUEUE_STATES.has(item.state)) {
      throw new QueueError('QUEUE_ITEM_NOT_CANCELLABLE', 'The queued input can no longer be cancelled.');
    }
    item.state = 'cancelled';
    item.position = null;
    item.revision += 1;
    item.updatedAt = this.isoNow();
    this.recomputePositions(item.threadId);
    this.persist();
    return copy(item);
  }

  retry(id, options = {}) {
    const item = this.requireItem(id);
    this.assertRevision(item, options.revision);
    if (item.state !== 'failed') throw new QueueError('QUEUE_ITEM_NOT_RETRYABLE', 'Only failed input can be retried.');
    item.state = 'queued';
    item.lastError = null;
    item.revision += 1;
    item.updatedAt = this.isoNow();
    this.recomputePositions(item.threadId);
    this.persist();
    return copy(item);
  }

  async convertToSteer(id, options = {}) {
    const item = this.requireItem(id);
    if (!['queued', 'failed'].includes(item.state)) {
      throw new QueueError('QUEUE_ITEM_NOT_CONVERTIBLE', 'Only queued or failed input can be converted to guidance.');
    }
    this.assertRevision(item, options.revision);
    const expectedTurnId = normalizeText(options.expectedTurnId).trim();
    if (!expectedTurnId) throw new QueueError('EXPECTED_TURN_REQUIRED', 'Steering requires the active turn id.');
    if (typeof options.steer !== 'function') throw new TypeError('convertToSteer requires steer.');

    item.state = 'dispatching';
    item.attempt = Number(item.attempt || 0) + 1;
    item.revision += 1;
    item.updatedAt = this.isoNow();
    this.persist();
    try {
      const response = await options.steer(copy(item));
      item.state = 'cancelled';
      item.position = null;
      item.turnId = String(response && response.turnId || expectedTurnId);
      item.lastError = null;
      item.revision += 1;
      item.updatedAt = this.isoNow();
      this.recomputePositions(item.threadId);
      this.persist();
      return copy(item);
    } catch (error) {
      item.state = error && error.uncertain === true ? 'needs_reconcile' : 'failed';
      item.lastError = {
        code: typeof error?.code === 'string' ? error.code : 'STEER_CONVERSION_FAILED',
        message: typeof error?.message === 'string' ? error.message : 'Guidance conversion failed.',
      };
      item.revision += 1;
      item.updatedAt = this.isoNow();
      this.recomputePositions(item.threadId);
      this.persist();
      throw error;
    }
  }

  reconcile(id, evidence = {}) {
    const item = this.requireItem(id);
    if (item.state !== 'needs_reconcile') {
      throw new QueueError(
        'QUEUE_ITEM_NOT_RECONCILABLE',
        'Only uncertain delivery can be reconciled.',
      );
    }
    const outcome = normalizeText(evidence.outcome).trim();
    if (outcome === 'accepted') {
      const clientUserMessageId = normalizeText(evidence.clientUserMessageId).trim();
      const turnId = normalizeText(evidence.turnId).trim();
      if (!clientUserMessageId || !turnId) {
        throw new QueueError(
          'RECONCILE_EVIDENCE_REQUIRED',
          'Accepted delivery requires matching client message and turn evidence.',
        );
      }
      if (clientUserMessageId !== item.clientRequestId) {
        throw new QueueError(
          'RECONCILE_EVIDENCE_MISMATCH',
          'Delivery evidence does not match the queued request.',
          { expectedClientUserMessageId: item.clientRequestId },
        );
      }
      item.state = 'accepted';
      item.turnId = turnId;
      item.lastError = null;
    } else if (outcome === 'notAccepted') {
      item.state = 'failed';
      item.lastError = {
        code: 'DELIVERY_NOT_ACCEPTED',
        message: 'Reconciliation confirmed that the queued input was not accepted.',
      };
    } else {
      throw new QueueError(
        'RECONCILE_EVIDENCE_REQUIRED',
        'Reconciliation requires accepted or notAccepted evidence.',
      );
    }
    item.revision += 1;
    item.updatedAt = this.isoNow();
    this.recomputePositions(item.threadId);
    this.persist();
    return copy(item);
  }

  assertRevision(item, revision) {
    if (!Number.isInteger(revision) || revision !== item.revision) {
      throw new QueueError('REVISION_CONFLICT', 'The queue item changed on another client.', {
        expectedRevision: item.revision,
      });
    }
  }

  async dispatchNext(threadId, options = {}) {
    if (options.threadStatus !== 'idle') return null;
    if (typeof options.startTurn !== 'function') throw new TypeError('dispatchNext requires startTurn.');
    const item = this.list(threadId).find(candidate => candidate.state === 'queued');
    if (!item) return null;
    const mutable = this.requireItem(item.id);
    mutable.state = 'dispatching';
    mutable.attempt = Number(mutable.attempt || 0) + 1;
    mutable.revision += 1;
    mutable.updatedAt = this.isoNow();
    this.persist();

    try {
      const response = await options.startTurn(copy(mutable));
      mutable.state = 'accepted';
      mutable.turnId = response && typeof response.turnId === 'string' ? response.turnId : null;
      mutable.lastError = null;
      mutable.revision += 1;
      mutable.updatedAt = this.isoNow();
      this.recomputePositions(threadId);
      this.persist();
      return copy(mutable);
    } catch (error) {
      mutable.state = error && error.uncertain === true ? 'needs_reconcile' : 'failed';
      mutable.lastError = {
        code: typeof error?.code === 'string' ? error.code : 'DISPATCH_FAILED',
        message: typeof error?.message === 'string' ? error.message : 'Queue dispatch failed.',
      };
      mutable.revision += 1;
      mutable.updatedAt = this.isoNow();
      this.recomputePositions(threadId);
      this.persist();
      throw error;
    }
  }

  _setStateForTest(id, state) {
    const item = this.requireItem(id);
    item.state = state;
    item.updatedAt = this.isoNow();
    item.revision += 1;
    this.recomputePositions(item.threadId);
    this.persist();
  }
}

class TurnInputRouter {
  constructor(options = {}) {
    if (!options.queue) throw new TypeError('TurnInputRouter requires a queue.');
    if (typeof options.getActiveTurn !== 'function') throw new TypeError('TurnInputRouter requires getActiveTurn.');
    if (typeof options.steer !== 'function') throw new TypeError('TurnInputRouter requires steer.');
    this.queue = options.queue;
    this.getActiveTurn = options.getActiveTurn;
    this.steer = options.steer;
    this.buildInput = typeof options.buildInput === 'function'
      ? options.buildInput
      : request => [{ type: 'text', text: normalizeText(request.text) }];
  }

  async deliver(request = {}) {
    if (request.mode === 'enqueue-next-turn') {
      return this.queue.enqueue(request);
    }
    if (request.mode !== 'steer-current') {
      throw new QueueError('DELIVERY_MODE_REQUIRED', 'Choose steer-current or enqueue-next-turn.');
    }
    const threadId = normalizeText(request.threadId).trim();
    const expectedTurnId = normalizeText(request.expectedTurnId).trim();
    if (!threadId) throw new QueueError('TARGET_THREAD_REQUIRED', 'A target task is required.');
    if (!expectedTurnId) throw new QueueError('EXPECTED_TURN_REQUIRED', 'Steering requires the active turn id.');
    const active = await this.getActiveTurn(threadId);
    if (!active || active.status !== 'active') {
      throw new QueueError('TURN_NOT_ACTIVE', 'The task is no longer running.', { suggestedMode: 'enqueue-next-turn' });
    }
    if (active.threadId !== threadId || active.turnId !== expectedTurnId) {
      throw new QueueError('TURN_MISMATCH', 'The active turn changed before guidance was applied.', {
        suggestedMode: 'enqueue-next-turn',
      });
    }
    if (active.steerable === false) {
      throw new QueueError('ACTIVE_TURN_NOT_STEERABLE', 'This active operation cannot accept same-turn guidance.', {
        suggestedMode: 'enqueue-next-turn',
      });
    }
    const input = await this.buildInput(request);
    if (!Array.isArray(input) || input.length === 0) {
      throw new QueueError('EMPTY_INPUT', 'Guidance input cannot be empty.');
    }
    const response = await this.steer({
      threadId,
      expectedTurnId,
      input,
      clientUserMessageId: normalizeText(request.clientRequestId).trim() || null,
    });
    return {
      mode: 'steer-current',
      state: 'applied',
      threadId,
      turnId: response?.turnId || expectedTurnId,
      clientRequestId: normalizeText(request.clientRequestId).trim(),
    };
  }
}

module.exports = {
  QueueError,
  TurnInputQueue,
  TurnInputRouter,
  digestRequest,
};
