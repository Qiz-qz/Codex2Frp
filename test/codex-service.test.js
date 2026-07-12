'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSchemaProfile } = require('../lib/app-server/schema-profile');
const {
  AppServerCompatibilityError,
  AppServerRpcError,
  AppServerTimeoutError,
} = require('../lib/codex/errors');
const { createProtectedThreadGuard } = require('../lib/control/protected-thread-guard');
const {
  CodexService,
  ERROR_KINDS,
  classifyCodexServiceError,
} = require('../lib/codex/codex-service');

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');
const CODEX_HOME = 'E:\\isolated\\codex-home';
const THREAD_ID = '11111111-2222-4333-8444-555555555555';
const PROTECTED_THREAD_ID = '019f4840-00df-7ee0-88cb-e3dbcb1871dc';

class FakeJsonlRpcClient {
  constructor(results = {}) {
    this.results = new Map(Object.entries(results));
    this.calls = [];
    this.notifications = [];
  }

  async request(method, params, options) {
    this.calls.push({ method, params, options });
    const result = this.results.get(method);
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result(params, options);
    return result;
  }

  notify(method, params) {
    this.notifications.push({ method, params });
  }
}

class SpyCommandCoordinator {
  constructor() {
    this.contexts = [];
  }

  async run(context, operation) {
    this.contexts.push(context);
    return operation(context);
  }
}

function profile() {
  return loadSchemaProfile(PROFILE_FILE);
}

function createService(options = {}) {
  const rpcClient = options.rpcClient || new FakeJsonlRpcClient();
  const commandCoordinator = options.commandCoordinator || new SpyCommandCoordinator();
  return {
    rpcClient,
    commandCoordinator,
    service: new CodexService({
      rpcClient,
      commandCoordinator,
      schemaProfile: options.schemaProfile || profile(),
      codexHome: options.codexHome || CODEX_HOME,
    }),
  };
}

test('initialize sends the stable client contract and validates the negotiated CODEX_HOME/profile', async () => {
  const initializeResponse = {
    codexHome: 'e:\\isolated\\codex-home\\',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex_cli_rs/0.144.0-alpha.4 (Windows 11)',
  };
  const { service, rpcClient } = createService({
    rpcClient: new FakeJsonlRpcClient({ initialize: initializeResponse }),
  });

  const result = await service.initialize({
    clientInfo: { name: 'codex2frp', title: 'Codex2Frp', version: '2.2.0' },
    capabilities: { experimentalApi: true },
    ignoredTransportDetail: 'must-not-leak',
  });

  assert.equal(result, initializeResponse);
  assert.deepEqual(rpcClient.calls, [{
    method: 'initialize',
    params: {
      clientInfo: { name: 'codex2frp', title: 'Codex2Frp', version: '2.2.0' },
      capabilities: { experimentalApi: true },
    },
    options: undefined,
  }]);
  assert.deepEqual(rpcClient.notifications, [{ method: 'initialized', params: undefined }]);

  const invalidHome = createService({ codexHome: 'relative\\codex-home' });
  await assert.rejects(invalidHome.service.initialize({}), error => {
    assert.equal(error.code, 'APP_SERVER_CODEX_HOME_INVALID');
    return true;
  });
  assert.equal(invalidHome.rpcClient.calls.length, 0, 'invalid CODEX_HOME must fail before transport');

  assert.throws(() => createService({ schemaProfile: { id: 'broken' } }), error => {
    assert.equal(error.code, 'APP_SERVER_PROFILE_INVALID');
    return true;
  });
});

test('read operations map only stable protocol params and preserve unknown response enums', async () => {
  const unknownThread = { thread: { id: THREAD_ID, status: { type: 'futureStatus' } } };
  const { service, rpcClient, commandCoordinator } = createService({
    rpcClient: new FakeJsonlRpcClient({
      'thread/list': { data: [] },
      'thread/read': unknownThread,
      'thread/turns/list': { data: [], nextCursor: null },
      'model/list': { data: [{ id: 'future-model', availability: 'futureAvailability' }] },
      'collaborationMode/list': { data: [{ mode: 'futureMode' }] },
    }),
  });

  await service.listThreads({
    cursor: 'cursor-1',
    limit: 25,
    sortKey: 'updated_at',
    sortDirection: 'asc',
    modelProviders: ['openai'],
    sourceKinds: ['cli'],
    archived: false,
    cwd: 'E:\\work',
    ignored: true,
  });
  assert.equal(await service.readThread({
    threadId: THREAD_ID,
    includeTurns: true,
    ignored: true,
  }), unknownThread);
  await service.listThreadTurns({
    threadId: THREAD_ID,
    cursor: 'turn-cursor',
    limit: 50,
    sortDirection: 'desc',
    itemsView: 'summary',
    ignored: true,
  });
  await service.listModels({ cursor: 'model-cursor', limit: 20, includeHidden: true, ignored: true });
  await service.listCollaborationModes({ ignored: true });

  assert.deepEqual(rpcClient.calls.map(({ method, params }) => ({ method, params })), [
    {
      method: 'thread/list',
      params: {
        cursor: 'cursor-1',
        limit: 25,
        sortKey: 'updated_at',
        sortDirection: 'asc',
        modelProviders: ['openai'],
        sourceKinds: ['cli'],
        archived: false,
        cwd: 'E:\\work',
      },
    },
    { method: 'thread/read', params: { threadId: THREAD_ID, includeTurns: true } },
    {
      method: 'thread/turns/list',
      params: {
        threadId: THREAD_ID,
        cursor: 'turn-cursor',
        limit: 50,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    },
    { method: 'model/list', params: { cursor: 'model-cursor', limit: 20, includeHidden: true } },
    { method: 'collaborationMode/list', params: {} },
  ]);
  assert.equal(commandCoordinator.contexts.length, 0, 'reads do not enter the mutation queue');
});

test('thread mutations use the coordinator and exact v0144 parameter mappings', async () => {
  const { service, rpcClient, commandCoordinator } = createService();
  const control = {
    observedThreadId: THREAD_ID,
    desktopThreadId: PROTECTED_THREAD_ID,
    requireObservedTargetMatch: true,
  };

  await service.startThread({
    model: 'future-model',
    modelProvider: 'openai',
    cwd: 'E:\\work',
    approvalPolicy: 'never',
    sandbox: 'workspaceWrite',
    config: { web_search: 'live' },
    baseInstructions: 'base',
    developerInstructions: 'developer',
    serviceName: 'codex2frp',
    personality: 'futurePersonality',
    ephemeral: true,
    ignored: true,
  });
  await service.resumeThread({ threadId: THREAD_ID, model: 'future-model', excludeTurns: true, ignored: true }, control);
  await service.forkThread({ threadId: THREAD_ID, lastTurnId: 'turn-0', ephemeral: true, ignored: true }, control);
  await service.archiveThread({ threadId: THREAD_ID, ignored: true }, control);
  await service.unarchiveThread({ threadId: THREAD_ID, ignored: true }, control);
  await service.setThreadName({ threadId: THREAD_ID, name: 'Renamed', ignored: true }, control);
  await service.compactThread({ threadId: THREAD_ID, ignored: true }, control);
  await service.updateThreadSettings({
    threadId: THREAD_ID,
    model: 'future-model',
    effort: 'futureEffort',
    summary: 'futureSummary',
    serviceTier: null,
    collaborationMode: { mode: 'futureMode', settings: {} },
    personality: 'futurePersonality',
    ignored: true,
  }, control);

  assert.deepEqual(rpcClient.calls.map(({ method, params }) => ({ method, params })), [
    {
      method: 'thread/start',
      params: {
        model: 'future-model',
        modelProvider: 'openai',
        cwd: 'E:\\work',
        approvalPolicy: 'never',
        sandbox: 'workspaceWrite',
        config: { web_search: 'live' },
        baseInstructions: 'base',
        developerInstructions: 'developer',
        serviceName: 'codex2frp',
        personality: 'futurePersonality',
        ephemeral: true,
      },
    },
    { method: 'thread/resume', params: { threadId: THREAD_ID, model: 'future-model', excludeTurns: true } },
    { method: 'thread/fork', params: { threadId: THREAD_ID, lastTurnId: 'turn-0', ephemeral: true } },
    { method: 'thread/archive', params: { threadId: THREAD_ID } },
    { method: 'thread/unarchive', params: { threadId: THREAD_ID } },
    { method: 'thread/name/set', params: { threadId: THREAD_ID, name: 'Renamed' } },
    { method: 'thread/compact/start', params: { threadId: THREAD_ID } },
    {
      method: 'thread/settings/update',
      params: {
        threadId: THREAD_ID,
        model: 'future-model',
        effort: 'futureEffort',
        summary: 'futureSummary',
        serviceTier: null,
        collaborationMode: { mode: 'futureMode', settings: {} },
        personality: 'futurePersonality',
      },
    },
  ]);

  assert.deepEqual(commandCoordinator.contexts.map(({ action, mode, threadId }) => ({ action, mode, threadId })), [
    { action: 'thread.start', mode: 'rpc', threadId: '' },
    { action: 'thread.resume', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.fork', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.archive', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.unarchive', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.rename', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.compact', mode: 'rpc', threadId: THREAD_ID },
    { action: 'thread.settings', mode: 'rpc', threadId: THREAD_ID },
  ]);
  assert.deepEqual(commandCoordinator.contexts[1], {
    action: 'thread.resume',
    mode: 'rpc',
    threadId: THREAD_ID,
    ...control,
  });
});

test('turn start, interrupt, and steer preserve exact target semantics', async () => {
  const { service, rpcClient, commandCoordinator } = createService();
  const input = [{ type: 'text', text: 'Run focused tests' }];

  await service.startTurn({
    threadId: THREAD_ID,
    input,
    clientUserMessageId: 'client-message-1',
    cwd: 'E:\\work',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'workspaceWrite' },
    model: 'future-model',
    effort: 'futureEffort',
    summary: 'futureSummary',
    collaborationMode: { mode: 'futureMode', settings: {} },
    personality: 'futurePersonality',
    outputSchema: { type: 'object' },
    ignored: true,
  });
  await service.interruptTurn({ threadId: THREAD_ID, turnId: 'turn-1', ignored: true });
  await service.steerTurn({
    threadId: THREAD_ID,
    expectedTurnId: 'turn-1',
    input,
    clientUserMessageId: 'client-message-2',
    ignored: true,
  });

  assert.deepEqual(rpcClient.calls.map(({ method, params }) => ({ method, params })), [
    {
      method: 'turn/start',
      params: {
        threadId: THREAD_ID,
        input,
        clientUserMessageId: 'client-message-1',
        cwd: 'E:\\work',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite' },
        model: 'future-model',
        effort: 'futureEffort',
        summary: 'futureSummary',
        collaborationMode: { mode: 'futureMode', settings: {} },
        personality: 'futurePersonality',
        outputSchema: { type: 'object' },
      },
    },
    { method: 'turn/interrupt', params: { threadId: THREAD_ID, turnId: 'turn-1' } },
    {
      method: 'turn/steer',
      params: {
        threadId: THREAD_ID,
        expectedTurnId: 'turn-1',
        input,
        clientUserMessageId: 'client-message-2',
      },
    },
  ]);
  assert.deepEqual(commandCoordinator.contexts.map(context => context.action), [
    'turn.start',
    'turn.interrupt',
    'turn.steer',
  ]);
});

test('extended v0144 controls are preserved instead of being flattened or guessed', async () => {
  const { service, rpcClient } = createService();
  const startThreadParams = {
    allowProviderModelFallback: false,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    baseInstructions: 'base',
    config: { web_search: 'live' },
    cwd: 'E:\\work',
    developerInstructions: 'developer',
    dynamicTools: [{ name: 'tool' }],
    environments: [{ id: 'env-1' }],
    ephemeral: true,
    experimentalRawEvents: false,
    historyMode: 'full',
    mockExperimentalField: 'mock',
    model: 'future-model',
    modelProvider: 'openai',
    multiAgentMode: 'explicitRequestOnly',
    permissions: 'workspace',
    personality: 'futurePersonality',
    runtimeWorkspaceRoots: ['E:\\work'],
    sandbox: 'workspaceWrite',
    selectedCapabilityRoots: ['E:\\work'],
    serviceName: 'codex2frp',
    serviceTier: 'priority',
    sessionStartSource: 'codex2frp',
    threadSource: 'appServer',
  };
  await service.startThread(startThreadParams);

  const turnStartParams = {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'full control' }],
    additionalContext: { phone: { text: 'mobile context' } },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    clientUserMessageId: 'client-full',
    collaborationMode: { mode: 'futureMode', settings: {} },
    cwd: 'E:\\work',
    effort: 'futureEffort',
    environments: [{ id: 'env-1' }],
    model: 'future-model',
    multiAgentMode: 'explicitRequestOnly',
    outputSchema: { type: 'object' },
    permissions: 'workspace',
    personality: 'futurePersonality',
    responsesapiClientMetadata: { source: 'codexhm' },
    runtimeWorkspaceRoots: ['E:\\work'],
    sandboxPolicy: { type: 'workspaceWrite' },
    serviceTier: 'priority',
    summary: 'futureSummary',
  };
  await service.startTurn(turnStartParams);
  await service.steerTurn({
    threadId: THREAD_ID,
    expectedTurnId: 'turn-1',
    input: [{ type: 'text', text: 'steer' }],
    additionalContext: { phone: { text: 'steer context' } },
    clientUserMessageId: 'client-steer-full',
    responsesapiClientMetadata: { source: 'codexhm' },
  });

  assert.deepEqual(rpcClient.calls[0], { method: 'thread/start', params: startThreadParams, options: undefined });
  assert.deepEqual(rpcClient.calls[1], { method: 'turn/start', params: turnStartParams, options: undefined });
  assert.deepEqual(rpcClient.calls[2], {
    method: 'turn/steer',
    params: {
      threadId: THREAD_ID,
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'steer' }],
      additionalContext: { phone: { text: 'steer context' } },
      clientUserMessageId: 'client-steer-full',
      responsesapiClientMetadata: { source: 'codexhm' },
    },
    options: undefined,
  });
});

test('an injected protected-thread guard rejects mutations before fake RPC transport', async () => {
  const rpcClient = new FakeJsonlRpcClient();
  const service = new CodexService({
    rpcClient,
    protectedThreadGuard: createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD_ID] }),
    schemaProfile: profile(),
    codexHome: CODEX_HOME,
  });

  await assert.rejects(
    service.archiveThread({ threadId: PROTECTED_THREAD_ID }),
    error => {
      assert.equal(error.code, 'PROTECTED_THREAD');
      return true;
    },
  );
  assert.equal(rpcClient.calls.length, 0);
});

test('error classification is stable for compatibility, guard, RPC, and uncertain mutation failures', () => {
  const methodMissing = new AppServerRpcError('Method not found', {
    rpcCode: -32601,
    rpcData: { method: 'thread/future' },
  });
  const steerConflict = new AppServerRpcError('active turn not steerable', {
    rpcCode: -32602,
    rpcData: { codexErrorInfo: { type: 'activeTurnNotSteerable', turnKind: 'review' } },
  });
  const timeout = new AppServerTimeoutError({ method: 'turn/start', requestId: '1:1' });
  const incompatible = new AppServerCompatibilityError('APP_SERVER_SCHEMA_MISMATCH', 'mismatch');
  const unarchiveReadback = new AppServerRpcError(
    'failed to unarchive session: thread-store internal error: failed to read unarchived thread',
    { rpcCode: -32603 },
  );

  assert.deepEqual(classifyCodexServiceError(methodMissing), {
    kind: ERROR_KINDS.UNAVAILABLE,
    code: 'APP_SERVER_RPC_ERROR',
    rpcCode: -32601,
    retryable: false,
    uncertain: false,
  });
  assert.deepEqual(classifyCodexServiceError(steerConflict), {
    kind: ERROR_KINDS.CONFLICT,
    code: 'APP_SERVER_RPC_ERROR',
    rpcCode: -32602,
    retryable: false,
    uncertain: false,
  });
  assert.deepEqual(classifyCodexServiceError(timeout, { mutation: true }), {
    kind: ERROR_KINDS.UNCERTAIN,
    code: 'APP_SERVER_RPC_TIMEOUT',
    rpcCode: null,
    retryable: false,
    uncertain: true,
  });
  assert.deepEqual(classifyCodexServiceError(incompatible), {
    kind: ERROR_KINDS.INCOMPATIBLE,
    code: 'APP_SERVER_SCHEMA_MISMATCH',
    rpcCode: null,
    retryable: false,
    uncertain: false,
  });
  assert.deepEqual(classifyCodexServiceError(unarchiveReadback, { mutation: true }), {
    kind: ERROR_KINDS.UNCERTAIN,
    code: 'APP_SERVER_RPC_ERROR',
    rpcCode: -32603,
    retryable: false,
    uncertain: true,
  });
});
