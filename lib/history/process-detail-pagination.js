'use strict';

const crypto = require('node:crypto');

const PROCESS_DETAIL_CURSOR_VERSION = 1;
const DEFAULT_PROCESS_DETAIL_PAGE_SIZE = 48;
const MAX_PROCESS_DETAIL_PAGE_SIZE = 240;

function finiteInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizeProcessDetailPageRequest(input = {}) {
  const limit = Math.max(1, Math.min(
    finiteInteger(input.limit, DEFAULT_PROCESS_DETAIL_PAGE_SIZE),
    MAX_PROCESS_DETAIL_PAGE_SIZE,
  ));
  return {
    limit,
    before: Math.max(0, finiteInteger(input.before, 0)),
    cursor: String(input.cursor || '').trim(),
    revision: String(input.revision || '').trim(),
  };
}

function stableActivityRevisionValue(activity = {}) {
  const value = activity && typeof activity === 'object' ? activity : {};
  // Attachments deliberately do not take part in the revision. They are
  // capability handles with a short lifetime, while the underlying visible
  // activity must keep one stable pagination identity.
  return [
    String(value.id || ''),
    String(value.kind || ''),
    String(value.variant || ''),
    String(value.state || ''),
    String(value.title || ''),
    String(value.displayDetail || ''),
    Number.isFinite(Number(value.sourceOrdinal)) ? Number(value.sourceOrdinal) : '',
    Number.isFinite(Number(value.count)) ? Number(value.count) : '',
  ];
}

function processDetailRevision(process = {}) {
  const detailActivities = Array.isArray(process.detailActivities) ? process.detailActivities : [];
  const payload = {
    turnId: String(process.turnId || ''),
    state: String(process.state || ''),
    detailCount: Number(process.detailCount || detailActivities.length) || 0,
    activities: detailActivities.map(stableActivityRevisionValue),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function encodeProcessDetailCursor(input = {}) {
  const revision = String(input.revision || '');
  const offset = Math.max(0, finiteInteger(input.offset, 0));
  if (!/^[a-f0-9]{64}$/i.test(revision)) throw new Error('Process detail cursor revision is invalid.');
  return Buffer.from(JSON.stringify({ v: PROCESS_DETAIL_CURSOR_VERSION, r: revision, o: offset }), 'utf8').toString('base64url');
}

function decodeProcessDetailCursor(value = '') {
  const encoded = String(value || '').trim();
  if (!encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Process detail cursor is invalid.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Process detail cursor is invalid.');
  }
  const revision = String(parsed && parsed.r || '');
  const offset = finiteInteger(parsed && parsed.o, -1);
  if (!parsed || parsed.v !== PROCESS_DETAIL_CURSOR_VERSION || !/^[a-f0-9]{64}$/i.test(revision) || offset < 0) {
    throw new Error('Process detail cursor is invalid.');
  }
  return { revision, offset };
}

function staleProcessDetailCursor(message = '过程详情已更新，请重新打开后再试。') {
  const error = new Error(message);
  error.code = 'PROCESS_DETAIL_CURSOR_STALE';
  return error;
}

function pageProcessDetailActivities(process = {}, request = {}) {
  const pageRequest = normalizeProcessDetailPageRequest(request);
  const revision = processDetailRevision(process);
  let offset = pageRequest.before;
  if (pageRequest.cursor) {
    let decoded;
    try {
      decoded = decodeProcessDetailCursor(pageRequest.cursor);
    } catch {
      throw staleProcessDetailCursor('过程详情分页锚点无效，请重新打开后再试。');
    }
    if (decoded.revision !== revision) throw staleProcessDetailCursor();
    offset = decoded.offset;
  }
  if (pageRequest.revision && pageRequest.revision !== revision) throw staleProcessDetailCursor();

  const source = Array.isArray(process.detailActivities) ? process.detailActivities : [];
  const safeOffset = Math.min(Math.max(0, offset), source.length);
  const items = source.slice(safeOffset, safeOffset + pageRequest.limit);
  const nextOffset = safeOffset + items.length;
  const hasMore = nextOffset < source.length;
  return {
    revision,
    items,
    detailCount: source.length,
    hasMore,
    nextBefore: nextOffset,
    nextCursor: hasMore ? encodeProcessDetailCursor({ revision, offset: nextOffset }) : '',
  };
}

module.exports = {
  DEFAULT_PROCESS_DETAIL_PAGE_SIZE,
  MAX_PROCESS_DETAIL_PAGE_SIZE,
  decodeProcessDetailCursor,
  encodeProcessDetailCursor,
  normalizeProcessDetailPageRequest,
  pageProcessDetailActivities,
  processDetailRevision,
};
