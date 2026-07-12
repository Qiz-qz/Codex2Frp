'use strict';

const READ_ACTIONS = new Set([
  'thread.list',
  'thread.read',
  'thread.turns.list',
  'thread.status',
  'history.read',
  'status.read',
  'model.list',
  'capabilities.read',
  'queue.list',
]);

const MUTATION_ACTIONS = new Set([
  'thread.start',
  'thread.resume',
  'thread.fork',
  'thread.archive',
  'thread.unarchive',
  'thread.rename',
  'thread.pin',
  'thread.unpin',
  'thread.compact',
  'thread.settings',
  'thread.openDesktop',
  'turn.start',
  'turn.interrupt',
  'turn.steer',
  'queue.enqueue',
  'queue.dispatch',
  'queue.edit',
  'queue.reorder',
  'queue.cancel',
  'queue.steer',
  'queue.retry',
  'queue.reconcile',
  'composer.plus',
  'composer.plugin',
  'composer.remove',
  'control.model',
  'control.reasoning',
  'control.serviceTier',
  'control.collaborationMode',
  'control.permissions',
  'control.enable',
  'desktop.restart',
]);

class GuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.statusCode = code === 'PROTECTED_THREAD' ? 403 : 409;
    this.details = { ...details };
  }
}

function normalizeThreadId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeThreadIds(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(normalizeThreadId).filter(Boolean));
}

class ProtectedThreadGuard {
  constructor(options = {}) {
    this.protectedThreadIds = normalizeThreadIds(options.protectedThreadIds);
    this.allowedThreadIds = normalizeThreadIds(options.allowedThreadIds);
    this.requireAllowlist = options.requireAllowlist === true;
  }

  update(options = {}) {
    if (Object.hasOwn(options, 'protectedThreadIds')) {
      this.protectedThreadIds = normalizeThreadIds(options.protectedThreadIds);
    }
    if (Object.hasOwn(options, 'allowedThreadIds')) {
      this.allowedThreadIds = normalizeThreadIds(options.allowedThreadIds);
    }
    if (Object.hasOwn(options, 'requireAllowlist')) {
      this.requireAllowlist = options.requireAllowlist === true;
    }
  }

  isProtected(threadId) {
    const normalized = normalizeThreadId(threadId);
    return Boolean(normalized && this.protectedThreadIds.has(normalized));
  }

  assertAllowed(context = {}) {
    const action = typeof context.action === 'string' ? context.action.trim() : '';
    const mode = typeof context.mode === 'string' ? context.mode.trim() : '';
    const threadId = normalizeThreadId(context.threadId);
    const observedThreadId = normalizeThreadId(context.observedThreadId);
    const desktopThreadId = normalizeThreadId(context.desktopThreadId);

    if (mode === 'read' || READ_ACTIONS.has(action)) {
      return { action, mode: 'read', threadId, observedThreadId, desktopThreadId };
    }
    if (!MUTATION_ACTIONS.has(action)) {
      throw new GuardError('UNKNOWN_MUTATION_ACTION', 'Unknown mutation action was rejected.', { action });
    }
    if (!threadId && action !== 'thread.start' && action !== 'desktop.restart') {
      throw new GuardError('TARGET_THREAD_REQUIRED', 'A concrete target task is required.', { action });
    }

    const protectedCandidate = [threadId, observedThreadId]
      .find(candidate => this.isProtected(candidate));
    if (protectedCandidate) {
      throw new GuardError('PROTECTED_THREAD', 'The requested task is protected from remote mutations.', { action });
    }
    if (mode === 'ui' && this.isProtected(desktopThreadId)) {
      throw new GuardError('PROTECTED_THREAD', 'UI actions are blocked while a protected task is active on the desktop.', { action });
    }
    if (context.requireObservedTargetMatch === true && observedThreadId && observedThreadId !== threadId) {
      throw new GuardError('THREAD_TARGET_MISMATCH', 'The observed active task no longer matches the requested target.', { action });
    }
    if (this.requireAllowlist && threadId && !this.allowedThreadIds.has(threadId)) {
      throw new GuardError('THREAD_NOT_ALLOWLISTED', 'The requested task is outside the dynamic-test allowlist.', { action });
    }

    return { action, mode, threadId, observedThreadId, desktopThreadId };
  }
}

function createProtectedThreadGuard(options = {}) {
  return new ProtectedThreadGuard(options);
}

module.exports = {
  GuardError,
  MUTATION_ACTIONS,
  READ_ACTIONS,
  ProtectedThreadGuard,
  createProtectedThreadGuard,
  normalizeThreadId,
};
