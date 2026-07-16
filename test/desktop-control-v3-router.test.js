'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { V3ApiRouter } = require('../lib/api/v3-router');
const { DesktopControlRuntime } = require('../lib/control/desktop-control-runtime');

const THREAD = '11111111-2222-4333-8444-555555555555';

function createRuntime() {
  const calls = [];
  const desktopAdapter = {
    getStatus: () => ({ state: 'ready', ready: true, source: 'desktopInternalRpc' }),
    startThread(params) { calls.push(['startThread', params]); return { thread: { id: THREAD } }; },
    readThread(params) { calls.push(['readThread', params]); return { thread: { id: THREAD, turns: [] } }; },
    updateThreadSettings(params) {
      calls.push(['updateThreadSettings', params]);
      return {
        target: {
          source: 'desktopInternalRpc',
          threadId: params.threadId,
          settings: { model: params.model, effort: params.effort },
        },
      };
    },
    startTurn(params) { calls.push(['startTurn', params]); return { turn: { id: 'turn-1' } }; },
    interruptTurn(params) { calls.push(['interruptTurn', params]); return {}; },
  };
  const independentRuntime = {
    getMeta: () => ({ apiVersion: 3, appServer: { state: 'ready' }, capabilities: { operations: {} } }),
    withService: operation => operation({}),
  };
  return {
    calls,
    runtime: new DesktopControlRuntime({ independentRuntime, desktopAdapter }),
  };
}

test('v3 desktop controls preserve confirmed response envelopes for every mobile mutation', async () => {
  const { runtime, calls } = createRuntime();
  const router = new V3ApiRouter({ runtime });

  const created = await router.handle({
    method: 'POST',
    url: '/codex/v3/threads',
    body: { params: { cwd: 'E:\\workspace' } },
  });
  const settings = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'settings', params: { model: 'gpt-5.5', effort: 'high' } },
  });
  const started = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'startTurn', params: { input: [{ type: 'text', text: 'hello' }] } },
  });
  const interrupted = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'interrupt', params: { turnId: 'turn-1' } },
  });

  assert.deepEqual(created.body, {
    status: 'confirmed',
    operation: 'thread.start',
    observation: { threadId: THREAD },
  });
  assert.deepEqual(settings.body, {
    status: 'confirmed',
    operation: 'thread.settings',
    observation: {
      source: 'desktopInternalRpc',
      readbackSupported: false,
      settings: { model: 'gpt-5.5', effort: 'high' },
      target: {
        source: 'desktopInternalRpc',
        threadId: THREAD,
        settings: { model: 'gpt-5.5', effort: 'high' },
      },
    },
  });
  assert.deepEqual(started.body, {
    status: 'confirmed',
    operation: 'turn.start',
    observation: { turnId: 'turn-1' },
  });
  assert.deepEqual(interrupted.body, {
    status: 'confirmed',
    operation: 'turn.interrupt',
    observation: {},
  });
  assert.deepEqual(calls.map(call => call[0]), [
    'startThread', 'readThread', 'updateThreadSettings', 'startTurn', 'interruptTurn',
  ]);
});
