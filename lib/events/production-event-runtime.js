'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isSubagentSessionMeta } = require('../thread-utils');
const { EventFeed } = require('./event-feed');
const { EventReconciler } = require('./reconciler');
const { SessionTailer } = require('./session-tailer');

const THREAD_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i;
const TRUSTED_MAIN_THREAD_SOURCES = new Set(['main', 'user']);
const TRUSTED_MAIN_SESSION_SOURCES = new Set([
  'cli',
  'codex-cli',
  'codex_cli_rs',
  'desktop',
  'exec',
  'app-server',
  'app_server',
  'vscode',
]);

function eventRuntimeError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function listJsonlFiles(rootDir, fsImpl, output = []) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) listJsonlFiles(filePath, fsImpl, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(filePath);
  }
  return output;
}

function readSessionMeta(filePath, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fsImpl.readSync(fd, buffer, 0, buffer.length, 0);
    const source = buffer.toString('utf8', 0, bytesRead);
    const newline = source.indexOf('\n');
    if (newline < 0 && bytesRead === buffer.length) return null;
    const firstLine = (newline >= 0 ? source.slice(0, newline) : source).replace(/^\uFEFF/, '').trim();
    if (!firstLine) return null;
    let item;
    try { item = JSON.parse(firstLine); } catch { return null; }
    if (!item || item.type !== 'session_meta' || !item.payload
      || typeof item.payload !== 'object' || Array.isArray(item.payload)) return null;
    return item.payload;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
  return null;
}

function isTrustedMainSessionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || isSubagentSessionMeta(meta)) {
    return false;
  }
  const threadSource = String(meta.thread_source || meta.threadSource || '').trim().toLowerCase();
  if (TRUSTED_MAIN_THREAD_SOURCES.has(threadSource)) return true;
  const source = typeof meta.source === 'string' ? meta.source.trim().toLowerCase() : '';
  return TRUSTED_MAIN_SESSION_SOURCES.has(source);
}

function createSessionResolver(options = {}) {
  const configuredSessionsDir = String(options.sessionsDir || '').trim();
  if (!configuredSessionsDir) throw new TypeError('createSessionResolver requires sessionsDir.');
  const sessionsDir = path.resolve(configuredSessionsDir);
  const fsImpl = options.fsImpl || fs;
  const cachedPaths = new Map();

  return function resolveSession(threadId) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!THREAD_ID_PATTERN.test(normalizedThreadId)) return null;
    let filePath = cachedPaths.get(normalizedThreadId) || '';
    if (filePath) {
      try {
        if (!fsImpl.statSync(filePath).isFile()) filePath = '';
      } catch {
        filePath = '';
      }
    }
    if (!filePath) {
      let best = null;
      for (const candidate of listJsonlFiles(sessionsDir, fsImpl)) {
        if (!path.basename(candidate).toLowerCase().endsWith(`${normalizedThreadId.toLowerCase()}.jsonl`)) continue;
        try {
          const stat = fsImpl.statSync(candidate);
          if (!best || stat.mtimeMs > best.mtimeMs) best = { filePath: candidate, mtimeMs: stat.mtimeMs };
        } catch {}
      }
      filePath = best ? best.filePath : '';
      if (!filePath) return null;
      cachedPaths.set(normalizedThreadId, filePath);
    }
    const meta = readSessionMeta(filePath, fsImpl);
    return {
      filePath,
      session: { isSubagent: !isTrustedMainSessionMeta(meta) },
    };
  };
}

function notificationThreadId(notification = {}) {
  const params = notification.params || {};
  return String(
    params.threadId
    || (params.thread && params.thread.id)
    || (params.turn && params.turn.threadId)
    || '',
  ).trim();
}

function sessionDescriptor(value) {
  if (!value || typeof value !== 'object') return null;
  const filePath = String(value.filePath || '').trim();
  if (!filePath) return null;
  return {
    filePath,
    session: {
      isSubagent: value.session && value.session.isSubagent === true,
    },
  };
}

class ProductionEventRuntime {
  constructor(options = {}) {
    if (typeof options.resolveSession !== 'function') {
      throw new TypeError('ProductionEventRuntime requires resolveSession(threadId).');
    }
    this.serverInstanceId = String(options.serverInstanceId || crypto.randomUUID()).trim();
    this.resolveSession = options.resolveSession;
    this.fileSource = options.fileSource;
    this.pollIntervalMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : 750;
    this.setIntervalImpl = options.setIntervalImpl || setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl || clearInterval;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.threads = new Map();
    this.timer = null;
    this.stopped = false;
    this.lifecycleGeneration = 0;
    this.lastConnectionEpoch = 0;
    this.lastNotificationSequence = 0;
    this.notificationTail = Promise.resolve();
  }

  createTailer(filePath) {
    return new SessionTailer({
      filePath,
      ...(this.fileSource ? { source: this.fileSource } : {}),
    });
  }

  createState(threadId, descriptor) {
    const state = {
      threadId,
      filePath: descriptor.filePath,
      session: descriptor.session,
      tailer: this.createTailer(descriptor.filePath),
      reconciler: null,
      rpcSequence: 0,
      stale: false,
      lastSyncedAt: null,
      pollPromise: null,
    };
    state.reconciler = new EventReconciler({
      serverInstanceId: this.serverInstanceId,
      session: state.session,
      fullRehydrate: () => this.readFullSession(state),
    });
    this.threads.set(threadId, state);
    return state;
  }

  async resolveDescriptor(threadId) {
    if (!THREAD_ID_PATTERN.test(threadId)) {
      throw eventRuntimeError('INVALID_THREAD_ID', 'A valid thread id is required.', 400);
    }
    return sessionDescriptor(await this.resolveSession(threadId));
  }

  isLifecycleActive(expectedGeneration) {
    return !this.stopped && this.lifecycleGeneration === expectedGeneration;
  }

  async ensureState(threadId, expectedGeneration) {
    const normalizedThreadId = String(threadId || '').trim();
    const descriptor = await this.resolveDescriptor(normalizedThreadId);
    if (expectedGeneration !== undefined && !this.isLifecycleActive(expectedGeneration)) {
      throw eventRuntimeError('EVENT_RUNTIME_STOPPED', 'The event runtime is stopped.', 503);
    }
    const existing = this.threads.get(normalizedThreadId);
    if (!descriptor) {
      if (existing) {
        existing.stale = true;
        return existing;
      }
      throw eventRuntimeError('EVENT_SESSION_NOT_FOUND', 'No readable session exists for this thread.', 404);
    }
    if (!existing) return this.createState(normalizedThreadId, descriptor);

    const privacyChanged = existing.session.isSubagent !== descriptor.session.isSubagent;
    const pathChanged = existing.filePath !== descriptor.filePath;
    if (privacyChanged) {
      const previousVersion = existing.reconciler.snapshot().snapshotVersion;
      existing.session = descriptor.session;
      existing.filePath = descriptor.filePath;
      existing.tailer = this.createTailer(descriptor.filePath);
      existing.reconciler = new EventReconciler({
        serverInstanceId: this.serverInstanceId,
        session: descriptor.session,
        feed: new EventFeed({
          serverInstanceId: this.serverInstanceId,
          snapshotVersion: previousVersion + 1,
        }),
        fullRehydrate: () => this.readFullSession(existing),
      });
    } else if (pathChanged) {
      existing.filePath = descriptor.filePath;
      existing.tailer = this.createTailer(descriptor.filePath);
      await this.rehydrateState(existing);
    }
    return existing;
  }

  readFullSession(state) {
    const tailer = this.createTailer(state.filePath);
    const result = tailer.poll();
    state.tailer = tailer;
    return result.entries;
  }

  async rehydrateState(state, entries) {
    const input = entries === undefined ? this.readFullSession(state) : entries;
    state.reconciler.rehydrate(input);
    state.stale = false;
    state.lastSyncedAt = this.now().toISOString();
    return state;
  }

  async pollState(state) {
    if (state.pollPromise) return state.pollPromise;
    const pollPromise = Promise.resolve().then(() => {
      const result = state.tailer.poll();
      if (result.resetReason) state.reconciler.rehydrate(result.entries);
      else state.reconciler.ingestFileEntries(result.entries);
      state.stale = false;
      state.lastSyncedAt = this.now().toISOString();
      return state;
    }).catch(error => {
      state.stale = true;
      throw eventRuntimeError(
        'EVENT_SESSION_UNAVAILABLE',
        'The session event stream is temporarily unavailable.',
        503,
      );
    }).finally(() => {
      if (state.pollPromise === pollPromise) state.pollPromise = null;
    });
    state.pollPromise = pollPromise;
    return pollPromise;
  }

  async refreshThread(threadId, expectedGeneration) {
    const state = await this.ensureState(String(threadId || '').trim(), expectedGeneration);
    if (expectedGeneration !== undefined && !this.isLifecycleActive(expectedGeneration)) {
      throw eventRuntimeError('EVENT_RUNTIME_STOPPED', 'The event runtime is stopped.', 503);
    }
    return this.pollState(state);
  }

  async read(threadId, request = {}) {
    const state = await this.refreshThread(threadId);
    return state.reconciler.read(request);
  }

  async snapshot(threadId) {
    const state = await this.refreshThread(threadId);
    return state.reconciler.snapshot();
  }

  async cursor(threadId) {
    const snapshot = await this.snapshot(threadId);
    return {
      serverInstanceId: snapshot.serverInstanceId,
      snapshotVersion: snapshot.snapshotVersion,
      cursor: snapshot.cursor,
    };
  }

  async rehydrateAll(expectedGeneration) {
    await Promise.all([...this.threads.values()].map(async state => {
      if (expectedGeneration !== undefined && !this.isLifecycleActive(expectedGeneration)) return;
      try {
        await this.rehydrateState(state);
      } catch {
        state.stale = true;
      }
    }));
  }

  ingestRpcNotification(notification = {}) {
    const queuedLifecycleGeneration = this.lifecycleGeneration;
    const task = this.notificationTail.then(() => (
      this._ingestRpcNotification(notification, queuedLifecycleGeneration)
    ));
    this.notificationTail = task.catch(() => {});
    return task;
  }

  async _ingestRpcNotification(notification = {}, lifecycleGeneration = this.lifecycleGeneration) {
    if (!this.isLifecycleActive(lifecycleGeneration)) return { accepted: [], ignored: true };
    const connectionEpoch = Number(notification.connectionEpoch);
    const sequence = Number(notification.sequence);
    let rehydratedForEpochChange = false;
    if (Number.isSafeInteger(connectionEpoch) && connectionEpoch > 0) {
      if (this.lastConnectionEpoch > 0 && connectionEpoch < this.lastConnectionEpoch) {
        return { accepted: [], ignored: true, staleEpoch: true };
      }
      if (this.lastConnectionEpoch > 0 && connectionEpoch > this.lastConnectionEpoch) {
        await this.rehydrateAll(lifecycleGeneration);
        if (!this.isLifecycleActive(lifecycleGeneration)) return { accepted: [], ignored: true, stopped: true };
        this.lastNotificationSequence = 0;
        rehydratedForEpochChange = true;
      }
      this.lastConnectionEpoch = connectionEpoch;
    }
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      if (this.lastNotificationSequence > 0 && sequence <= this.lastNotificationSequence) {
        return { accepted: [], ignored: true, duplicate: true };
      }
      if (sequence > this.lastNotificationSequence + 1 && !rehydratedForEpochChange) {
        await this.rehydrateAll(lifecycleGeneration);
        if (!this.isLifecycleActive(lifecycleGeneration)) return { accepted: [], ignored: true, stopped: true };
      }
      this.lastNotificationSequence = sequence;
    }

    const threadId = notificationThreadId(notification);
    if (!THREAD_ID_PATTERN.test(threadId)) return { accepted: [], ignored: true };
    let state;
    try {
      state = await this.refreshThread(threadId, lifecycleGeneration);
    } catch {
      return { accepted: [], ignored: true };
    }
    if (!this.isLifecycleActive(lifecycleGeneration)) return { accepted: [], ignored: true, stopped: true };
    state.rpcSequence += 1;
    return state.reconciler.ingestRpcNotification({
      ...notification,
      sequence: state.rpcSequence,
    });
  }

  async pollAll() {
    await Promise.all([...this.threads.keys()].map(async threadId => {
      try { await this.refreshThread(threadId); } catch {}
    }));
  }

  start() {
    if (this.timer !== null) return false;
    if (this.stopped) this.lifecycleGeneration += 1;
    this.stopped = false;
    this.timer = this.setIntervalImpl(() => {
      this.pollAll().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    return true;
  }

  stop() {
    const wasRunning = this.timer !== null;
    if (wasRunning) this.clearIntervalImpl(this.timer);
    this.timer = null;
    if (!this.stopped) this.lifecycleGeneration += 1;
    this.stopped = true;
    this.lastConnectionEpoch = 0;
    this.lastNotificationSequence = 0;
    this.threads.clear();
    return wasRunning;
  }

  diagnostics() {
    const states = [...this.threads.values()];
    const snapshotVersion = states.reduce((maximum, state) => (
      Math.max(maximum, state.reconciler.snapshot().snapshotVersion)
    ), 0);
    const lastSyncedAt = states
      .map(state => state.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    return {
      snapshotVersion,
      stale: states.some(state => state.stale),
      lastSyncedAt,
    };
  }
}

module.exports = {
  ProductionEventRuntime,
  createSessionResolver,
};
