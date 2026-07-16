'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DesktopControlRuntime } = require('../lib/control/desktop-control-runtime');

function independentRuntime() {
  const calls = [];
  const service = {
    listThreads(params) { calls.push(['listThreads', params]); return { data: [] }; },
    startTurn(params) { calls.push(['independentStartTurn', params]); return { turn: { id: 'wrong' } }; },
  };
  return {
    calls,
    getMeta() {
      return {
        apiVersion: 3,
        appServer: { state: 'ready', pid: 22 },
        capabilities: {
          operations: {
            'thread.list': { mode: 'rpc', ready: true, source: 'appServer' },
            'turn.start': { mode: 'rpc', ready: true, source: 'appServer' },
          },
        },
      };
    },
    withService(operation) { return operation(service); },
    stop() { return true; },
  };
}

test('control runtime routes desktop mutations to renderer RPC and keeps independent reads explicit', async () => {
  const independent = independentRuntime();
  const desktopCalls = [];
  const desktopAdapter = {
    getStatus: () => ({ state: 'ready', ready: true, source: 'desktopInternalRpc' }),
    startTurn(params, control) {
      desktopCalls.push(['startTurn', params, control]);
      return { turn: { id: 'desktop-turn' } };
    },
  };
  const runtime = new DesktopControlRuntime({ independentRuntime: independent, desktopAdapter });

  const started = await runtime.withService(service => service.startTurn(
    { threadId: 'thread-1', input: [] },
    { observedThreadId: 'thread-1' },
  ));
  const listed = await runtime.withService(service => service.listThreads({ limit: 10 }));

  assert.deepEqual(started, {
    status: 'confirmed',
    operation: 'turn.start',
    observation: { turnId: 'desktop-turn' },
  });
  assert.deepEqual(listed, { data: [] });
  assert.deepEqual(desktopCalls.map(call => call[0]), ['startTurn']);
  assert.deepEqual(independent.calls.map(call => call[0]), ['listThreads']);
});

test('capabilities distinguish desktop internal RPC from the independent app-server', () => {
  const independent = independentRuntime();
  const desktopAdapter = {
    getStatus: () => ({ state: 'unavailable', ready: false, source: 'desktopInternalRpc', reason: 'cdp_unavailable' }),
    startTurn() {},
  };
  const runtime = new DesktopControlRuntime({ independentRuntime: independent, desktopAdapter });
  const meta = runtime.getMeta();

  assert.deepEqual(meta.independentAppServer, { state: 'ready', pid: 22 });
  assert.equal(meta.desktopInternalRpc.ready, false);
  assert.equal(meta.capabilities.operations['thread.list'].source, 'independentAppServer');
  assert.equal(meta.capabilities.operations['thread.list'].ready, true);
  assert.equal(meta.capabilities.operations['turn.start'].source, 'desktopInternalRpc');
  assert.equal(meta.capabilities.operations['turn.start'].ready, false);
  assert.equal(meta.capabilities.operations['turn.start'].reason, 'cdp_unavailable');
});
