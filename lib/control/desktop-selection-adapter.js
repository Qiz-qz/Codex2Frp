'use strict';

const { randomUUID } = require('node:crypto');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeThreadId(value) {
  const raw = String(value || '').trim().replace(/^local:/i, '');
  return THREAD_ID.test(raw) ? raw.toLowerCase() : '';
}

function routeThreadId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://codex.invalid');
    let path = '';
    if (url.protocol === 'codex:' && url.hostname === 'threads') {
      path = `/threads${url.pathname}`;
    } else if (url.protocol === 'app:' && url.hostname === '-'
      && url.pathname === '/index.html' && /^#\/?threads\//i.test(url.hash)) {
      path = url.hash.slice(1).replace(/^([^/])/, '/$1');
    }
    const match = path.match(/^\/threads\/([0-9a-f-]+)\/?$/i);
    return match ? normalizeThreadId(match[1]) : '';
  } catch {
    return '';
  }
}

function verifiedSelectionExpression() {
  return `(() => {
    const threadIdPattern = /^(?:local:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.y <= innerHeight &&
        rect.right >= 0 && rect.x <= innerWidth && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const activeIds = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
      .filter(visible)
      .filter(el => el.getAttribute('data-app-action-sidebar-thread-active') === 'true')
      .map(el => el.getAttribute('data-app-action-sidebar-thread-id') || '')
      .filter(value => threadIdPattern.test(value))
      .map(value => value.replace(/^local:/i, '').toLowerCase());
    const uniqueActiveIds = [...new Set(activeIds)];
    if (uniqueActiveIds.length > 1) return null;
    return uniqueActiveIds.length === 1 ? {
      actionAttributes: {
        'data-app-action-sidebar-thread-id': uniqueActiveIds[0],
        'data-app-action-sidebar-thread-active': 'true',
      },
      route: String(location.href || ''),
    } : { route: String(location.href || '') };
  })()`;
}

function normalizedObservedAt(value, now = Date.now) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now()).toISOString();
}

function normalizeVerifiedDesktopSelection(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attributes = value.actionAttributes && typeof value.actionAttributes === 'object'
    ? value.actionAttributes
    : null;
  const routeId = routeThreadId(value.route);
  const actionId = attributes
    && String(attributes['data-app-action-sidebar-thread-active'] || '').toLowerCase() === 'true'
    ? normalizeThreadId(attributes['data-app-action-sidebar-thread-id'])
    : '';
  if (routeId && actionId && routeId !== actionId) return null;
  const threadId = routeId || actionId;
  const source = routeId ? 'desktop-route' : actionId ? 'desktop-action-attribute' : '';
  if (!threadId) return null;
  return {
    threadId,
    source,
    observedAt: normalizedObservedAt(value.observedAt, options.now),
    confidence: 'exact',
  };
}

class DesktopSelectionAdapter {
  constructor(options = {}) {
    this.observeSource = typeof options.observeSource === 'function'
      ? options.observeSource
      : async () => null;
    this.navigate = typeof options.navigate === 'function'
      ? options.navigate
      : async () => { throw new Error('Desktop navigation is unavailable.'); };
    this.transaction = options.transaction;
    this.createIntent = typeof options.createIntent === 'function' ? options.createIntent : null;
    this.createSourceToken = typeof options.createSourceToken === 'function'
      ? options.createSourceToken
      : randomUUID;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    this.confirmationTimeoutMs = Math.max(0, Number(options.confirmationTimeoutMs) || 1500);
    this.confirmationPollIntervalMs = Math.max(1, Number(options.confirmationPollIntervalMs) || 50);
    this.sourceTokenTtlMs = Number(options.sourceTokenTtlMs) > 0
      ? Number(options.sourceTokenTtlMs)
      : 5000;
    this.pendingPhoneSources = new Map();
    this.phoneOriginSelection = null;
  }

  async observeDesktopSelection(raw, options = {}) {
    const evidence = raw === undefined ? await this.observeSource() : raw;
    const selection = normalizeVerifiedDesktopSelection(evidence, { now: this.now });
    if (!selection) return null;
    if (this.phoneOriginSelection && this.phoneOriginSelection.threadId !== selection.threadId) {
      this.phoneOriginSelection = null;
    }
    const suppliedToken = String(evidence && evidence.sourceToken || '').trim();
    const pending = this.pendingPhoneSources.get(selection.threadId);
    const observedAt = this.now();
    if (pending && pending.expiresAt < observedAt) this.pendingPhoneSources.delete(selection.threadId);
    const pendingToken = pending && pending.expiresAt >= observedAt ? pending.token : '';
    const ownedToken = this.phoneOriginSelection && this.phoneOriginSelection.threadId === selection.threadId
      ? this.phoneOriginSelection.token
      : '';
    const sourceToken = ownedToken
      || (pendingToken && (!suppliedToken || suppliedToken === pendingToken) ? pendingToken : '');
    if (sourceToken && options.consumeEcho !== false) this.pendingPhoneSources.delete(selection.threadId);
    return sourceToken
      ? { ...selection, sourceToken, suppressEcho: true }
      : selection;
  }

  async confirmSelection(requestedThreadId) {
    const startedAt = this.now();
    let mismatch = '';
    while (true) {
      const observed = await this.observeDesktopSelection(undefined, { consumeEcho: false });
      if (observed && observed.threadId === requestedThreadId) {
        return { status: 'confirmed', requestedThreadId, observedThreadId: requestedThreadId };
      }
      if (observed && observed.threadId) mismatch = observed.threadId;
      if (this.now() - startedAt >= this.confirmationTimeoutMs) break;
      await this.sleep(this.confirmationPollIntervalMs);
    }
    return mismatch
      ? { status: 'uncertain', requestedThreadId, observedThreadId: mismatch, reason: 'desktop_selection_mismatch' }
      : { status: 'unavailable', requestedThreadId, reason: 'exact_desktop_selection_unavailable' };
  }

  async openDesktopThread(value) {
    const requestedThreadId = normalizeThreadId(value);
    if (!requestedThreadId) {
      return { status: 'unavailable', requestedThreadId: '', reason: 'invalid_thread_id' };
    }
    if (!this.transaction || typeof this.transaction.run !== 'function'
      || typeof this.createIntent !== 'function') {
      return { status: 'unavailable', requestedThreadId, reason: 'desktop_navigation_unavailable' };
    }
    const sourceToken = String(this.createSourceToken() || '').trim();
    if (!sourceToken) {
      return { status: 'unavailable', requestedThreadId, reason: 'source_token_unavailable' };
    }
    const action = 'thread.openDesktop';
    const intent = this.createIntent({ id: `desktop-selection:${sourceToken}`, action, threadId: requestedThreadId });
    return this.transaction.run({
      action,
      threadId: requestedThreadId,
      desktopThreadId: requestedThreadId,
      intent,
    }, async ({ signal, fence } = {}) => {
      if (signal && signal.aborted) throw signal.reason;
      if (fence && typeof fence.assertAllowed === 'function') fence.assertAllowed();
      if (this.pendingPhoneSources.size >= 256 && !this.pendingPhoneSources.has(requestedThreadId)) {
        this.pendingPhoneSources.delete(this.pendingPhoneSources.keys().next().value);
      }
      this.pendingPhoneSources.set(requestedThreadId, {
        token: sourceToken,
        expiresAt: this.now() + this.sourceTokenTtlMs,
      });
      try {
        await this.navigate({ threadId: requestedThreadId, sourceToken });
        const confirmation = await this.confirmSelection(requestedThreadId);
        if (confirmation.status === 'confirmed') {
          this.phoneOriginSelection = { threadId: requestedThreadId, token: sourceToken };
        } else {
          this.pendingPhoneSources.delete(requestedThreadId);
        }
        return confirmation;
      } catch (error) {
        this.pendingPhoneSources.delete(requestedThreadId);
        throw error;
      }
    });
  }
}

function createDesktopSelectionAdapter(options = {}) {
  return new DesktopSelectionAdapter(options);
}

async function consumeDesktopSelectionForSync(adapter) {
  if (!adapter || typeof adapter.observeDesktopSelection !== 'function') {
    return { selection: null, suppressed: false, reason: 'observer_unavailable' };
  }
  let selection;
  try { selection = await adapter.observeDesktopSelection(); } catch {
    return { selection: null, suppressed: false, reason: 'observer_unavailable' };
  }
  if (!selection) return { selection: null, suppressed: false, reason: 'selection_absent' };
  if (selection.suppressEcho === true) {
    return { selection: null, suppressed: true, reason: 'phone_origin' };
  }
  return { selection, suppressed: false };
}

module.exports = {
  DesktopSelectionAdapter,
  consumeDesktopSelectionForSync,
  createDesktopSelectionAdapter,
  normalizeThreadId,
  normalizeVerifiedDesktopSelection,
  verifiedSelectionExpression,
};
