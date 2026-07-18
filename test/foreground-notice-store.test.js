'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ForegroundNoticeStore,
  sanitizeNotice,
} = require('../lib/foreground-notice-store');

function fixtureNotice(index, overrides = {}) {
  return {
    eventKey: `thread-a:running:turn-${index}:private-message-${index}`,
    status: index % 2 ? 'running' : 'complete',
    tone: 'private-tone',
    title: 'untrusted private title',
    message: `SECRET_MESSAGE_BODY_${index}`,
    threadId: 'thread-a',
    threadTitle: '公开任务标题',
    durationMs: index * 1000,
    at: `2026-07-18T00:00:${String(index).padStart(2, '0')}.000Z`,
    raw: { subagentMessage: `PRIVATE_SUBAGENT_${index}` },
    ...overrides,
  };
}

test('each client cursor reads the same bounded notice stream independently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-notices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ForegroundNoticeStore({ file: path.join(dir, 'notices.json') });
  store.commitObservation([], Array.from({ length: 12 }, (_value, index) => fixtureNotice(index + 1)));

  const clientA = store.readAfter(0, { limit: 5 });
  const clientB = store.readAfter(0, { limit: 5 });
  assert.deepEqual(clientA.notices.map(row => row.cursor), [1, 2, 3, 4, 5]);
  assert.deepEqual(clientB.notices, clientA.notices);
  assert.equal(clientA.hasMore, true);
  assert.equal(clientA.nextCursor, 5);
  assert.deepEqual(store.readAfter(clientA.nextCursor, { limit: 10 }).notices.map(row => row.cursor),
    [6, 7, 8, 9, 10, 11, 12]);
});

test('notice cursor and snapshot recover across store reconstruction without duplicate events', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-notices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notices.json');
  const first = new ForegroundNoticeStore({ file });
  first.commitObservation([{ id: 'thread-a', runtimeStatus: 'running', runtimeFinalText: 'SECRET_FINAL' }], [fixtureNotice(1)]);

  const recovered = new ForegroundNoticeStore({ file });
  assert.equal(recovered.getSnapshot().ready, true);
  assert.equal(recovered.getSnapshot().threads[0].runtimeFinalText, undefined);
  assert.deepEqual(recovered.readAfter(0).notices.map(row => row.cursor), [1]);
  assert.equal(recovered.commitObservation(recovered.getSnapshot().threads, [fixtureNotice(1)]).length, 0);
  assert.deepEqual(recovered.commitObservation([], [fixtureNotice(2)]).map(row => row.cursor), [2]);
});

test('bounded retention reports an explicit reset instead of silently skipping a burst', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-notices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ForegroundNoticeStore({ file: path.join(dir, 'notices.json'), capacity: 16 });
  store.commitObservation([], Array.from({ length: 20 }, (_value, index) => fixtureNotice(index + 1)));

  const page = store.readAfter(1, { limit: 5 });
  assert.equal(page.oldestCursor, 5);
  assert.equal(page.latestCursor, 20);
  assert.equal(page.resetRequired, true);
  assert.deepEqual(page.notices.map(row => row.cursor), [5, 6, 7, 8, 9]);
  assert.equal(page.hasMore, true);

  const initial = store.readAfter(0, { limit: 5 });
  assert.equal(initial.resetRequired, true);
  assert.deepEqual(initial.notices.map(row => row.cursor), [5, 6, 7, 8, 9]);

  const ahead = store.readAfter(9999, { limit: 5 });
  assert.equal(ahead.resetRequired, true);
  assert.equal(ahead.nextCursor, 20);
  assert.deepEqual(ahead.notices, []);
});

test('persisted and published notices are allowlisted and never retain arbitrary message or subagent bodies', () => {
  const notice = sanitizeNotice(fixtureNotice(1));
  const serialized = JSON.stringify(notice);
  assert.doesNotMatch(serialized, /SECRET_MESSAGE_BODY|PRIVATE_SUBAGENT|untrusted private title|private-tone/);
  assert.match(notice.eventKey, /^notice-[0-9a-f]{32}$/);
  assert.equal(notice.message, '“公开任务标题”开始执行。');
  assert.deepEqual(Object.keys(notice).sort(), [
    'at', 'durationMs', 'eventKey', 'message', 'status', 'threadId', 'threadTitle', 'title', 'tone',
  ]);
});
