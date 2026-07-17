'use strict';

const DEFAULT_HISTORY_PAGE_SIZE = 120;
const MAX_HISTORY_PAGE_SIZE = 240;
const HISTORY_CURSOR_VERSION = 1;

function finiteInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizeHistoryPageRequest(input = {}) {
  const limit = Math.max(1, Math.min(
    finiteInteger(input.limit, DEFAULT_HISTORY_PAGE_SIZE),
    MAX_HISTORY_PAGE_SIZE,
  ));
  const before = Math.max(0, finiteInteger(input.before, 0));
  return { limit, before };
}

function pageHistorySuffix(rows, request = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const normalized = normalizeHistoryPageRequest(request);
  const end = Math.max(0, source.length - normalized.before);
  const start = Math.max(0, end - normalized.limit);
  const items = source.slice(start, end);
  return {
    items,
    hasMore: start > 0,
    nextBefore: normalized.before + items.length,
  };
}

function encodeHistoryCursor(input = {}) {
  const payload = {
    v: HISTORY_CURSOR_VERSION,
    end: Math.max(0, finiteInteger(input.endOffset, 0)),
    m: Math.max(0, finiteInteger(input.messageBefore, 0)),
    t: Math.max(0, finiteInteger(input.turnBefore, 0)),
    file: String(input.fileKey || ''),
    anchor: String(input.boundaryHash || ''),
  };
  if (!payload.end || !/^[a-f0-9]{32,64}$/i.test(payload.file) || !/^[a-f0-9]{32,64}$/i.test(payload.anchor)) {
    throw new Error('History cursor anchor is incomplete.');
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value = '') {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('History cursor is invalid.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('History cursor is invalid.');
  }
  if (!parsed || parsed.v !== HISTORY_CURSOR_VERSION) throw new Error('History cursor version is unsupported.');
  const result = {
    endOffset: Math.max(0, finiteInteger(parsed.end, -1)),
    messageBefore: Math.max(0, finiteInteger(parsed.m, -1)),
    turnBefore: Math.max(0, finiteInteger(parsed.t, -1)),
    fileKey: String(parsed.file || ''),
    boundaryHash: String(parsed.anchor || ''),
  };
  if (!result.endOffset || !/^[a-f0-9]{32,64}$/i.test(result.fileKey) ||
      !/^[a-f0-9]{32,64}$/i.test(result.boundaryHash)) {
    throw new Error('History cursor anchor is invalid.');
  }
  return result;
}

module.exports = {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  normalizeHistoryPageRequest,
  pageHistorySuffix,
  encodeHistoryCursor,
  decodeHistoryCursor,
};
