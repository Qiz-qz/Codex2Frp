'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingRequestStore } = require('../lib/app-server/pending-request-store');

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function deepKeys(value, output = new Set()) {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach(item => deepKeys(item, output));
    return output;
  }
  for (const [key, nested] of Object.entries(value)) {
    output.add(key);
    deepKeys(nested, output);
  }
  return output;
}

function createHarness(options = {}) {
  let nowMs = options.nowMs ?? 1_752_105_600_000;
  let nextHandle = 0;
  let nextRequestId = 0;
  const responses = [];
  const store = new PendingRequestStore({
    ttlMs: options.ttlMs ?? 60_000,
    maxEntries: options.maxEntries ?? 8,
    now: () => nowMs,
    createHandle: () => `opaque-${++nextHandle}`,
  });
  return {
    store,
    responses,
    advance(ms) { nowMs += ms; },
    capture(method, params = {}) {
      return store.capture({
        method,
        params: { threadId: THREAD, ...params },
        requestId: params.requestId ?? `server-request-${++nextRequestId}`,
        connectionEpoch: params.connectionEpoch ?? 1,
        respond(result) {
          responses.push(result);
          return { accepted: true };
        },
      });
    },
  };
}

test('captures only supported requests and exposes privacy-safe thread-scoped DTOs', () => {
  const harness = createHarness();
  harness.capture('item/commandExecution/requestApproval', {
    itemId: 'SECRET_ITEM_ID', command: 'SECRET_COMMAND', cwd: 'E:\\SECRET_CWD', token: 'SECRET_TOKEN',
  });
  harness.capture('item/fileChange/requestApproval', {
    itemId: 'SECRET_FILE_ITEM', path: 'E:\\SECRET_PATH\\file.txt',
  });
  harness.capture('item/permissions/requestApproval', {
    requestId: 'SECRET_REQUEST_ID',
    permissions: { network: true, fileSystem: { read: ['E:\\SECRET_PATH'] } },
  });
  harness.capture('item/tool/requestUserInput', {
    itemId: 'SECRET_INPUT_ITEM',
    questions: [{
      id: 'SECRET_QUESTION_ID',
      header: '选择方式',
      question: '请选择下一步',
      options: [{ label: '继续', description: '继续执行' }],
    }],
  });
  harness.capture('mcpServer/elicitation/request', {
    requestId: 'SECRET_ELICITATION_ID',
    message: '请填写授权信息',
    requestedSchema: {
      type: 'object',
      properties: {
        secret_raw_field_name: { type: 'string', title: '账号别名' },
      },
      required: ['secret_raw_field_name'],
    },
  });
  harness.capture('item/tool/call', {
    callId: 'SECRET_DYNAMIC_CALL', namespace: 'private', tool: 'secret_tool', arguments: { token: 'SECRET_TOKEN' },
  });
  assert.equal(harness.capture('future/private/request', { token: 'SECRET_UNKNOWN' }), null);

  const items = harness.store.list(THREAD);
  assert.deepEqual(items.map(item => item.kind), [
    'commandApproval',
    'fileApproval',
    'permissionsApproval',
    'userInput',
    'mcpElicitation',
    'dynamicToolRequest',
  ]);
  assert.equal(harness.store.list(OTHER_THREAD).length, 0);
  assert.deepEqual(items[3].questions[0], {
    handle: 'opaque-5',
    header: '选择方式',
    question: '请选择下一步',
    options: [{ label: '继续', description: '继续执行' }],
  });
  assert.deepEqual(items[4].fields[0], {
    handle: 'opaque-7',
    title: '账号别名',
    type: 'string',
    required: true,
  });

  const keys = deepKeys(items);
  for (const forbiddenKey of ['requestId', 'itemId', 'path', 'cwd', 'command', 'token', 'params']) {
    assert.equal(keys.has(forbiddenKey), false, `public DTO must omit ${forbiddenKey}`);
  }
  const serialized = JSON.stringify(items);
  for (const forbiddenValue of ['SECRET_', 'secret_raw_field_name', THREAD]) {
    assert.equal(serialized.includes(forbiddenValue), false, `public DTO must hide ${forbiddenValue}`);
  }
});

test('strictly maps approval decisions and resolves each handle once', async () => {
  const harness = createHarness();
  const command = harness.capture('item/commandExecution/requestApproval');
  const file = harness.capture('item/fileChange/requestApproval');
  const permissions = harness.capture('item/permissions/requestApproval', {
    permissions: { network: true, fileSystem: { read: ['E:\\private'] } },
  });

  await harness.store.respond(THREAD, command.handle, { decision: 'acceptForSession' });
  await harness.store.respond(THREAD, file.handle, { decision: 'decline' });
  await harness.store.respond(THREAD, permissions.handle, { decision: 'accept' });
  assert.deepEqual(harness.responses, [
    { decision: 'acceptForSession' },
    { decision: 'decline' },
    { permissions: { network: true, fileSystem: { read: ['E:\\private'] } }, scope: 'turn' },
  ]);

  await assert.rejects(
    harness.store.respond(THREAD, command.handle, { decision: 'accept' }),
    error => error && error.code === 'PENDING_REQUEST_RESOLVED',
  );
  const invalid = harness.capture('item/fileChange/requestApproval');
  await assert.rejects(
    harness.store.respond(THREAD, invalid.handle, { decision: 'approveEverything' }),
    error => error && error.code === 'PENDING_REQUEST_RESPONSE_INVALID',
  );
  assert.equal(harness.store.list(THREAD).some(item => item.handle === invalid.handle), true);
});

test('approval DTO ignores unproven availableDecisions fields and follows the installed schema', async () => {
  const harness = createHarness();
  const command = harness.capture('item/commandExecution/requestApproval', {
    availableDecisions: ['accept', 'decline', { unsupported: true }, 'futureDecision'],
  });
  assert.deepEqual(command.decisions, ['accept', 'acceptForSession', 'decline', 'cancel']);
  await harness.store.respond(THREAD, command.handle, { decision: 'acceptForSession' });
});

test('maps user-input and MCP answers through opaque field handles', async () => {
  const harness = createHarness();
  const input = harness.capture('item/tool/requestUserInput', {
    questions: [
      { id: 'internal-q1', header: '模式', question: '选择模式', options: [{ label: '安全' }] },
      { id: 'internal-q2', header: '说明', question: '填写说明' },
    ],
  });
  const elicitation = harness.capture('mcpServer/elicitation/request', {
    message: '填写资料',
    requestedSchema: {
      type: 'object',
      properties: {
        internal_name: { type: 'string', title: '名称' },
        internal_count: { type: 'number', title: '数量' },
      },
      required: ['internal_name'],
    },
  });

  await harness.store.respond(THREAD, input.handle, {
    answers: {
      [input.questions[0].handle]: ['安全'],
      [input.questions[1].handle]: ['fixture note'],
    },
  });
  await harness.store.respond(THREAD, elicitation.handle, {
    action: 'accept',
    values: {
      [elicitation.fields[0].handle]: 'fixture',
      [elicitation.fields[1].handle]: 2,
    },
  });
  assert.deepEqual(harness.responses, [
    {
      answers: {
        'internal-q1': { answers: ['安全'] },
        'internal-q2': { answers: ['fixture note'] },
      },
    },
    { action: 'accept', content: { internal_name: 'fixture', internal_count: 2 } },
  ]);

  const invalidInput = harness.capture('item/tool/requestUserInput', {
    questions: [{ id: 'internal-q3', header: '确认', question: '是否继续' }],
  });
  await assert.rejects(
    harness.store.respond(THREAD, invalidInput.handle, {
      answers: { unknownFieldHandle: ['继续'] },
    }),
    error => error && error.code === 'PENDING_REQUEST_RESPONSE_INVALID',
  );
  assert.equal(harness.store.list(THREAD).some(item => item.handle === invalidInput.handle), true);

  const declinedElicitation = harness.capture('mcpServer/elicitation/request', {
    message: '可拒绝的请求',
  });
  await harness.store.respond(THREAD, declinedElicitation.handle, { action: 'decline' });
  assert.deepEqual(harness.responses.at(-1), { action: 'decline' });
});

test('maps real structured command approval decisions only to the exact server proposals', async () => {
  const harness = createHarness();
  const execAmendment = ['git', 'status'];
  const networkAmendment = { host: 'example.test', action: 'allow' };
  const command = harness.capture('item/commandExecution/requestApproval', {
    proposedExecpolicyAmendment: execAmendment,
    proposedNetworkPolicyAmendments: networkAmendment,
  });

  assert.deepEqual(command.decisions, [
    'accept',
    'acceptForSession',
    'acceptWithExecpolicyAmendment',
    'applyNetworkPolicyAmendment',
    'decline',
    'cancel',
  ]);
  await harness.store.respond(THREAD, command.handle, {
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execAmendment } },
  });
  assert.deepEqual(harness.responses.at(-1), {
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execAmendment } },
  });

  const network = harness.capture('item/commandExecution/requestApproval', {
    proposedNetworkPolicyAmendments: networkAmendment,
  });
  await assert.rejects(
    harness.store.respond(THREAD, network.handle, {
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'attacker.test' } } },
    }),
    error => error && error.code === 'PENDING_REQUEST_RESPONSE_INVALID',
  );
  assert.equal(harness.store.list(THREAD).some(item => item.handle === network.handle), true);
  await harness.store.respond(THREAD, network.handle, {
    decision: { applyNetworkPolicyAmendment: { network_policy_amendment: networkAmendment } },
  });
});

test('approval DTO exposes only safe decision context and never raw commands or absolute paths', () => {
  const harness = createHarness();
  harness.capture('item/commandExecution/requestApproval', {
    command: 'powershell -Command "$env:SECRET=token; Get-Content E:\\private\\secret.txt"',
    commandActions: [
      { type: 'read', command: 'Get-Content E:\\private\\secret.txt' },
      { type: 'unknown', command: 'curl https://example.test/?token=secret' },
    ],
    cwd: 'E:\\workspace\\safe-project',
    reason: 'Needs access to E:\\private\\secret.txt with token=secret',
  });
  harness.capture('item/fileChange/requestApproval', {
    path: 'E:\\private\\report.txt',
    grantRoot: 'E:\\private',
    changes: [{ path: 'E:\\private\\report.txt', kind: { type: 'update' } }],
  });
  harness.capture('item/permissions/requestApproval', {
    reason: 'Needs E:\\private and token=secret',
    permissions: { network: true, fileSystem: { read: ['E:\\private'] } },
  });

  const serialized = JSON.stringify(harness.store.list(THREAD));
  for (const secret of ['Get-Content', 'curl ', 'SECRET', 'token=secret', 'E:\\\\private', 'secret.txt']) {
    assert.equal(serialized.includes(secret), false, `safe DTO leaked ${secret}`);
  }
  const [command, file, permissions] = harness.store.list(THREAD);
  assert.deepEqual(command.context, {
    actionCount: 2,
    actionKinds: ['read', 'other'],
    workingDirectoryName: 'safe-project',
    reason: '需要额外授权才能执行此命令。',
  });
  assert.equal(file.context.fileName, 'report.txt');
  assert.equal(file.context.grantRootName, 'private');
  assert.equal(file.context.changeCount, 1);
  assert.equal(permissions.reason, '需要额外权限。');
});

test('server resolution and connection epoch closure remove only the matching private request', async () => {
  const harness = createHarness();
  const first = harness.capture('item/commandExecution/requestApproval', {
    requestId: 'same-id', connectionEpoch: 1,
  });
  const second = harness.capture('item/fileChange/requestApproval', {
    requestId: 'same-id', connectionEpoch: 2,
  });

  assert.equal(harness.store.resolveServerRequest({
    requestId: 'same-id', connectionEpoch: 1, threadId: THREAD,
  }), true);
  assert.deepEqual(harness.store.list(THREAD).map(item => item.handle), [second.handle]);
  await assert.rejects(
    harness.store.respond(THREAD, first.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_RESOLVED' && error.statusCode === 409,
  );

  assert.equal(harness.store.expireConnectionEpoch(2), 1);
  assert.deepEqual(harness.store.list(THREAD), []);
  await assert.rejects(
    harness.store.respond(THREAD, second.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_EXPIRED' && error.statusCode === 410,
  );
});

test('failed upstream responses preserve retryable entries and classify terminal races', async () => {
  const store = new PendingRequestStore({ createHandle: () => 'opaque-retry' });
  let attempt = 0;
  const request = store.capture({
    method: 'item/fileChange/requestApproval',
    params: { threadId: THREAD },
    requestId: 'retry-id',
    connectionEpoch: 7,
    respond() {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('temporary conflict'), { code: 'APP_SERVER_RPC_ERROR' });
      return true;
    },
  });
  await assert.rejects(
    store.respond(THREAD, request.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_CONFLICT' && error.statusCode === 409,
  );
  assert.equal(store.list(THREAD).length, 1);
  await store.respond(THREAD, request.handle, { decision: 'decline' });
  assert.equal(store.list(THREAD).length, 0);

  const resolved = new PendingRequestStore({ createHandle: () => 'opaque-resolved' });
  const resolvedRequest = resolved.capture({
    method: 'item/commandExecution/requestApproval', params: { threadId: THREAD },
    requestId: 'resolved-id', connectionEpoch: 8,
    respond() { throw Object.assign(new Error('already resolved'), { code: 'APP_SERVER_PROTOCOL_ERROR' }); },
  });
  await assert.rejects(
    resolved.respond(THREAD, resolvedRequest.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_RESOLVED',
  );
  assert.equal(resolved.list(THREAD).length, 0);
});

test('dynamic tool requests resolve with exact installed response shape and are removed', async () => {
  const harness = createHarness();
  const request = harness.capture('item/tool/call', { callId: 'private-call', tool: 'private-tool', arguments: { token: 'private' } });
  assert.equal(request.kind, 'dynamicToolRequest');
  await harness.store.respond(THREAD, request.handle, {
    success: true,
    contentItems: [{ type: 'inputText', text: 'public result' }, { type: 'inputImage', imageUrl: 'https://example.test/image.png' }],
  });
  assert.deepEqual(harness.responses.at(-1), {
    success: true,
    contentItems: [{ type: 'inputText', text: 'public result' }, { type: 'inputImage', imageUrl: 'https://example.test/image.png' }],
  });
  assert.equal(harness.store.list(THREAD).some(item => item.handle === request.handle), false);

  const failed = harness.capture('item/tool/call');
  await harness.store.respond(THREAD, failed.handle, { success: false, contentItems: [] });
  assert.deepEqual(harness.responses.at(-1), { success: false, contentItems: [] });
});

test('keeps live requests until server resolution and fails closed at capacity without cancelling', async () => {
  const harness = createHarness({ ttlMs: 1000, maxEntries: 2 });
  const first = harness.capture('item/commandExecution/requestApproval');
  const second = harness.capture('item/fileChange/requestApproval');
  assert.equal(harness.capture('item/permissions/requestApproval'), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.responses, [], 'capacity pressure must not decide a live server request');

  await assert.rejects(
    harness.store.respond(OTHER_THREAD, first.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_THREAD_MISMATCH',
  );
  harness.advance(1001);
  assert.deepEqual(harness.store.list(THREAD).map(item => item.handle), [first.handle, second.handle]);
  assert.equal(harness.capture('item/permissions/requestApproval'), null);
});
