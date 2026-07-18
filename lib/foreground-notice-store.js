'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_CAPACITY = 256;
const MAX_CAPACITY = 2048;
const DEFAULT_PAGE_LIMIT = 64;
const MAX_PAGE_LIMIT = 256;
const STATUS_VALUES = new Set(['running', 'complete', 'interrupted', 'error']);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum
    ? Math.min(parsed, maximum)
    : fallback;
}

function boundedText(value, maximum = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function durationText(durationMs) {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}min ${remainder}s` : `${remainder}s`;
}

function noticePresentation(status, threadTitle, durationMs) {
  const duration = durationText(durationMs);
  const subject = threadTitle ? `“${threadTitle}”` : 'Codex 任务';
  if (status === 'running') {
    return { tone: 'status', title: '任务开始', message: `${subject}开始执行。` };
  }
  if (status === 'complete') {
    return {
      tone: 'status', title: '任务完成',
      message: `${subject}已完成${duration ? `，用时 ${duration}` : ''}。`,
    };
  }
  if (status === 'interrupted') {
    return {
      tone: 'error', title: '任务终止',
      message: `${subject}已终止${duration ? `，用时 ${duration}` : ''}。`,
    };
  }
  return {
    tone: 'error', title: '任务失败',
    message: `${subject}失败${duration ? `，用时 ${duration}` : ''}。`,
  };
}

function safeEventKey(value = {}) {
  const source = boundedText(value.eventKey || `${value.threadId}:${value.status}:${value.at}`, 512);
  if (/^notice-[0-9a-f]{32}$/.test(source)) return source;
  return `notice-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function sanitizeNotice(value = {}) {
  const status = boundedText(value.status, 24).toLowerCase();
  const threadId = boundedText(value.threadId, 128);
  if (!STATUS_VALUES.has(status) || !threadId) return null;
  const threadTitle = boundedText(value.threadTitle, 24);
  const durationMs = Math.max(0, boundedInteger(value.durationMs, 0, 0, Number.MAX_SAFE_INTEGER));
  const parsedAt = Date.parse(value.at || '');
  const at = Number.isFinite(parsedAt) ? new Date(parsedAt).toISOString() : new Date().toISOString();
  return {
    eventKey: safeEventKey({ ...value, status, threadId, at }),
    status,
    ...noticePresentation(status, threadTitle, durationMs),
    threadId,
    threadTitle,
    durationMs,
    at,
  };
}

function sanitizeThreadSnapshot(value = {}) {
  const id = boundedText(value.id || value.threadId, 128);
  if (!id) return null;
  return {
    id,
    name: boundedText(value.name || value.title, 80),
    runtimeStatus: boundedText(value.runtimeStatus || value.status, 24),
    runtimeActive: value.runtimeActive === true,
    runtimeStartedAt: boundedText(value.runtimeStartedAt, 64),
    runtimeCompletedAt: boundedText(value.runtimeCompletedAt, 64),
    runtimeTerminalKind: boundedText(value.runtimeTerminalKind, 24),
    runtimeUpdatedAt: boundedText(value.runtimeUpdatedAt, 64),
    runtimeTurnId: boundedText(value.runtimeTurnId || value.turnId, 128),
  };
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, nextCursor: 1, snapshotReady: false, snapshot: [], events: [] };
}

function normalizeState(value, capacity) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION) return emptyState();
  const events = [];
  const seenCursors = new Set();
  for (const row of Array.isArray(value.events) ? value.events : []) {
    const cursor = Number(row && row.cursor);
    const notice = sanitizeNotice(row && row.notice);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || seenCursors.has(cursor) || !notice) continue;
    seenCursors.add(cursor);
    events.push({ cursor, notice });
  }
  events.sort((left, right) => left.cursor - right.cursor);
  const retained = events.slice(-capacity);
  const lastCursor = retained.length ? retained[retained.length - 1].cursor : 0;
  const configuredNext = Number(value.nextCursor);
  const nextCursor = Number.isSafeInteger(configuredNext) && configuredNext > lastCursor
    ? configuredNext
    : lastCursor + 1;
  const snapshot = (Array.isArray(value.snapshot) ? value.snapshot : [])
    .map(sanitizeThreadSnapshot).filter(Boolean).slice(0, 1000);
  return {
    schemaVersion: SCHEMA_VERSION,
    nextCursor,
    snapshotReady: value.snapshotReady === true,
    snapshot,
    events: retained,
  };
}

function atomicWrite(file, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
    fileSystem.renameSync(temporary, file);
  } finally {
    try { fileSystem.rmSync(temporary, { force: true }); } catch {}
  }
}

class ForegroundNoticeStore {
  constructor(options = {}) {
    const configured = String(options.file || '').trim();
    if (!configured) throw new TypeError('ForegroundNoticeStore requires file.');
    this.file = path.resolve(configured);
    this.fs = options.fs || fs;
    this.capacity = boundedInteger(options.capacity, DEFAULT_CAPACITY, 16, MAX_CAPACITY);
    this.state = this.readState();
  }

  readState() {
    try {
      return normalizeState(JSON.parse(this.fs.readFileSync(this.file, 'utf8')), this.capacity);
    } catch {
      return emptyState();
    }
  }

  persist() {
    atomicWrite(this.file, this.state, this.fs);
  }

  getSnapshot() {
    return {
      ready: this.state.snapshotReady,
      threads: this.state.snapshot.map(row => ({ ...row })),
    };
  }

  commitObservation(snapshot = [], notices = []) {
    const normalizedSnapshot = snapshot.map(sanitizeThreadSnapshot).filter(Boolean).slice(0, 1000);
    const snapshotChanged = !this.state.snapshotReady
      || JSON.stringify(this.state.snapshot) !== JSON.stringify(normalizedSnapshot);
    const existingKeys = new Set(this.state.events.map(row => row.notice.eventKey));
    const appended = [];
    for (const value of notices) {
      const notice = sanitizeNotice(value);
      if (!notice || existingKeys.has(notice.eventKey)) continue;
      existingKeys.add(notice.eventKey);
      const row = { cursor: this.state.nextCursor++, notice };
      this.state.events.push(row);
      appended.push({ ...notice, cursor: row.cursor });
    }
    this.state.events = this.state.events.slice(-this.capacity);
    this.state.snapshot = normalizedSnapshot;
    this.state.snapshotReady = true;
    if (snapshotChanged || appended.length) this.persist();
    return appended;
  }

  readAfter(afterCursor = 0, options = {}) {
    const requested = boundedInteger(afterCursor, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(options.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
    const oldestCursor = this.state.events.length ? this.state.events[0].cursor : this.state.nextCursor;
    const latestCursor = this.state.events.length
      ? this.state.events[this.state.events.length - 1].cursor
      : Math.max(0, this.state.nextCursor - 1);
    const cursorBehind = requested < oldestCursor - 1;
    const cursorAhead = requested > latestCursor;
    const resetRequired = cursorBehind || cursorAhead;
    const effectiveCursor = cursorBehind ? oldestCursor - 1 : cursorAhead ? latestCursor : requested;
    const available = this.state.events.filter(row => row.cursor > effectiveCursor);
    const rows = available.slice(0, limit);
    const nextCursor = rows.length ? rows[rows.length - 1].cursor : effectiveCursor;
    return {
      notices: rows.map(row => ({ ...row.notice, cursor: row.cursor })),
      nextCursor,
      oldestCursor,
      latestCursor,
      hasMore: available.length > rows.length,
      resetRequired,
    };
  }
}

module.exports = {
  DEFAULT_CAPACITY,
  ForegroundNoticeStore,
  sanitizeNotice,
  sanitizeThreadSnapshot,
};
