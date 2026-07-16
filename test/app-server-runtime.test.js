'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { loadSchemaProfile } = require('../lib/app-server/schema-profile');
const { AppServerRuntime } = require('../lib/app-server/runtime');

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');
const PROFILE_0144_2_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144_2-profile.json');
const CODEX_HOME = 'E:\\isolated\\runtime-home';

class FakeProcessManager extends EventEmitter {
  constructor() {
    super();
    this.startCalls = [];
    this.stopCalls = [];
    this.sequence = 0;
    this.stopResult = true;
  }

  start(options) {
    this.startCalls.push(options);
    const connectionEpoch = ++this.sequence;
    const client = new EventEmitter();
    client.connectionEpoch = connectionEpoch;
    client.serverRequestResponses = [];
    client.respondServerRequest = (id, result, responseOptions) => {
      client.serverRequestResponses.push({ id, result, options: responseOptions });
      return true;
    };
    return {
      pid: 4100 + connectionEpoch,
      connectionEpoch,
      client,
    };
  }

  stop(signal) {
    this.stopCalls.push(signal);
    return this.stopResult;
  }
}

function createHarness(options = {}) {
  const processManager = new FakeProcessManager();
  const services = [];
  const factoryCalls = [];
  const createService = serviceOptions => {
    factoryCalls.push(serviceOptions);
    const service = {
      initializeCalls: [],
      async initialize(params) {
        this.initializeCalls.push(params);
        if (options.initialize) return options.initialize(params);
        return {
          codexHome: CODEX_HOME,
          platformFamily: 'windows',
          platformOs: 'windows',
          userAgent: 'codex_cli_rs/0.144.0-alpha.4 (Windows 11)',
        };
      },
      ...options.serviceMethods,
    };
    services.push(service);
    return service;
  };
  const runtime = new AppServerRuntime({
    processManager,
    createService,
    schemaProfile: loadSchemaProfile(options.profileFile || PROFILE_FILE),
    codexHome: CODEX_HOME,
    initializeParams: {
      clientInfo: { name: 'codex2frp', title: 'Codex2Frp', version: '2.2.0' },
      capabilities: { experimentalApi: true },
    },
    backendVersion: '2.2.0',
    desktopVersion: '1.2026.154',
    cliVersion: '0.144.0-alpha.4',
    bridgeOperations: ['turn.queueNext'],
    notificationSink: options.notificationSink,
    serverRequestSink: options.serverRequestSink,
    serverRequestLifecycleSink: options.serverRequestLifecycleSink,
    confirmedNativeControls: options.confirmedNativeControls,
  });
  return { runtime, processManager, services, factoryCalls };
}

test('runtime capability metadata uses the full negotiated request inventory', async () => {
  const { runtime } = createHarness({ profileFile: PROFILE_0144_2_FILE });
  let operations = runtime.getMeta().capabilities.operations;
  for (const operation of ['permissionProfile.list', 'plugin.list']) {
    assert.deepEqual({
      mode: operations[operation].mode,
      available: operations[operation].available,
      readbackSupported: operations[operation].readbackSupported,
      reason: operations[operation].reason,
    }, {
      mode: 'rpc',
      available: true,
      readbackSupported: true,
      reason: 'runtime_not_ready',
    });
  }
  await runtime.ensureStarted();
  operations = runtime.getMeta().capabilities.operations;
  for (const operation of ['permissionProfile.list', 'plugin.list']) {
    assert.equal(operations[operation].ready, true);
    assert.equal(operations[operation].reason, null);
  }
});

test('runtime forwards passive RPC notifications and removes only its listener on stop', async () => {
  const notifications = [];
  const harness = createHarness({
    notificationSink: notification => notifications.push(notification),
  });
  await harness.runtime.ensureStarted();
  const client = harness.factoryCalls[0].rpcClient;
  const unrelated = () => {};
  client.on('notification', unrelated);

  client.emit('notification', {
    connectionEpoch: 1,
    sequence: 7,
    method: 'thread/status/changed',
    params: { threadId: 'thread-safe' },
  });
  await Promise.resolve();
  assert.deepEqual(notifications, [{
    connectionEpoch: 1,
    sequence: 7,
    method: 'thread/status/changed',
    params: { threadId: 'thread-safe' },
  }]);

  harness.runtime.stop();
  assert.equal(client.listeners('notification').includes(unrelated), true);
  assert.equal(client.listenerCount('notification'), 1);
});

test('runtime forwards server requests through a private one-request response closure', async () => {
  const serverRequests = [];
  const harness = createHarness({
    serverRequestSink: request => serverRequests.push(request),
  });
  await harness.runtime.ensureStarted();
  const client = harness.factoryCalls[0].rpcClient;
  client.emit('serverRequest', {
    id: 'private-server-request-id',
    method: 'item/tool/requestUserInput',
    params: { syntheticQuestion: 'fixture-only' },
    connectionEpoch: 1,
  });
  await Promise.resolve();

  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].method, 'item/tool/requestUserInput');
  assert.deepEqual(serverRequests[0].params, { syntheticQuestion: 'fixture-only' });
  assert.equal(serverRequests[0].connectionEpoch, 1);
  assert.equal(serverRequests[0].requestId, 'private-server-request-id');
  assert.equal(Object.hasOwn(serverRequests[0], 'id'), false);
  assert.equal(typeof serverRequests[0].respond, 'function');
  assert.equal(JSON.stringify(harness.runtime.getMeta()).includes('fixture-only'), false);

  serverRequests[0].respond({ answers: ['accepted'] });
  assert.deepEqual(client.serverRequestResponses, [{
    id: 'private-server-request-id',
    result: { answers: ['accepted'] },
    options: { connectionEpoch: 1 },
  }]);
});

test('runtime drops stale-epoch server requests and disables captured responders after stop', async () => {
  const serverRequests = [];
  const harness = createHarness({
    serverRequestSink: request => serverRequests.push(request),
  });
  await harness.runtime.ensureStarted();
  const client = harness.factoryCalls[0].rpcClient;
  client.emit('serverRequest', {
    id: 'stale-request-id',
    method: 'item/tool/requestUserInput',
    params: { syntheticQuestion: 'stale' },
    connectionEpoch: 0,
  });
  client.emit('serverRequest', {
    id: 'current-request-id',
    method: 'item/tool/requestUserInput',
    params: { syntheticQuestion: 'current' },
    connectionEpoch: 1,
  });
  await Promise.resolve();

  assert.equal(serverRequests.length, 1);
  assert.equal(serverRequests[0].params.syntheticQuestion, 'current');
  assert.equal(harness.runtime.stop(), true);
  assert.throws(
    () => serverRequests[0].respond({ answers: ['too-late'] }),
    error => error && error.code === 'APP_SERVER_CONNECTION_CLOSED'
      && JSON.stringify(error.details).includes('current-request-id') === false,
  );
  assert.deepEqual(client.serverRequestResponses, []);
  assert.equal(client.listenerCount('serverRequest'), 0);
});

test('a rejected stop keeps the owned notification listener attached to the live client', async () => {
  const notifications = [];
  const harness = createHarness({
    notificationSink: notification => notifications.push(notification),
  });
  await harness.runtime.ensureStarted();
  const client = harness.factoryCalls[0].rpcClient;
  harness.processManager.stopResult = false;

  assert.equal(harness.runtime.stop(), false);
  assert.equal(harness.runtime.getMeta().appServer.state, 'ready');
  assert.equal(client.listenerCount('notification'), 1);
  client.emit('notification', { connectionEpoch: 1, sequence: 8, method: 'turn/started' });
  await Promise.resolve();
  assert.deepEqual(notifications, [
    { connectionEpoch: 1, sequence: 8, method: 'turn/started' },
  ]);
});

test('metadata and capabilities are available without starting app-server or exposing CODEX_HOME', () => {
  const { runtime, processManager } = createHarness();
  const meta = runtime.getMeta();

  assert.equal(processManager.startCalls.length, 0);
  assert.equal(meta.apiVersion, 3);
  assert.deepEqual(meta.versions, {
    backend: '2.2.0',
    desktop: '1.2026.154',
    cli: '0.144.0-alpha.4',
  });
  assert.equal(meta.protocol.profile, 'app-server-v0144');
  assert.equal(meta.protocol.schemaVersion, '0.144.0-alpha.4');
  assert.match(meta.codexHomeFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(meta).includes(CODEX_HOME), false);
  assert.deepEqual(meta.appServer, {
    state: 'stopped',
    pid: null,
    connectionEpoch: 0,
  });
  assert.equal(meta.capabilities.operations['thread.list'].mode, 'rpc');
  assert.equal(meta.capabilities.operations['thread.list'].available, true);
  assert.equal(meta.capabilities.operations['thread.list'].ready, false);
  assert.equal(meta.capabilities.operations['thread.list'].reason, 'runtime_not_ready');
  assert.equal(meta.capabilities.operations['turn.queueNext'].mode, 'bridge');
  assert.equal(meta.capabilities.operations['composer.plus'].mode, 'unavailable');
});

test('runtime reports closed request epochs exactly once on stop and process exit', async () => {
  const lifecycle = [];
  const harness = createHarness({
    serverRequestLifecycleSink: event => lifecycle.push(event),
  });
  await harness.runtime.ensureStarted();
  assert.equal(harness.runtime.stop(), true);
  assert.deepEqual(lifecycle, [{ type: 'connectionClosed', connectionEpoch: 1 }]);

  harness.processManager.emit('exit', {
    pid: 4101, connectionEpoch: 1, code: 0, signal: 'SIGTERM',
  });
  assert.deepEqual(lifecycle, [{ type: 'connectionClosed', connectionEpoch: 1 }]);

  await harness.runtime.ensureStarted();
  harness.processManager.emit('exit', {
    pid: 4102, connectionEpoch: 2, code: 1, signal: null,
  });
  assert.deepEqual(lifecycle, [
    { type: 'connectionClosed', connectionEpoch: 1 },
    { type: 'connectionClosed', connectionEpoch: 2 },
  ]);
});

test('runtime readiness dynamically enables negotiated methods without version checks', async () => {
  const { runtime } = createHarness();
  assert.equal(runtime.getMeta().capabilities.operations['model.list'].ready, false);

  await runtime.ensureStarted();

  const models = runtime.getMeta().capabilities.operations['model.list'];
  assert.equal(models.available, true);
  assert.equal(models.ready, true);
  assert.equal(models.reason, null);
  assert.equal(models.source, 'appServer');
});

test('runtime installs confirmed controls above the low-level service when production enables them', async () => {
  const threadId = '11111111-2222-4333-8444-555555555555';
  const harness = createHarness({
    confirmedNativeControls: true,
    serviceMethods: {
      async startThread() { return { thread: { id: threadId } }; },
      async readThread() { return { thread: { id: threadId } }; },
      async updateThreadSettings() { return {}; },
    },
  });
  const controls = await harness.runtime.ensureStarted();

  assert.deepEqual(await controls.startThread({ model: 'gpt-5.5' }), {
    status: 'confirmed',
    operation: 'thread.start',
    observation: { threadId },
  });
  assert.deepEqual(await controls.updateThreadSettings({ threadId, effort: 'high' }), {
    status: 'confirmed',
    operation: 'thread.settings',
    observation: {
      source: 'confirmedRequest',
      readbackSupported: false,
      settings: { effort: 'high' },
    },
  });
});

test('concurrent consumers coalesce one lazy start and initialize before service use', async () => {
  let releaseInitialize;
  const initializeGate = new Promise(resolve => { releaseInitialize = resolve; });
  const harness = createHarness({ initialize: () => initializeGate });
  const first = harness.runtime.ensureStarted();
  const second = harness.runtime.withService(service => ({ service, marker: 'used' }));

  assert.equal(harness.processManager.startCalls.length, 1);
  assert.equal(harness.runtime.getMeta().appServer.state, 'starting');
  releaseInitialize({ ok: true });

  const [firstService, secondResult] = await Promise.all([first, second]);
  assert.equal(firstService, secondResult.service);
  assert.equal(secondResult.marker, 'used');
  assert.equal(harness.processManager.startCalls.length, 1);
  assert.equal(harness.services.length, 1);
  assert.deepEqual(harness.processManager.startCalls[0], { codexHome: CODEX_HOME });
  assert.deepEqual(harness.services[0].initializeCalls, [{
    clientInfo: { name: 'codex2frp', title: 'Codex2Frp', version: '2.2.0' },
    capabilities: { experimentalApi: true },
  }]);
  assert.deepEqual(harness.runtime.getMeta().appServer, {
    state: 'ready',
    pid: 4101,
    connectionEpoch: 1,
  });
  assert.equal(Object.hasOwn(harness.factoryCalls[0], 'focus'), false);
  assert.equal(Object.hasOwn(harness.factoryCalls[0], 'window'), false);
});

test('stop during initialize invalidates that lifecycle generation and cannot resurrect ready state', async () => {
  let releaseInitialize;
  const initializeGate = new Promise(resolve => { releaseInitialize = resolve; });
  const harness = createHarness({ initialize: () => initializeGate });
  const starting = harness.runtime.ensureStarted();
  assert.equal(harness.runtime.getMeta().appServer.state, 'starting');

  assert.equal(harness.runtime.stop(), true);
  assert.equal(harness.runtime.getMeta().appServer.state, 'stopping');
  releaseInitialize({ ok: true });
  await assert.rejects(starting, error => error && error.code === 'APP_SERVER_CONNECTION_CLOSED');
  assert.equal(harness.runtime.getMeta().appServer.state, 'stopping');

  harness.processManager.emit('exit', { pid: 4101, connectionEpoch: 1, code: 0, signal: 'SIGTERM' });
  assert.equal(harness.runtime.getMeta().appServer.state, 'stopped');
  assert.equal(harness.processManager.startCalls.length, 1);
});

test('failed initialization stops only the owned child and allows a later lazy retry', async () => {
  let attempts = 0;
  const harness = createHarness({
    initialize: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('initialize failed');
      return { ok: true };
    },
  });

  await assert.rejects(harness.runtime.ensureStarted(), /initialize failed/);
  assert.deepEqual(harness.processManager.stopCalls, ['SIGTERM']);
  assert.deepEqual(harness.runtime.getMeta().appServer, {
    state: 'stopped',
    pid: null,
    connectionEpoch: 1,
  });

  await harness.runtime.ensureStarted();
  assert.equal(harness.processManager.startCalls.length, 2);
  assert.equal(harness.runtime.getMeta().appServer.state, 'ready');
  assert.equal(harness.runtime.getMeta().appServer.connectionEpoch, 2);
});

test('matching process exit invalidates the service while stale exits cannot clear a newer epoch', async () => {
  const harness = createHarness();
  await harness.runtime.ensureStarted();
  harness.processManager.emit('exit', { pid: 9999, connectionEpoch: 0, code: 0, signal: null });
  assert.equal(harness.runtime.getMeta().appServer.state, 'ready');

  harness.processManager.emit('exit', { pid: 4101, connectionEpoch: 1, code: 0, signal: null });
  assert.deepEqual(harness.runtime.getMeta().appServer, {
    state: 'stopped',
    pid: null,
    connectionEpoch: 1,
  });

  await harness.runtime.ensureStarted();
  assert.equal(harness.processManager.startCalls.length, 2);
});
