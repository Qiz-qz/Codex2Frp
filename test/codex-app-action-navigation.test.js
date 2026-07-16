'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildShowThreadExpression,
  buildShowHomeExpression,
  buildCurrentThreadExpression,
  normalizeShowHomeResult,
  normalizeShowThreadResult,
} = require('../lib/control/codex-app-action-navigation');

test('show-thread expression uses the renderer-bound Codex app action and exact route readback', () => {
  const threadId = '019f6a9d-9a8f-75f1-9d7e-711f785439c3';
  const expression = buildShowThreadExpression(threadId);

  assert.match(expression, /rpc-QupjVyo7\.js/);
  assert.match(expression, /type:\s*'app\.get_summary'/);
  assert.match(expression, /type:\s*'windows\.show_thread'/);
  assert.match(expression, new RegExp(threadId));
  assert.match(expression, /after\?\.window\?\.route\?\.threadId === threadId/);
  assert.doesNotMatch(expression, /codex:\/\/threads|data-app-action-sidebar-thread-id|\.click\(/);
});

test('show-home expression matches the native Codex plus action and confirms the home route', () => {
  const expression = buildShowHomeExpression();
  assert.match(expression, /type:\s*'windows\.show_home'/);
  assert.match(expression, /route\?\.kind === 'home'/);
  assert.match(expression, /route\?\.pathname === '\/'/);
  assert.doesNotMatch(expression, /thread\/start|codex:\/\/|\.click\(/);

  assert.equal(normalizeShowHomeResult({ ok: true, afterRoute: { kind: 'local-thread' } }).ok, false);
  assert.deepEqual(normalizeShowHomeResult({
    ok: true,
    windowId: 'current',
    afterRoute: { kind: 'home', pathname: '/' },
  }), {
    ok: true,
    windowId: 'current',
    route: { kind: 'home', pathname: '/' },
    method: 'codex-app-action',
  });
});

test('current-thread expression reads the authoritative in-window route summary', () => {
  const expression = buildCurrentThreadExpression();
  assert.match(expression, /type:\s*'app\.get_summary'/);
  assert.match(expression, /summary\?\.window\?\.route\?\.threadId/);
  assert.match(expression, /#\/local\//);
  assert.doesNotMatch(expression, /data-app-action-sidebar-thread-id/);
});

test('show-thread result only succeeds with an exact route UUID match', () => {
  const threadId = '019f6a9d-9a8f-75f1-9d7e-711f785439c3';
  assert.deepEqual(normalizeShowThreadResult({
    ok: true,
    threadId,
    windowId: 'current',
    afterRoute: { kind: 'local-thread', threadId },
  }, threadId), {
    ok: true,
    threadId,
    windowId: 'current',
    route: { kind: 'local-thread', threadId },
    method: 'codex-app-action',
  });

  assert.equal(normalizeShowThreadResult({
    ok: true,
    threadId,
    afterRoute: { threadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  }, threadId).ok, false);
});
