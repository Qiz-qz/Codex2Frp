'use strict';

function safeSegment(value = '') {
  return String(value || '').trim();
}

function detailCacheKey(input = {}) {
  const threadId = safeSegment(input.threadId);
  const fileSignature = safeSegment(input.fileSignature);
  const presentationId = safeSegment(input.presentationId);
  const revision = safeSegment(input.revision);
  if (!threadId || !fileSignature || !presentationId || !/^[a-f0-9]{64}$/i.test(revision)) return '';
  return `${threadId}:${fileSignature}:${presentationId}:${revision}`;
}

function createHistoryProcessDetailCache(options = {}) {
  const limit = Math.max(1, Math.floor(Number(options.limit) || 96));
  const entries = new Map();

  function set(input = {}) {
    const key = detailCacheKey(input);
    if (!key || !input.process || typeof input.process !== 'object') return false;
    if (entries.has(key)) entries.delete(key);
    entries.set(key, {
      threadId: safeSegment(input.threadId),
      fileSignature: safeSegment(input.fileSignature),
      presentationId: safeSegment(input.presentationId),
      revision: safeSegment(input.revision),
      process: input.process,
      timeline: Array.isArray(input.timeline) ? input.timeline : [],
      segments: Array.isArray(input.segments) ? input.segments : [],
    });
    while (entries.size > limit) entries.delete(entries.keys().next().value);
    return true;
  }

  function get(input = {}) {
    const key = detailCacheKey(input);
    const entry = key ? entries.get(key) : null;
    if (!entry) return null;
    // LRU touch means recently opened processes stay available during a long
    // thread scroll while stale session signatures naturally stop matching.
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  return {
    set,
    get,
    size: () => entries.size,
    keys: () => [...entries.keys()],
  };
}

module.exports = {
  createHistoryProcessDetailCache,
  detailCacheKey,
};
