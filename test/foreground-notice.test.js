'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createForegroundNoticeForStatus,
  createForegroundNoticesForThreadSnapshots,
  terminalStatusKey,
} = require('../lib/foreground-notice');

test('creates local foreground notice payloads for terminal statuses only', () => {
  assert.equal(createForegroundNoticeForStatus({ status: 'running', threadId: 'abc' }), null);

  const complete = createForegroundNoticeForStatus({
    status: 'complete',
    threadId: 'abc',
    turnId: 'turn-1',
    final: 'done',
    durationMs: 65000,
  });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.tone, 'status');
  assert.equal(complete.eventKey, terminalStatusKey({ status: 'complete', threadId: 'abc', turnId: 'turn-1', final: 'done' }));
  assert.match(complete.message, /完成/);

  const interrupted = createForegroundNoticeForStatus({
    status: 'error',
    threadId: 'abc',
    turnId: 'turn-2',
    error: 'interrupted',
  });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.tone, 'error');
  assert.match(interrupted.message, /终止|中断/);
});

test('creates concise foreground notices for all thread runtime transitions', () => {
  const previous = [
    { id: 'thread-a', name: '写 README', runtimeStatus: 'idle', runtimeActive: false, runtimeUpdatedAt: '2026-06-23T08:00:00.000Z' },
    { id: 'thread-b', name: '修复按钮', runtimeStatus: 'running', runtimeActive: true, runtimeTurnId: 'turn-b1', runtimeUpdatedAt: '2026-06-23T08:01:00.000Z' },
    { id: 'thread-c', name: '截图检查', runtimeStatus: 'running', runtimeActive: true, runtimeTurnId: 'turn-c1', runtimeUpdatedAt: '2026-06-23T08:01:30.000Z' },
  ];
  const current = [
    { id: 'thread-a', name: '写 README', runtimeStatus: 'running', runtimeActive: true, runtimeTurnId: 'turn-a1', runtimeUpdatedAt: '2026-06-23T08:02:00.000Z' },
    { id: 'thread-b', name: '修复按钮', runtimeStatus: 'complete', runtimeActive: false, runtimeTurnId: 'turn-b1', runtimeStartedAt: '2026-06-23T08:01:00.000Z', runtimeCompletedAt: '2026-06-23T08:03:00.000Z' },
    { id: 'thread-c', name: '截图检查', runtimeStatus: 'error', runtimeTerminalKind: 'interrupted', runtimeActive: false, runtimeTurnId: 'turn-c1', runtimeStartedAt: '2026-06-23T08:01:30.000Z', runtimeCompletedAt: '2026-06-23T08:03:10.000Z' },
    { id: 'thread-d', name: '新线程', runtimeStatus: 'error', runtimeActive: false, runtimeTurnId: 'turn-d1', runtimeUpdatedAt: '2026-06-23T08:03:30.000Z' },
  ];

  const notices = createForegroundNoticesForThreadSnapshots(previous, current, { now: '2026-06-23T08:04:00.000Z' });

  assert.equal(notices.length, 4);
  assert.deepEqual(notices.map(item => item.status), ['running', 'complete', 'interrupted', 'error']);
  assert.match(notices[0].message, /写 README.*开始/);
  assert.match(notices[1].message, /修复按钮.*完成.*2min/);
  assert.match(notices[2].message, /截图检查.*终止/);
  assert.ok(notices.every(item => item.eventKey.includes(item.threadId)), 'each notice is independently deduplicated by thread');
  assert.ok(notices.every(item => item.title.length <= 12), 'notice titles stay short for banner display');
});

test('backend no longer exposes Huawei Push Kit cloud routes or token storage', () => {
  const root = path.resolve(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const stateStoreSource = fs.readFileSync(path.join(root, 'lib', 'state-store.js'), 'utf8');
  assert.match(serverSource, /runtimeTerminalKind/, 'server exposes terminal kind for interrupted foreground notices');
  assert.doesNotMatch(serverSource, /\/codex\/push\/register|\/codex\/push\/status|HuaweiPushClient|huaweiPushConfigFromEnv/, 'server does not expose cloud push routes');
  assert.doesNotMatch(stateStoreSource, /pushTokenHash|normalizePushDevice|sanitizePushState|defaultPushState/, 'state store does not persist Push Kit tokens');
});
