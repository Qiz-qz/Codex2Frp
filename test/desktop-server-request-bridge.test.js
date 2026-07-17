'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingRequestStore } = require('../lib/app-server/pending-request-store');
const {
  DesktopServerRequestBridge,
  installExpression,
  respondExpression,
} = require('../lib/control/desktop-server-request-bridge');

const THREAD = '11111111-2222-4333-8444-555555555555';

test('renderer bridge expressions persistently capture only modern requests and answer through mcp-response', () => {
  const install = installExpression({ hostId: 'local' });
  assert.match(install, /__codex2frpServerRequestBridgeV1/);
  assert.match(install, /item\/commandExecution\/requestApproval/);
  assert.match(install, /item\/fileChange\/requestApproval/);
  assert.match(install, /item\/permissions\/requestApproval/);
  assert.match(install, /serverRequest\/resolved/);
  assert.match(install, /codex-message-to-view/);
  assert.doesNotMatch(install, /querySelector|\.click\(|MouseEvent|PointerEvent/);

  const response = respondExpression({
    hostId: 'local', instanceId: 'renderer-1', requestId: 17, result: { decision: 'decline' },
  });
  assert.match(response, /sendMessageFromView/);
  assert.match(response, /type:\s*['"]mcp-response['"]/);
  assert.match(response, /decision/);
  assert.doesNotMatch(response, /querySelector|\.click\(/);
  assert.doesNotThrow(() => new Function(`return ${install};`));
  assert.doesNotThrow(() => new Function(`return ${response};`));
});

test('renderer bridge synchronizes pending requests, preserves private ids, and reconciles disappearance', async () => {
  let requests = [{
    id: 'renderer-private-id',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD,
      cwd: 'E:\\workspace\\project',
      command: 'Get-Content E:\\private\\secret.txt',
      commandActions: [{ type: 'read', command: 'Get-Content E:\\private\\secret.txt' }],
    },
  }];
  const evaluations = [];
  const evaluate = async expression => {
    evaluations.push(expression);
    if (expression.includes('const expectedInstanceId')) return { ok: true };
    return { ok: true, instanceId: 'renderer-1', requests };
  };
  let handleSequence = 0;
  const store = new PendingRequestStore({ createHandle: () => `opaque-renderer-${++handleSequence}` });
  const bridge = new DesktopServerRequestBridge({ evaluate, store, hostId: 'local' });

  await bridge.synchronize();
  const [pending] = store.list(THREAD);
  assert.equal(pending.kind, 'commandApproval');
  assert.equal(JSON.stringify(pending).includes('renderer-private-id'), false);
  assert.equal(JSON.stringify(pending).includes('Get-Content'), false);

  await store.respond(THREAD, pending.handle, { decision: 'decline' });
  assert.equal(evaluations.some(expression => expression.includes('renderer-private-id')
    && expression.includes('mcp-response')), true);

  requests = [{
    id: 'renderer-second-id', method: 'item/fileChange/requestApproval',
    params: { threadId: THREAD, grantRoot: 'E:\\workspace' },
  }];
  await bridge.synchronize();
  assert.equal(store.list(THREAD).length, 1);
  requests = [];
  await bridge.synchronize();
  assert.equal(store.list(THREAD).length, 0);
});

test('renderer reload expires the previous bridge epoch without answering stale requests', async () => {
  let snapshot = {
    ok: true,
    instanceId: 'renderer-1',
    requests: [{
      id: 1, method: 'item/permissions/requestApproval',
      params: { threadId: THREAD, permissions: { network: true } },
    }],
  };
  const store = new PendingRequestStore({ createHandle: () => `opaque-reload-${Math.random()}`.replace('.', '') });
  const bridge = new DesktopServerRequestBridge({ evaluate: async () => snapshot, store });
  await bridge.synchronize();
  const handle = store.list(THREAD)[0].handle;

  snapshot = { ok: true, instanceId: 'renderer-2', requests: [] };
  await bridge.synchronize();
  assert.equal(store.list(THREAD).length, 0);
  await assert.rejects(
    store.respond(THREAD, handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_EXPIRED',
  );
});
