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
    error => error && error.code === 'PENDING_REQUEST_NOT_FOUND',
  );
  const invalid = harness.capture('item/fileChange/requestApproval');
  await assert.rejects(
    harness.store.respond(THREAD, invalid.handle, { decision: 'approveEverything' }),
    error => error && error.code === 'PENDING_REQUEST_RESPONSE_INVALID',
  );
  assert.equal(harness.store.list(THREAD).some(item => item.handle === invalid.handle), true);
});

test('approval DTO respects the decisions advertised by app-server', async () => {
  const harness = createHarness();
  const command = harness.capture('item/commandExecution/requestApproval', {
    availableDecisions: ['accept', 'decline', { unsupported: true }, 'futureDecision'],
  });
  assert.deepEqual(command.decisions, ['accept', 'decline']);
  await assert.rejects(
    harness.store.respond(THREAD, command.handle, { decision: 'acceptForSession' }),
    error => error && error.code === 'PENDING_REQUEST_RESPONSE_INVALID',
  );
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

test('expires requests, enforces thread ownership, and keeps capacity bounded', async () => {
  const harness = createHarness({ ttlMs: 1000, maxEntries: 2 });
  const first = harness.capture('item/commandExecution/requestApproval');
  const second = harness.capture('item/fileChange/requestApproval');
  assert.equal(harness.capture('item/permissions/requestApproval'), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.responses.at(-1), { permissions: {}, scope: 'turn' },
    'a capacity-rejected request is safely resolved instead of hanging app-server');

  await assert.rejects(
    harness.store.respond(OTHER_THREAD, first.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_THREAD_MISMATCH',
  );
  harness.advance(1001);
  assert.deepEqual(harness.store.list(THREAD), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.responses.some(result => result && result.decision === 'cancel'),
    'expired approval requests are cancelled before removal');
  await assert.rejects(
    harness.store.respond(THREAD, second.handle, { decision: 'decline' }),
    error => error && error.code === 'PENDING_REQUEST_NOT_FOUND',
  );
  assert.equal(harness.capture('item/permissions/requestApproval')?.kind, 'permissionsApproval');
});
