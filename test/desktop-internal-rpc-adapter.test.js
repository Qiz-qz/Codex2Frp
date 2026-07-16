'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DesktopInternalRpcAdapter,
  THREAD_START_TIMEOUT_MS,
  desktopRpcExpression,
  unwrapDesktopRpcResponse,
} = require('../lib/control/desktop-internal-rpc-adapter');

const THREAD = '11111111-2222-4333-8444-555555555555';

test('desktop RPC expression uses the installed electron bridge and matches one response id', () => {
  const expression = desktopRpcExpression({
    hostId: 'local',
    request: { id: 41, method: 'model/list', params: {} },
    timeoutMs: 2500,
  });
  assert.match(expression, /window\.electronBridge/);
  assert.match(expression, /sendMessageFromView/);
  assert.match(expression, /type:\s*['"]mcp-request['"]/);
  assert.match(expression, /type\s*!==\s*['"]mcp-response['"]/);
  assert.match(expression, /message\.id/);
  assert.match(expression, /data\.message\s*\|\|\s*data\.response/);
  assert.doesNotMatch(expression, /querySelector|\.click\(|dispatchEvent\(new (?:Mouse|Pointer|Keyboard)Event/);
});

test('thread start allows the current desktop enough time to initialize a new task', async () => {
  const observations = [];
  const adapter = new DesktopInternalRpcAdapter({
    timeoutMs: 4500,
    evaluate: async (expression, options) => {
      observations.push({ expression, options });
      return { ok: true, result: { thread: { id: THREAD } } };
    },
  });

  await adapter.startThread({ cwd: 'E:\\workspace' });
  assert.equal(observations[0].options.timeoutMs, THREAD_START_TIMEOUT_MS + 250);
  assert.match(observations[0].expression, new RegExp(`const timeoutMs = ${THREAD_START_TIMEOUT_MS}`));
});

test('desktop response parser accepts both installed renderer wrappers and rejects cross-host replies', () => {
  assert.deepEqual(unwrapDesktopRpcResponse({
    type: 'mcp-response',
    hostId: 'local',
    message: { id: 41, result: { ok: 'message' } },
  }, 'local', 41), { id: 41, result: { ok: 'message' } });
  assert.deepEqual(unwrapDesktopRpcResponse({
    type: 'mcp-response',
    hostId: 'local',
    response: { id: 41, result: { ok: 'response' } },
  }, 'local', 41), { id: 41, result: { ok: 'response' } });
  assert.equal(unwrapDesktopRpcResponse({
    type: 'mcp-response',
    hostId: 'remote',
    message: { id: 41, result: {} },
  }, 'local', 41), null);
});

test('desktop adapter maps every supported control to the desktop renderer RPC protocol', async () => {
  const calls = [];
  const adapter = new DesktopInternalRpcAdapter({
    evaluate: async expression => {
      calls.push(expression);
      return { ok: true, result: { thread: { id: THREAD }, turn: { id: 'turn-1' } } };
    },
  });

  await adapter.listModels({ limit: 20 });
  await adapter.startThread({ cwd: 'E:\\workspace' });
  await adapter.readThread({ threadId: THREAD, includeTurns: true });
  await adapter.updateThreadSettings({ threadId: THREAD, model: 'gpt-5.5', effort: 'high' });
  await adapter.startTurn({ threadId: THREAD, input: [{ type: 'text', text: 'hello' }] });
  await adapter.interruptTurn({ threadId: THREAD, turnId: 'turn-1' });

  const methods = calls.map(expression => JSON.parse(
    expression.match(/const request = (\{.*?\});\s*const timeoutMs/s)[1],
  ).method);
  assert.deepEqual(methods, [
    'model/list',
    'thread/start',
    'thread/read',
    'thread/settings/update',
    'turn/start',
    'turn/interrupt',
  ]);
});

test('desktop settings persist one confirmed target only after the renderer RPC succeeds', async () => {
  const confirmations = [];
  const adapter = new DesktopInternalRpcAdapter({
    evaluate: async () => ({ ok: true, result: { accepted: true } }),
    onSettingsConfirmed: async (params, result) => {
      confirmations.push({ params, result });
      return {
        source: 'desktopInternalRpc',
        threadId: params.threadId,
        model: params.model,
        effort: params.effort,
        serviceTier: params.serviceTier,
      };
    },
  });

  const result = await adapter.updateThreadSettings({
    threadId: THREAD,
    model: 'gpt-5.5',
    effort: 'high',
    serviceTier: 'priority',
  });

  assert.deepEqual(confirmations, [{
    params: { threadId: THREAD, model: 'gpt-5.5', effort: 'high', serviceTier: 'priority' },
    result: { accepted: true },
  }]);
  assert.deepEqual(result, {
    accepted: true,
    target: {
      source: 'desktopInternalRpc',
      threadId: THREAD,
      model: 'gpt-5.5',
      effort: 'high',
      serviceTier: 'priority',
    },
  });
});

test('desktop settings normalize model identity before both RPC and confirmation persistence', async () => {
  const requests = [];
  const confirmations = [];
  const adapter = new DesktopInternalRpcAdapter({
    normalizeSettings: params => ({ ...params, model: 'gpt-5.6-sol' }),
    evaluate: async expression => {
      requests.push(JSON.parse(expression.match(/const request = (\{.*?\});\s*const timeoutMs/s)[1]));
      return { ok: true, result: { accepted: true } };
    },
    onSettingsConfirmed: async params => {
      confirmations.push(params);
      return { source: 'desktopInternalRpc', settings: params };
    },
  });

  await adapter.updateThreadSettings({ threadId: THREAD, model: 'GPT-5.6-Sol' });

  assert.equal(requests[0].params.model, 'gpt-5.6-sol');
  assert.equal(confirmations[0].model, 'gpt-5.6-sol');
});

test('desktop settings never persist a confirmation when the renderer RPC fails', async () => {
  let confirmations = 0;
  const adapter = new DesktopInternalRpcAdapter({
    evaluate: async () => ({ ok: false, code: 'DESKTOP_RPC_ERROR', message: 'rejected' }),
    onSettingsConfirmed: async () => { confirmations += 1; },
  });

  await assert.rejects(
    adapter.updateThreadSettings({ threadId: THREAD, model: 'gpt-5.5' }),
    error => error.code === 'DESKTOP_RPC_ERROR',
  );
  assert.equal(confirmations, 0);
});

test('desktop adapter fails honestly when CDP or the renderer bridge is unavailable', async () => {
  const cdpMissing = new DesktopInternalRpcAdapter({
    evaluate: async () => { throw new Error('target missing'); },
  });
  await assert.rejects(
    cdpMissing.listModels({}),
    error => error.code === 'DESKTOP_INTERNAL_RPC_UNAVAILABLE' && error.statusCode === 503,
  );
  assert.equal(cdpMissing.getStatus().ready, false);

  const bridgeMissing = new DesktopInternalRpcAdapter({
    evaluate: async () => ({ ok: false, code: 'DESKTOP_BRIDGE_UNAVAILABLE', message: 'bridge missing' }),
  });
  await assert.rejects(
    bridgeMissing.readThread({ threadId: THREAD }),
    error => error.code === 'DESKTOP_BRIDGE_UNAVAILABLE' && error.statusCode === 503,
  );
  assert.equal(bridgeMissing.getStatus().ready, false);
});

test('a matched desktop RPC business error does not mark the healthy transport unavailable', async () => {
  let call = 0;
  const adapter = new DesktopInternalRpcAdapter({
    evaluate: async () => (++call === 1
      ? { ok: true, result: { data: [] } }
      : { ok: false, code: 'DESKTOP_RPC_ERROR', message: 'invalid params', error: { code: -32602 } }),
  });
  await adapter.listModels({});
  await assert.rejects(adapter.readThread({ threadId: THREAD }), error => error.code === 'DESKTOP_RPC_ERROR');
  assert.equal(adapter.getStatus().ready, true);
});

test('protected desktop task remains readable but cannot be mutated through internal RPC', async () => {
  let evaluations = 0;
  const adapter = new DesktopInternalRpcAdapter({
    guard: {
      assertAllowed(context) {
        if (context.action !== 'thread.read') {
          const error = new Error('protected');
          error.code = 'PROTECTED_THREAD';
          error.statusCode = 403;
          throw error;
        }
      },
    },
    evaluate: async () => {
      evaluations += 1;
      return { ok: true, result: { thread: { id: THREAD } } };
    },
  });
  await adapter.readThread({ threadId: THREAD });
  await assert.rejects(
    adapter.startTurn({ threadId: THREAD, input: [{ type: 'text', text: 'blocked' }] }),
    error => error.code === 'PROTECTED_THREAD',
  );
  assert.equal(evaluations, 1, 'guard rejects mutation before any desktop RPC request');
});

test('desktop adapter installs request observation before sending renderer RPC', async () => {
  const order = [];
  const adapter = new DesktopInternalRpcAdapter({
    beforeInvoke: async descriptor => order.push(`before:${descriptor.method}`),
    evaluate: async () => {
      order.push('evaluate');
      return { ok: true, result: { turn: { id: 'turn-1' } } };
    },
  });
  await adapter.startTurn({ threadId: THREAD, input: [{ type: 'text', text: 'test' }] });
  assert.deepEqual(order, ['before:turn/start', 'evaluate']);
});

test('desktop adapter does not send RPC when request observation cannot be installed', async () => {
  let evaluations = 0;
  const adapter = new DesktopInternalRpcAdapter({
    beforeInvoke: async () => { throw new Error('renderer listener unavailable'); },
    evaluate: async () => { evaluations += 1; return { ok: true, result: {} }; },
  });
  await assert.rejects(adapter.startTurn({ threadId: THREAD, input: [] }), /renderer listener unavailable/);
  assert.equal(evaluations, 0);
});
