'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { V3ApiRouter } = require('../lib/api/v3-router');
const { createConfirmedControls } = require('../lib/codex/capability-state');
const { PendingRequestStore } = require('../lib/app-server/pending-request-store');
const { AttachmentStore } = require('../lib/attachments/attachment-store');
const { CommandCoordinator } = require('../lib/control/command-coordinator');
const { createProtectedThreadGuard } = require('../lib/control/protected-thread-guard');
const { TurnInputQueue } = require('../lib/queue/turn-input-queue');

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

class FakeCodexService {
  constructor() {
    this.calls = [];
    this.results = new Map();
  }

  invoke(method, params, control) {
    this.calls.push({ method, params, control });
    const result = this.results.get(method);
    if (result instanceof Error) throw result;
    return Promise.resolve(result === undefined ? { method, params } : result);
  }

  listThreads(params) { return this.invoke('listThreads', params); }
  readThread(params) { return this.invoke('readThread', params); }
  startThread(params, control) { return this.invoke('startThread', params, control); }
  resumeThread(params, control) { return this.invoke('resumeThread', params, control); }
  forkThread(params, control) { return this.invoke('forkThread', params, control); }
  archiveThread(params, control) { return this.invoke('archiveThread', params, control); }
  unarchiveThread(params, control) { return this.invoke('unarchiveThread', params, control); }
  setThreadName(params, control) { return this.invoke('setThreadName', params, control); }
  compactThread(params, control) { return this.invoke('compactThread', params, control); }
  updateThreadSettings(params, control) { return this.invoke('updateThreadSettings', params, control); }
  startTurn(params, control) { return this.invoke('startTurn', params, control); }
  interruptTurn(params, control) { return this.invoke('interruptTurn', params, control); }
  steerTurn(params, control) { return this.invoke('steerTurn', params, control); }
  listModels(params) { return this.invoke('listModels', params); }
  listCollaborationModes() { return this.invoke('listCollaborationModes', {}); }
}

class FakeRuntime {
  constructor(service = new FakeCodexService()) {
    this.service = service;
    this.withServiceCalls = 0;
    this.meta = {
      apiVersion: 3,
      appServer: { state: 'stopped', pid: null, connectionEpoch: 0 },
      capabilities: { operations: { 'thread.list': { mode: 'rpc' } } },
    };
  }

  getMeta() {
    return this.meta;
  }

  async withService(operation) {
    this.withServiceCalls += 1;
    return operation(this.service, this.meta);
  }
}

class SpyQueueCoordinator {
  constructor() {
    this.contexts = [];
  }

  async run(context, operation) {
    this.contexts.push(context);
    return operation(context);
  }
}

function createRouter(options = {}) {
  const runtime = options.runtime || new FakeRuntime();
  const queue = options.queue;
  const queueCommandCoordinator = options.queueCommandCoordinator;
  const router = new V3ApiRouter({
    runtime,
    queue,
    queueCommandCoordinator,
    protectedThreadGuard: options.protectedThreadGuard,
    attachmentStore: options.attachmentStore,
    diagnosticContext: options.diagnosticContext,
    diagnosticTokens: options.diagnosticTokens,
    eventRuntime: options.eventRuntime,
    protectionRegistry: options.protectionRegistry,
    pendingRequestStore: options.pendingRequestStore,
    pendingRequestCommandCoordinator: options.pendingRequestCommandCoordinator,
    now: options.now,
  });
  return {
    router,
    runtime,
    service: runtime.service,
    queue,
    queueCommandCoordinator,
    pendingRequestStore: options.pendingRequestStore,
    pendingRequestCommandCoordinator: options.pendingRequestCommandCoordinator,
  };
}

function createPendingRequestStore() {
  let nextHandle = 0;
  return new PendingRequestStore({
    now: () => 1_752_105_600_000,
    createHandle: () => `request-handle-${++nextHandle}`,
    ttlMs: 60_000,
    maxEntries: 8,
  });
}

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

test('thread event snapshot, cursor, and delta routes remain read-only and never start app-server', async () => {
  const calls = [];
  const eventRuntime = {
    async read(threadId, request) {
      calls.push({ method: 'read', threadId, request });
      return {
        mode: 'delta',
        serverInstanceId: 'server-events',
        snapshotVersion: 4,
        cursor: 8,
        events: [{ eventId: 'safe-event', cursor: 8 }],
        turns: [],
      };
    },
    async snapshot(threadId) {
      calls.push({ method: 'snapshot', threadId });
      return {
        mode: 'snapshot',
        serverInstanceId: 'server-events',
        snapshotVersion: 4,
        cursor: 8,
        events: [],
        turns: [],
      };
    },
    async cursor(threadId) {
      calls.push({ method: 'cursor', threadId });
      return { serverInstanceId: 'server-events', snapshotVersion: 4, cursor: 8 };
    },
    diagnostics() {
      return { snapshotVersion: 4, stale: false, lastSyncedAt: '2026-07-10T00:00:00.000Z' };
    },
  };
  const { router, runtime, service } = createRouter({ eventRuntime });

  const delta = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/events?serverInstanceId=server-events&snapshotVersion=4&cursor=7`,
  });
  const snapshot = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/events/snapshot`,
  });
  const cursor = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/events/cursor`,
  });

  assert.equal(delta.statusCode, 200);
  assert.equal(delta.body.mode, 'delta');
  assert.equal(snapshot.body.mode, 'snapshot');
  assert.deepEqual(cursor.body, {
    serverInstanceId: 'server-events',
    snapshotVersion: 4,
    cursor: 8,
  });
  assert.deepEqual(calls, [
    {
      method: 'read',
      threadId: THREAD,
      request: { serverInstanceId: 'server-events', snapshotVersion: 4, cursor: 7 },
    },
    { method: 'snapshot', threadId: THREAD },
    { method: 'cursor', threadId: THREAD },
  ]);
  assert.equal(runtime.withServiceCalls, 0);
  assert.deepEqual(service.calls, []);
});

test('pending request routes list safe DTOs and respond through the protected coordinator', async () => {
  const responses = [];
  const pendingRequestStore = createPendingRequestStore();
  const pending = pendingRequestStore.capture({
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD,
      itemId: 'SECRET_ITEM_ID',
      command: 'SECRET_COMMAND',
      cwd: 'E:\\SECRET_CWD',
      token: 'SECRET_TOKEN',
    },
    respond(result) {
      responses.push(result);
      return true;
    },
  });
  const coordinator = new SpyQueueCoordinator();
  const { router, runtime } = createRouter({
    pendingRequestStore,
    pendingRequestCommandCoordinator: coordinator,
  });

  const listed = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/requests`,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(runtime.withServiceCalls, 0);
  assert.equal(listed.body.threadId, THREAD);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].handle, pending.handle);
  assert.equal(listed.body.items[0].kind, 'commandApproval');
  const keys = deepKeys(listed.body.items);
  for (const forbiddenKey of ['requestId', 'itemId', 'path', 'cwd', 'command', 'token', 'params']) {
    assert.equal(keys.has(forbiddenKey), false);
  }
  assert.doesNotMatch(JSON.stringify(listed.body.items), /SECRET_/);

  const responded = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/requests/${pending.handle}/respond`,
    body: {
      decision: 'decline',
      control: { observedThreadId: THREAD, requireObservedTargetMatch: true },
    },
  });
  assert.equal(responded.statusCode, 200);
  assert.deepEqual(responded.body, {
    threadId: THREAD,
    item: { handle: pending.handle, kind: 'commandApproval', state: 'resolved' },
  });
  assert.deepEqual(responses, [{ decision: 'decline' }]);
  assert.deepEqual(coordinator.contexts, [{
    action: 'turn.steer',
    mode: 'rpc',
    threadId: THREAD,
    observedThreadId: THREAD,
    requireObservedTargetMatch: true,
  }]);

  const repeated = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/requests/${pending.handle}/respond`,
    body: { decision: 'decline' },
  });
  assert.equal(repeated.statusCode, 409);
  assert.equal(repeated.body.error.code, 'PENDING_REQUEST_RESOLVED');
});

test('pending request responses reject thread mismatch and protected tasks before responding', async () => {
  const responses = [];
  const pendingRequestStore = createPendingRequestStore();
  const pending = pendingRequestStore.capture({
    method: 'item/fileChange/requestApproval',
    params: { threadId: THREAD, itemId: 'SECRET_ITEM_ID', path: 'E:\\SECRET_PATH' },
    respond(result) {
      responses.push(result);
      return true;
    },
  });
  const mismatchRouter = createRouter({
    pendingRequestStore,
    pendingRequestCommandCoordinator: new SpyQueueCoordinator(),
  }).router;
  const mismatch = await mismatchRouter.handle({
    method: 'POST',
    url: `/codex/v3/threads/${OTHER_THREAD}/requests/${pending.handle}/respond`,
    body: { decision: 'decline' },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.body.error.code, 'PENDING_REQUEST_THREAD_MISMATCH');
  assert.deepEqual(responses, []);

  const protectedRouter = createRouter({
    pendingRequestStore,
    protectedThreadGuard: createProtectedThreadGuard({ protectedThreadIds: [THREAD] }),
  }).router;
  const blocked = await protectedRouter.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/requests/${pending.handle}/respond`,
    body: { decision: 'decline' },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.error.code, 'PROTECTED_THREAD');
  assert.deepEqual(responses, []);
  assert.equal(pendingRequestStore.list(THREAD).length, 1);
});

test('pending request routes fail closed when the store is not wired', async () => {
  const { router } = createRouter();
  const response = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/requests`,
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'PENDING_REQUESTS_UNAVAILABLE');
});

test('event routes fail closed when production synchronization is unavailable or cursor input is invalid', async () => {
  const { router } = createRouter();
  const unavailable = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/events`,
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error.code, 'EVENT_SYNC_UNAVAILABLE');

  const eventRuntime = {
    read() { throw new Error('must not read invalid cursors'); },
    snapshot() { throw new Error('unused'); },
    cursor() { throw new Error('unused'); },
  };
  const invalid = await createRouter({ eventRuntime }).router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/events?snapshotVersion=-1&cursor=not-a-number`,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error.code, 'INVALID_EVENT_CURSOR');
});

function createAttachmentStore(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-v3-attachments-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return new AttachmentStore({ rootDir });
}

test('meta and capabilities routes remain lazy while unknown routes are not claimed', async () => {
  const { router, runtime } = createRouter();

  const meta = await router.handle({ method: 'GET', url: '/codex/v3/meta' });
  const capabilities = await router.handle({ method: 'GET', url: '/codex/v3/capabilities' });
  const unknown = await router.handle({ method: 'GET', url: '/codex/v2/legacy' });

  assert.equal(meta.handled, true);
  assert.equal(meta.statusCode, 200);
  assert.equal(meta.body.apiVersion, 3);
  assert.deepEqual(capabilities.body, runtime.meta.capabilities);
  assert.deepEqual(unknown, { handled: false });
  assert.equal(runtime.withServiceCalls, 0, 'metadata cannot start app-server');
});

test('diagnostics lazily reports actual runtime and queue counts through the privacy allowlist', async () => {
  const queue = new TurnInputQueue({ createId: () => 'queue-diagnostics' });
  queue.enqueue({
    threadId: THREAD,
    clientRequestId: 'diagnostic-request',
    text: 'QUEUE_TEXT_CANARY secret-token',
    attachments: [{ dataUrl: 'data:image/png;base64,QUJDREVGRw==' }],
  });
  const runtime = new FakeRuntime();
  runtime.meta = {
    apiVersion: 3,
    versions: { backend: '2.1.21', desktop: '0.144.0', cli: '0.144.0' },
    protocol: { profile: 'v0144', schemaVersion: '0.144.0', schemaHash: 'a'.repeat(64) },
    appServer: { state: 'stopped', pid: null, connectionEpoch: 3 },
    capabilities: { operations: { 'thread.list': { mode: 'rpc' } } },
    codexHomeFingerprint: 'secret-token',
  };
  const { router } = createRouter({
    runtime,
    queue,
    queueCommandCoordinator: new SpyQueueCoordinator(),
    diagnosticTokens: ['secret-token'],
    diagnosticContext: () => ({
      environment: { platform: 'win32', nodeVersion: 'v22.0.0' },
      route: {
        kind: 'sakura',
        status: 'healthy',
        lastSuccessAt: '2026-07-10T00:00:00.000Z',
        url: 'https://example.invalid/?token=secret-token',
      },
      errors: [{
        code: 'REMOTE_NETWORK_UNAVAILABLE',
        kind: 'unavailable',
        message: 'C:\\Users\\fixture-user\\secret-token',
      }],
      requestBody: 'REQUEST_BODY_CANARY',
      subagents: [{ prompt: 'SUBAGENT_CANARY' }],
    }),
  });

  const response = await router.handle({ method: 'GET', url: '/codex/v3/diagnostics' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.versions.backend, '2.1.21');
  assert.equal(response.body.appServer.connectionEpoch, 3);
  assert.equal(response.body.capabilities.rpc, 1);
  assert.deepEqual(response.body.queue, { total: 1, states: { queued: 1 } });
  assert.equal(response.body.route.status, 'healthy');
  assert.deepEqual(response.body.errors, [{
    code: 'REMOTE_NETWORK_UNAVAILABLE',
    kind: 'unavailable',
    at: null,
  }]);
  const json = JSON.stringify(response.body);
  for (const canary of [
    'QUEUE_TEXT_CANARY',
    'secret-token',
    'REQUEST_BODY_CANARY',
    'SUBAGENT_CANARY',
    'QUJDREVGRw==',
    'C:\\Users\\fixture-user',
  ]) {
    assert.equal(json.includes(canary), false, canary);
  }
  assert.equal(runtime.withServiceCalls, 0, 'diagnostics cannot start app-server');
});

test('thread list, create, and read routes map stable query/body params through CodexService', async () => {
  const { router, service } = createRouter();

  await router.handle({
    method: 'GET',
    url: '/codex/v3/threads?cursor=c1&limit=20&archived=false&includeUnknown=drop',
  });
  await router.handle({
    method: 'POST',
    url: '/codex/v3/threads',
    body: {
      params: { cwd: 'E:\\work', model: 'future-model' },
      control: { desktopThreadId: 'desktop-thread' },
    },
  });
  await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}?includeTurns=true`,
  });

  assert.deepEqual(service.calls, [
    {
      method: 'listThreads',
      params: { cursor: 'c1', limit: 20, archived: false },
      control: undefined,
    },
    {
      method: 'startThread',
      params: { cwd: 'E:\\work', model: 'future-model' },
      control: { desktopThreadId: 'desktop-thread' },
    },
    {
      method: 'readThread',
      params: { threadId: THREAD, includeTurns: true },
      control: undefined,
    },
  ]);
});

test('live model and collaboration catalogs are read through app-server without guessed options', async () => {
  const { router, service } = createRouter();
  service.results.set('listModels', { data: [{ id: 'future-model' }], nextCursor: 'next' });
  service.results.set('listCollaborationModes', { data: [{ mode: 'future-mode' }] });

  const models = await router.handle({
    method: 'GET',
    url: '/codex/v3/catalogs/models?cursor=c1&limit=25&includeHidden=true&ignored=drop',
  });
  const modes = await router.handle({
    method: 'GET',
    url: '/codex/v3/catalogs/collaboration-modes',
  });

  assert.equal(models.statusCode, 200);
  assert.deepEqual(models.body, { data: [{ id: 'future-model' }], nextCursor: 'next' });
  assert.equal(modes.statusCode, 200);
  assert.deepEqual(modes.body, { data: [{ mode: 'future-mode' }] });
  assert.deepEqual(service.calls, [
    {
      method: 'listModels',
      params: { cursor: 'c1', limit: 25, includeHidden: true },
      control: undefined,
    },
    {
      method: 'listCollaborationModes',
      params: {},
      control: undefined,
    },
  ]);
});

test('task protection routes return only aggregate state and preserve immutable registry semantics', async () => {
  const calls = [];
  const protectionRegistry = {
    status(threadId) {
      calls.push({ operation: 'status', threadId });
      return { protected: false, protectedCount: 1, environmentProtected: true, revision: 3 };
    },
    protect(threadId, options) {
      calls.push({ operation: 'protect', threadId, options });
      return { protected: true, protectedCount: 2, environmentProtected: true, revision: 4, changed: true };
    },
    unprotect(threadId, options) {
      calls.push({ operation: 'unprotect', threadId, options });
      return { protected: false, protectedCount: 1, environmentProtected: true, revision: 5, changed: true };
    },
  };
  const { router, runtime } = createRouter({ protectionRegistry });

  const status = await router.handle({ method: 'GET', url: `/codex/v3/threads/${THREAD}/protection` });
  const protect = await router.handle({
    method: 'PUT',
    url: `/codex/v3/threads/${THREAD}/protection`,
    body: { protected: true, expectedRevision: 3 },
  });
  const unprotect = await router.handle({
    method: 'PUT',
    url: `/codex/v3/threads/${THREAD}/protection`,
    body: { protected: false, expectedRevision: 4 },
  });
  const invalid = await router.handle({
    method: 'PUT',
    url: `/codex/v3/threads/${THREAD}/protection`,
    body: { protected: 'true' },
  });

  assert.equal(status.statusCode, 200);
  assert.equal(protect.statusCode, 200);
  assert.equal(unprotect.statusCode, 200);
  assert.equal(invalid.statusCode, 400);
  assert.equal(runtime.withServiceCalls, 0, 'protection persistence does not start app-server');
  assert.deepEqual(calls, [
    { operation: 'status', threadId: THREAD },
    { operation: 'protect', threadId: THREAD, options: { expectedRevision: 3 } },
    { operation: 'unprotect', threadId: THREAD, options: { expectedRevision: 4 } },
  ]);
  const serialized = JSON.stringify([status.body, protect.body, unprotect.body]);
  assert.equal(serialized.includes(THREAD), false);
});

test('thread status returns raw status plus a precise active-turn steering precondition', async () => {
  const { router, service } = createRouter();
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      turns: [
        { id: 'turn-old', status: 'completed', kind: 'regular' },
        { id: 'turn-active', status: 'inProgress', kind: 'regular' },
      ],
    },
  });

  const response = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/status`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    threadId: THREAD,
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    activeTurn: {
      threadId: THREAD,
      turnId: 'turn-active',
      status: 'active',
      steerable: true,
    },
  });
  assert.deepEqual(service.calls[0], {
    method: 'readThread',
    params: { threadId: THREAD, includeTurns: true },
    control: undefined,
  });
});

test('thread actions pin the path target and invoke only CodexService mutation methods', async () => {
  const { router, service } = createRouter();
  const cases = [
    ['resume', 'resumeThread', { model: 'm1' }],
    ['fork', 'forkThread', { lastTurnId: 'turn-1' }],
    ['archive', 'archiveThread', {}],
    ['unarchive', 'unarchiveThread', {}],
    ['rename', 'setThreadName', { name: 'Renamed' }],
    ['compact', 'compactThread', {}],
    ['settings', 'updateThreadSettings', { effort: 'futureEffort' }],
    ['startTurn', 'startTurn', { input: [{ type: 'text', text: 'hello' }] }],
    ['interrupt', 'interruptTurn', { turnId: 'turn-active' }],
  ];

  for (const [action, method, params] of cases) {
    const response = await router.handle({
      method: 'POST',
      url: `/codex/v3/threads/${THREAD}/actions`,
      body: {
        action,
        params: { ...params, threadId: OTHER_THREAD },
        control: { observedThreadId: THREAD, requireObservedTargetMatch: true },
      },
    });
    assert.equal(response.statusCode, 200);
    const call = service.calls.at(-1);
    assert.equal(call.method, method);
    assert.equal(call.params.threadId, THREAD);
    assert.deepEqual(call.control, { observedThreadId: THREAD, requireObservedTargetMatch: true });
  }

  const unknown = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'activate-current-composer' },
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.error.code, 'UNKNOWN_THREAD_ACTION');
  assert.equal(service.calls.length, cases.length);
});

test('guard and service errors become stable API errors without fallback mutations', async () => {
  const { router, service } = createRouter();
  const protectedError = new Error('protected');
  protectedError.code = 'PROTECTED_THREAD';
  protectedError.statusCode = 403;
  protectedError.details = { action: 'thread.archive' };
  service.results.set('archiveThread', protectedError);

  const response = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'archive' },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: {
      code: 'PROTECTED_THREAD',
      kind: 'forbidden',
      message: 'protected',
      details: { action: 'thread.archive' },
      retryable: false,
      uncertain: false,
    },
  });
  assert.equal(service.calls.length, 1);
});

test('thread-input keeps steer and enqueue semantics explicit and steers only through CodexService', async () => {
  const queue = new TurnInputQueue({ createId: () => 'queue-steer-test' });
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'active' },
      turns: [{ id: 'turn-active', status: 'inProgress', kind: 'regular' }],
    },
  });
  service.results.set('steerTurn', { turnId: 'turn-active' });

  const steered = await router.handle({
    method: 'POST',
    url: '/codex/thread-input',
    body: {
      mode: 'steer-current',
      threadId: THREAD,
      expectedTurnId: 'turn-active',
      clientRequestId: 'steer-request',
      text: 'focus on the failing test',
      control: { observedThreadId: THREAD },
    },
  });
  const queued = await router.handle({
    method: 'POST',
    url: '/codex/v3/thread-input',
    body: {
      mode: 'enqueue-next-turn',
      threadId: THREAD,
      clientRequestId: 'queue-request',
      text: 'then update docs',
    },
  });

  assert.equal(steered.statusCode, 200);
  assert.equal(steered.body.state, 'applied');
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.body.state, 'queued');
  assert.equal(queued.body.item.state, 'queued');
  assert.deepEqual(service.calls.map(call => call.method), ['readThread', 'steerTurn']);
  assert.deepEqual(service.calls[1], {
    method: 'steerTurn',
    params: {
      threadId: THREAD,
      expectedTurnId: 'turn-active',
      input: [{ type: 'text', text: 'focus on the failing test' }],
      clientUserMessageId: 'steer-request',
    },
    control: { observedThreadId: THREAD },
  });
  assert.deepEqual(queueCommandCoordinator.contexts.map(context => context.action), [
    'queue.steer',
    'queue.enqueue',
  ]);
  assert.equal(queue.list(THREAD).length, 1);
});

test('thread-input archives data URLs before persistence and materializes images only at steer RPC', async (t) => {
  const queue = new TurnInputQueue({ createId: () => 'queue-attachment-steer' });
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const attachmentStore = createAttachmentStore(t);
  const { router, service } = createRouter({ queue, queueCommandCoordinator, attachmentStore });
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'active' },
      turns: [{ id: 'turn-active', status: 'inProgress', kind: 'regular' }],
    },
  });
  service.results.set('steerTurn', { turnId: 'turn-active' });

  const response = await router.handle({
    method: 'POST',
    url: '/codex/v3/thread-input',
    body: {
      mode: 'steer-current',
      threadId: THREAD,
      expectedTurnId: 'turn-active',
      clientRequestId: 'attachment-steer-request',
      text: 'inspect this image',
      attachments: [{ name: 'pixel.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(service.calls.at(-1).params.input, [
    { type: 'text', text: 'inspect this image' },
    { type: 'image', url: PNG_DATA_URL },
  ]);
  assert.equal(JSON.stringify(response).includes(PNG_BYTES.toString('base64')), false);
  assert.equal(queue.list(THREAD).length, 0);
});

test('queued data URLs persist only descriptors and materialize for flush and convert-to-steer', async (t) => {
  let nextId = 0;
  const queue = new TurnInputQueue({ createId: () => `queue-attachment-${++nextId}` });
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const attachmentStore = createAttachmentStore(t);
  const { router, service } = createRouter({ queue, queueCommandCoordinator, attachmentStore });

  const firstResponse = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: {
      clientRequestId: 'attachment-flush-request',
      text: 'flush image',
      attachments: [{ name: 'flush.png', dataUrl: PNG_DATA_URL }],
    },
  });
  const first = firstResponse.body.item;
  assert.match(first.attachments[0].id, /^att_[a-f0-9]{64}$/);
  assert.equal(first.attachments[0].dataUrl, undefined);
  assert.equal(JSON.stringify(queue.get(first.id)).includes(PNG_BYTES.toString('base64')), false);

  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'idle' },
      turns: [{ id: 'turn-finished', status: 'completed', kind: 'regular' }],
    },
  });
  service.results.set('startTurn', { turn: { id: 'turn-with-image' } });
  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: {},
  });
  assert.equal(flushed.body.item.state, 'accepted');
  assert.deepEqual(service.calls.at(-1).params.input, [
    { type: 'text', text: 'flush image' },
    { type: 'image', url: PNG_DATA_URL },
  ]);

  const secondResponse = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: {
      clientRequestId: 'attachment-convert-request',
      text: 'steer image',
      attachments: [{ name: 'convert.png', dataUrl: PNG_DATA_URL }],
    },
  });
  const second = secondResponse.body.item;
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'active' },
      turns: [{ id: 'turn-active', status: 'inProgress', kind: 'regular' }],
    },
  });
  service.results.set('steerTurn', { turnId: 'turn-active' });
  const converted = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${second.id}/convert-to-steer`,
    body: { revision: second.revision, expectedTurnId: 'turn-active' },
  });
  assert.equal(converted.body.item.state, 'cancelled');
  assert.deepEqual(service.calls.at(-1).params.input, [
    { type: 'text', text: 'steer image' },
    { type: 'image', url: PNG_DATA_URL },
  ]);
});

test('app-server-shaped image data URLs cannot bypass descriptor persistence', async (t) => {
  const queue = new TurnInputQueue({ createId: () => 'queue-shaped-image' });
  const attachmentStore = createAttachmentStore(t);
  const { router } = createRouter({
    queue,
    queueCommandCoordinator: new SpyQueueCoordinator(),
    attachmentStore,
  });

  const response = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: {
      clientRequestId: 'shaped-image-request',
      text: 'two representations',
      attachments: [
        { type: 'image', name: 'top-level.png', url: PNG_DATA_URL },
        { name: 'nested.png', input: { type: 'image', url: PNG_DATA_URL } },
      ],
    },
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.item.attachments.length, 2);
  for (const descriptor of response.body.item.attachments) {
    assert.match(descriptor.id, /^att_[a-f0-9]{64}$/);
    assert.equal(descriptor.dataUrl, undefined);
    assert.equal(descriptor.url, undefined);
    assert.equal(descriptor.input, undefined);
  }
  assert.equal(JSON.stringify(queue.get('queue-shaped-image')).includes(PNG_BYTES.toString('base64')), false);
});

test('protected-thread guard rejects queue writes before attachment, queue, or CodexService mutation', async (t) => {
  const queue = new TurnInputQueue({ createId: () => 'must-not-be-created' });
  const attachmentStore = createAttachmentStore(t);
  const { router, service } = createRouter({
    queue,
    protectedThreadGuard: createProtectedThreadGuard({ protectedThreadIds: [THREAD] }),
    attachmentStore,
  });

  const response = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: {
      clientRequestId: 'blocked',
      text: 'must not persist',
      attachments: [{ name: 'blocked.png', dataUrl: PNG_DATA_URL }],
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, 'PROTECTED_THREAD');
  assert.equal(queue.list(THREAD).length, 0);
  assert.equal(service.calls.length, 0);
  assert.equal(fs.existsSync(path.join(attachmentStore.rootDir, 'metadata')), false);

  const uncertain = queue.enqueue({
    threadId: THREAD,
    clientRequestId: 'blocked-reconcile',
    text: 'setup only',
  });
  queue._setStateForTest(uncertain.id, 'needs_reconcile');
  const reconcile = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${uncertain.id}/reconcile`,
    body: {
      outcome: 'accepted',
      clientUserMessageId: 'blocked-reconcile',
      turnId: 'turn-proof',
    },
  });
  assert.equal(reconcile.statusCode, 403);
  assert.equal(reconcile.body.error.code, 'PROTECTED_THREAD');
  assert.equal(queue.get(uncertain.id).state, 'needs_reconcile');
  assert.equal(service.calls.length, 0);
});

test('queue CRUD, flush, and reconcile are guarded and flush starts turns through CodexService', async () => {
  let nextId = 0;
  const queue = new TurnInputQueue({ createId: () => `queue-${++nextId}` });
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });

  const firstResponse = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: { clientRequestId: 'crud-1', text: 'first' },
  });
  const secondResponse = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: { clientRequestId: 'crud-2', text: 'second' },
  });
  const first = firstResponse.body.item;
  const second = secondResponse.body.item;

  const editedResponse = await router.handle({
    method: 'PUT',
    url: `/codex/v3/queue/${first.id}`,
    body: { revision: first.revision, text: 'first edited' },
  });
  await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/reorder`,
    body: { orderedIds: [second.id, first.id] },
  });
  await router.handle({
    method: 'DELETE',
    url: `/codex/v3/queue/${second.id}`,
    body: { revision: queue.get(second.id).revision },
  });

  queue._setStateForTest(first.id, 'needs_reconcile');
  const mismatch = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${first.id}/reconcile`,
    body: {
      outcome: 'accepted',
      clientUserMessageId: 'different-client-request',
      turnId: 'turn-wrong',
    },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.body.error.code, 'RECONCILE_EVIDENCE_MISMATCH');
  assert.equal(queue.get(first.id).state, 'needs_reconcile');

  const reconciled = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${first.id}/reconcile`,
    body: { outcome: 'notAccepted' },
  });
  const retried = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${first.id}/retry`,
    body: { revision: reconciled.body.item.revision },
  });
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'idle' },
      turns: [{ id: 'turn-finished', status: 'completed', kind: 'regular' }],
    },
  });
  service.results.set('startTurn', { turn: { id: 'turn-next' } });
  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: { threadStatus: 'idle' },
  });
  const listed = await router.handle({
    method: 'GET',
    url: `/codex/v3/threads/${THREAD}/queue`,
  });

  assert.equal(editedResponse.body.item.text, 'first edited');
  assert.equal(retried.body.item.state, 'queued');
  assert.equal(flushed.body.item.state, 'accepted');
  assert.equal(flushed.body.item.turnId, 'turn-next');
  assert.deepEqual(listed.body, { threadId: THREAD, items: [] });
  assert.deepEqual(service.calls.at(-1), {
    method: 'startTurn',
    params: {
      threadId: THREAD,
      input: [{ type: 'text', text: 'first edited' }],
      clientUserMessageId: 'crud-1',
    },
    control: {},
  });
  assert.deepEqual(queueCommandCoordinator.contexts.map(context => context.action), [
    'queue.enqueue',
    'queue.enqueue',
    'queue.edit',
    'queue.reorder',
    'queue.cancel',
    'queue.reconcile',
    'queue.reconcile',
    'queue.retry',
    'queue.dispatch',
  ]);
});

test('pending request listing synchronizes the desktop renderer before returning', async () => {
  const pendingRequestStore = createPendingRequestStore();
  let synchronizedThreadId = '';
  pendingRequestStore.setSynchronizer(async threadId => {
    synchronizedThreadId = threadId;
    pendingRequestStore.capture({
      requestId: 'renderer-request',
      connectionEpoch: 1,
      connectionSource: 'desktopRenderer',
      method: 'item/permissions/requestApproval',
      params: { threadId, permissions: { network: true } },
      respond: async () => {},
    });
  });
  const { router } = createRouter({
    pendingRequestStore,
    pendingRequestCommandCoordinator: new SpyQueueCoordinator(),
  });
  const result = await router.handle({ method: 'GET', url: `/codex/v3/threads/${THREAD}/requests` });
  assert.equal(result.statusCode, 200);
  assert.equal(synchronizedThreadId, THREAD);
  assert.equal(result.body.items.length, 1);
});

test('collaboration catalog returns an authoritative empty list for incomplete new Codex presets', async () => {
  const rawService = new FakeCodexService();
  rawService.results.set('listCollaborationModes', {
    data: [
      { name: 'Future preset without settings', value: { mode: 'future' } },
      { name: 'Plugin', plugin: { id: 'x' } },
      { name: 'Subagent', subagent: { name: 'worker' } },
    ],
    nextCursor: null,
  });
  const runtime = new FakeRuntime(createConfirmedControls(rawService));
  const { router } = createRouter({ runtime });

  const response = await router.handle({
    method: 'GET',
    url: '/codex/v3/catalogs/collaboration-modes',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { data: [], nextCursor: null });
  assert.deepEqual(rawService.calls, [{
    method: 'listCollaborationModes',
    params: {},
    control: undefined,
  }]);
});

test('public event routes expose exact subagent lifecycle metadata without internal state', async () => {
  const privateSubagent = {
    schemaVersion: 2,
    type: 'summary',
    summaryKind: 'subagent',
    eventId: 'public-feed-event',
    id: 'public-feed-event',
    turnId: 'turn-public',
    text: 'backend_audit 正在执行',
    state: 'running',
    subagent: {
      name: 'backend_audit', status: 'running', change: 'running',
      aggregate: { running: 1, completed: 0, failed: 0, interrupted: 0 },
      prompt: 'PRIVATE_PROMPT', result: 'PRIVATE_RESULT', agentThreadId: 'PRIVATE_CHILD_ID',
    },
  };
  const eventRuntime = {
    async read() {
      return {
        mode: 'delta',
        events: ['running', 'failed', 'interrupted', 'future-private-state'].map((status, index) => ({
          ...privateSubagent,
          eventId: `public-feed-event-${index}`,
          id: `public-feed-event-${index}`,
          subagent: { ...privateSubagent.subagent, status },
        })),
        turns: [],
      };
    },
    async snapshot() { return { mode: 'snapshot', events: [{ ...privateSubagent, subagent: { ...privateSubagent.subagent, status: 'completed' } }], turns: [] }; },
    async cursor() { return {}; },
  };
  const { router } = createRouter({ eventRuntime });
  const delta = await router.handle({ method: 'GET', url: `/codex/v3/threads/${THREAD}/events` });
  const snapshot = await router.handle({ method: 'GET', url: `/codex/v3/threads/${THREAD}/events/snapshot` });

  assert.deepEqual(delta.body.events[0].subagent, { name: 'backend_audit', state: 'running' });
  assert.deepEqual(delta.body.events.map(event => event.subagent.state), ['running', 'failed', 'interrupted']);
  assert.deepEqual(snapshot.body.events[0].subagent, { name: 'backend_audit', state: 'completed' });
  for (const response of [delta.body, snapshot.body]) {
    assert.doesNotMatch(JSON.stringify(response), /change|aggregate|PRIVATE_PROMPT|PRIVATE_RESULT|PRIVATE_CHILD_ID|agentThreadId/);
    assert.match(JSON.stringify(response), /"state":"(?:running|completed|failed|interrupted)"/);
  }
});

test('settings action returns confirmed-request provenance from native controls unchanged', async () => {
  const { router, service } = createRouter();
  const result = {
    status: 'confirmed',
    operation: 'thread.settings',
    observation: {
      source: 'confirmedRequest',
      readbackSupported: false,
      settings: { effort: 'high' },
    },
  };
  service.results.set('updateThreadSettings', result);

  const response = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/actions`,
    body: { action: 'settings', params: { effort: 'high' } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, result);
});

test('a queue flush recognizes a confirmed thread result from native controls', async () => {
  const queue = new TurnInputQueue();
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });
  service.results.set('startThread', {
    status: 'confirmed',
    operation: 'thread.start',
    observation: { threadId: THREAD },
  });

  const created = await router.handle({
    method: 'POST',
    url: '/codex/v3/threads',
    body: { params: { cwd: 'E:\\work' } },
  });
  assert.equal(created.statusCode, 201);

  const queued = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue`,
    body: { clientRequestId: 'first-message', text: 'hello' },
  });
  assert.equal(queued.statusCode, 202);

  const notMaterialized = new Error('Invalid request: thread is not materialized yet');
  notMaterialized.code = 'DESKTOP_RPC_ERROR';
  notMaterialized.details = {
    rpcError: { code: -32600, message: 'thread is not materialized yet' },
  };
  service.results.set('readThread', notMaterialized);
  service.results.set('startTurn', { turn: { id: 'first-turn' } });

  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: {},
  });

  assert.equal(flushed.statusCode, 200);
  assert.equal(flushed.body.item.state, 'accepted');
  assert.equal(flushed.body.item.turnId, 'first-turn');
  assert.deepEqual(service.calls.slice(-2).map(call => call.method), ['readThread', 'startTurn']);
});

test('a locally created empty thread can start its first turn while app-server reports notLoaded', async () => {
  const queue = new TurnInputQueue();
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });
  service.results.set('startThread', { thread: { id: THREAD } });
  await router.handle({ method: 'POST', url: '/codex/v3/threads', body: {} });
  await queue.enqueue({ threadId: THREAD, clientRequestId: 'not-loaded-first', text: 'hello' });
  service.results.set('readThread', {
    thread: { id: THREAD, status: { type: 'notLoaded' }, turns: [] },
  });
  service.results.set('startTurn', { turn: { id: 'not-loaded-turn' } });

  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: {},
  });

  assert.equal(flushed.statusCode, 200);
  assert.equal(flushed.body.item.state, 'accepted');
  assert.equal(flushed.body.item.turnId, 'not-loaded-turn');
});

test('queue flush does not treat an invalid read for an arbitrary thread as idle', async () => {
  const queue = new TurnInputQueue();
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });
  await queue.enqueue({ threadId: THREAD, clientRequestId: 'existing-message', text: 'hello' });
  const invalidRead = new Error('Invalid request');
  invalidRead.code = 'APP_SERVER_RPC_ERROR';
  invalidRead.rpcCode = -32602;
  service.results.set('readThread', invalidRead);

  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: {},
  });

  assert.equal(flushed.statusCode, 400);
  assert.equal(flushed.body.error.kind, 'invalidRequest');
  assert.deepEqual(service.calls.map(call => call.method), ['readThread']);
  assert.equal(queue.list(THREAD)[0].state, 'queued');
});

test('the new-thread unreadable allowance expires instead of becoming a permanent idle bypass', async () => {
  let now = 1_000;
  const queue = new TurnInputQueue();
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator, now: () => now });
  service.results.set('startThread', { thread: { id: THREAD } });
  await router.handle({ method: 'POST', url: '/codex/v3/threads', body: {} });
  await queue.enqueue({ threadId: THREAD, clientRequestId: 'late-first-message', text: 'hello' });
  now += 30_001;
  const invalidRead = new Error('Invalid request');
  invalidRead.code = 'APP_SERVER_RPC_ERROR';
  invalidRead.rpcCode = -32602;
  service.results.set('readThread', invalidRead);

  const flushed = await router.handle({
    method: 'POST',
    url: `/codex/v3/threads/${THREAD}/queue/flush`,
    body: {},
  });

  assert.equal(flushed.statusCode, 400);
  assert.equal(flushed.body.error.kind, 'invalidRequest');
  assert.equal(queue.list(THREAD)[0].state, 'queued');
});

test('concurrent queue flushes coalesce on the accepted dispatch result', async () => {
  const queue = new TurnInputQueue();
  const coordinator = new CommandCoordinator({ guard: { assertAllowed: context => context } });
  const { router, service } = createRouter({ queue, queueCommandCoordinator: coordinator });
  await queue.enqueue({ threadId: THREAD, clientRequestId: 'coalesced-message', text: 'hello' });
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'idle' },
      turns: [{ id: 'finished', status: 'completed', kind: 'regular' }],
    },
  });
  let releaseStart;
  service.results.set('startTurn', new Promise(resolve => { releaseStart = resolve; }));

  const first = router.handle({
    method: 'POST', url: `/codex/v3/threads/${THREAD}/queue/flush`, body: {},
  });
  await new Promise(resolve => setImmediate(resolve));
  const second = router.handle({
    method: 'POST', url: `/codex/v3/threads/${THREAD}/queue/flush`, body: {},
  });
  releaseStart({ turn: { id: 'coalesced-turn' } });
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.body.item.state, 'accepted');
  assert.equal(secondResponse.body.item.state, 'accepted');
  assert.equal(secondResponse.body.item.turnId, 'coalesced-turn');
  assert.equal(service.calls.filter(call => call.method === 'startTurn').length, 1);
});

test('queue convert-to-steer is atomic and uses the exact active turn', async () => {
  const queue = new TurnInputQueue({ createId: () => 'queue-convert' });
  const queueCommandCoordinator = new SpyQueueCoordinator();
  const { router, service } = createRouter({ queue, queueCommandCoordinator });
  const item = queue.enqueue({ threadId: THREAD, clientRequestId: 'convert-request', text: 'use this now' });
  service.results.set('readThread', {
    thread: {
      id: THREAD,
      status: { type: 'active' },
      turns: [{ id: 'turn-active', status: 'inProgress', kind: 'regular' }],
    },
  });
  service.results.set('steerTurn', { turnId: 'turn-active' });

  const response = await router.handle({
    method: 'POST',
    url: `/codex/v3/queue/${item.id}/convert-to-steer`,
    body: { revision: item.revision, expectedTurnId: 'turn-active' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.item.state, 'cancelled');
  assert.deepEqual(queue.list(THREAD), []);
  assert.deepEqual(service.calls.map(call => call.method), ['readThread', 'steerTurn']);
  assert.equal(service.calls[1].params.expectedTurnId, 'turn-active');
  assert.equal(queueCommandCoordinator.contexts.at(-1).action, 'queue.steer');
});
