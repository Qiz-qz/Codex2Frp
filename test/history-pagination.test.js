const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHistoryCursor,
  encodeHistoryCursor,
  pageHistorySuffix,
  normalizeHistoryPageRequest,
} = require('../lib/history/history-pagination');

test('history pagination walks a complete suffix without overlap or omission', () => {
  const rows = Array.from({ length: 307 }, (_, index) => ({ id: `row-${index}` }));
  const seen = [];
  let before = 0;
  do {
    const page = pageHistorySuffix(rows, { before, limit: 120 });
    seen.unshift(...page.items.map(item => item.id));
    before = page.nextBefore;
    if (!page.hasMore) break;
  } while (true);

  assert.deepEqual(seen, rows.map(item => item.id));
});

test('history pagination clamps hostile inputs while allowing windows beyond the legacy 120 row cap', () => {
  assert.deepEqual(normalizeHistoryPageRequest({ limit: '-1', before: '-4' }), { limit: 1, before: 0 });
  assert.deepEqual(normalizeHistoryPageRequest({ limit: '9999', before: '300' }), { limit: 240, before: 300 });
});

test('opaque cursor keeps independent stable message and turn boundaries', () => {
  const encoded = encodeHistoryCursor({
    endOffset: 812345,
    messageBefore: 120,
    turnBefore: 94,
    fileKey: 'a'.repeat(64),
    boundaryHash: 'b'.repeat(64),
  });
  assert.deepEqual(decodeHistoryCursor(encoded), {
    endOffset: 812345,
    messageBefore: 120,
    turnBefore: 94,
    fileKey: 'a'.repeat(64),
    boundaryHash: 'b'.repeat(64),
  });
});

test('opaque cursor rejects malformed or incomplete anchors', () => {
  assert.throws(() => decodeHistoryCursor('not-json'), /invalid/i);
  assert.throws(() => encodeHistoryCursor({ endOffset: 5 }), /incomplete/i);
});

test('stable snapshot cursor does not skip rows when realtime appends between pages', () => {
  const original = Array.from({ length: 500 }, (_, index) => `row-${index}`);
  const first = pageHistorySuffix(original, { limit: 120, before: 0 });
  const encoded = encodeHistoryCursor({
    // The production cursor stores a byte boundary. A row boundary is used in
    // this pure test to exercise the same immutable-prefix invariant.
    endOffset: original.length,
    messageBefore: first.nextBefore,
    turnBefore: first.nextBefore,
    fileKey: 'c'.repeat(64),
    boundaryHash: 'd'.repeat(64),
  });
  const live = original.concat(Array.from({ length: 5 }, (_, index) => `row-${500 + index}`));
  const cursor = decodeHistoryCursor(encoded);
  const second = pageHistorySuffix(live.slice(0, cursor.endOffset), {
    limit: 120,
    before: cursor.messageBefore,
  });
  assert.deepEqual(second.items, original.slice(260, 380));
  assert.deepEqual(second.items.concat(first.items).concat(live.slice(500)), live.slice(260));
});
