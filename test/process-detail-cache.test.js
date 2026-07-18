'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHistoryProcessDetailCache,
  detailCacheKey,
} = require('../lib/history/process-detail-cache');

const revision = value => String(value).repeat(64).slice(0, 64);

function entry(index, fileSignature = '100:1') {
  return {
    threadId: '11111111-1111-4111-8111-111111111111',
    fileSignature,
    presentationId: `presentation-${index}`,
    revision: revision(index % 10),
    process: { turnId: `turn-${index}`, detailActivities: [{ id: `detail-${index}` }] },
    timeline: [{ id: `narrative-${index}`, kind: 'commentary', publicNarrative: 'public progress' }],
    segments: [{ id: `segment-${index}`, kind: 'commentary', items: [{ id: `narrative-${index}` }] }],
  };
}

test('summary-preheated process detail cache returns the exact visible presentation without a scan', () => {
  const cache = createHistoryProcessDetailCache({ limit: 3 });
  const visible = entry(1);
  assert.equal(cache.set(visible), true);
  const hit = cache.get(visible);
  assert.equal(hit.process, visible.process);
  assert.equal(hit.timeline, visible.timeline);
  assert.equal(hit.segments, visible.segments);
  assert.equal(hit.presentationId, visible.presentationId);
});

test('session file signature changes naturally invalidate a cached process detail', () => {
  const cache = createHistoryProcessDetailCache({ limit: 3 });
  const visible = entry(2, '200:1');
  cache.set(visible);
  assert.equal(cache.get({ ...visible, fileSignature: '201:2' }), null);
  assert.ok(cache.get(visible));
});

test('process detail cache is bounded and keeps recently opened entries', () => {
  const cache = createHistoryProcessDetailCache({ limit: 2 });
  const first = entry(1);
  const second = entry(2);
  const third = entry(3);
  cache.set(first);
  cache.set(second);
  assert.ok(cache.get(first), 'read touches first as most recent');
  cache.set(third);
  assert.equal(cache.size(), 2);
  assert.equal(cache.get(second), null, 'least recently used entry is evicted');
  assert.ok(cache.get(first));
  assert.ok(cache.get(third));
});

test('cache keys require all stable history identity components', () => {
  assert.equal(detailCacheKey({ ...entry(4), revision: 'short' }), '');
  assert.match(detailCacheKey(entry(4)), /11111111.*100:1.*presentation-4/);
});
