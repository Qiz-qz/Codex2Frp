'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSchemaProfile } = require('../lib/app-server/schema-profile');
const { REQUEST_METHODS } = require('../lib/app-server/methods');
const {
  CAPABILITY_MODES,
  FOCUS_POLICY,
  createCapabilityManifest,
  requireCapability,
} = require('../lib/codex/capabilities');
const { CapabilityUnavailableError } = require('../lib/codex/errors');
const {
  capabilityState,
  createConfirmedControls,
  validateCollaborationCatalog,
} = require('../lib/codex/capability-state');

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');
const PROFILE_0144_2_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144_2-profile.json');

function profile() {
  return loadSchemaProfile(PROFILE_FILE);
}

function state(overrides = {}) {
  return {
    available: true,
    ready: true,
    confirmed: false,
    readbackSupported: false,
    source: 'appServer',
    reason: null,
    ...overrides,
  };
}

test('method inventory does not imply runtime readiness', () => {
  const state = capabilityState({
    methodPresent: true,
    runtimeReady: false,
    source: 'appServer',
  });

  assert.deepEqual(state, {
    available: true,
    ready: false,
    confirmed: false,
    readbackSupported: false,
    source: 'appServer',
    reason: 'runtime_not_ready',
  });
});

test('new thread is confirmed only after the returned id can be read', async () => {
  const threadId = '11111111-2222-4333-8444-555555555555';
  const calls = [];
  const controls = createConfirmedControls({
    async startThread(params) {
      calls.push({ method: 'startThread', params });
      return { thread: { id: threadId } };
    },
    async readThread(params) {
      calls.push({ method: 'readThread', params });
      return { thread: { id: threadId } };
    },
  });

  assert.deepEqual(await controls.startThread({ model: 'gpt-5.5' }), {
    status: 'confirmed',
    operation: 'thread.start',
    observation: { threadId },
  });
  assert.deepEqual(calls, [
    { method: 'startThread', params: { model: 'gpt-5.5' } },
    { method: 'readThread', params: { threadId, includeTurns: false } },
  ]);
});

test('new thread remains uncertain when the returned id cannot be read', async () => {
  const threadId = '11111111-2222-4333-8444-555555555555';
  const controls = createConfirmedControls({
    async startThread() { return { thread: { id: threadId } }; },
    async readThread() { throw new Error('not materialized'); },
  });

  assert.deepEqual(await controls.startThread({ model: 'gpt-5.5' }), {
    status: 'uncertain',
    operation: 'thread.start',
    reason: 'thread_readback_failed',
    observation: { threadId },
  });
});

test('settings without authoritative readback return confirmed-request shadow provenance', async () => {
  const calls = [];
  const controls = createConfirmedControls({
    async updateThreadSettings(params) {
      calls.push(params);
      return {};
    },
  });
  const request = {
    threadId: '11111111-2222-4333-8444-555555555555',
    model: 'gpt-5.5',
    effort: 'high',
  };

  assert.deepEqual(await controls.updateThreadSettings(request), {
    status: 'confirmed',
    operation: 'thread.settings',
    observation: {
      source: 'confirmedRequest',
      readbackSupported: false,
      settings: { model: 'gpt-5.5', effort: 'high' },
    },
  });
  assert.deepEqual(calls, [request]);
});

test('settings expose the exact desktop RPC sourced target returned by the adapter', async () => {
  const controls = createConfirmedControls({
    async updateThreadSettings() {
      return {
        target: {
          source: 'desktopInternalRpc',
          threadId: '11111111-2222-4333-8444-555555555555',
          model: 'gpt-5.5',
          effort: 'high',
        },
      };
    },
  });

  const response = await controls.updateThreadSettings({
    threadId: '11111111-2222-4333-8444-555555555555',
    model: 'gpt-5.5',
    effort: 'high',
  });
  assert.equal(response.observation.source, 'desktopInternalRpc');
  assert.equal(response.observation.target.source, 'desktopInternalRpc');
  assert.equal(response.observation.target.model, 'gpt-5.5');
  assert.equal(response.observation.target.effort, 'high');
});

test('turn start confirmation exposes a stable turn id observation', async () => {
  const controls = createConfirmedControls({
    async startTurn() { return { turn: { id: 'turn-1' } }; },
  });

  assert.deepEqual(await controls.startTurn({ threadId: 'thread-1', input: [] }), {
    status: 'confirmed',
    operation: 'turn.start',
    observation: { turnId: 'turn-1' },
  });
});

test('collaboration diagnostics keep only complete presets and never synthesize a mode', () => {
  const catalog = {
    data: [{
      name: 'Plan',
      value: { mode: 'plan', settings: { reasoning_effort: 'high' } },
    }, {
      name: 'Incomplete preset',
      value: { mode: 'future' },
    }, {
      name: 'Plugin',
      plugin: { id: 'x' },
    }, {
      name: 'Subagent',
      subagent: { name: 'worker' },
    }],
  };

  assert.deepEqual(validateCollaborationCatalog(catalog), {
    data: [catalog.data[0]],
  });
  assert.deepEqual(
    validateCollaborationCatalog({
      data: [
        { name: 'Future preset without settings', value: { mode: 'future' } },
        { name: 'Plugin', plugin: { id: 'x' } },
        { name: 'Subagent', subagent: { name: 'worker' } },
      ],
      nextCursor: null,
    }),
    { data: [], nextCursor: null },
  );
});

test('current negotiated inventory exposes permission and plugin methods but not collaboration control', () => {
  const current = loadSchemaProfile(PROFILE_0144_2_FILE);
  const manifest = createCapabilityManifest({
    profile: current,
    supportedMethods: current.requestMethods,
    runtimeReady: true,
  });

  assert.equal(manifest.operations['permissionProfile.list'].ready, true);
  assert.equal(manifest.operations['plugin.list'].ready, true);
  assert.equal(manifest.operations['plugin.install'].ready, true);
  assert.deepEqual(manifest.operations['collaborationMode.list'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    method: 'collaborationMode/list',
    available: true,
    ready: false,
    confirmed: false,
    readbackSupported: false,
    source: 'appServer',
    reason: 'desktop_ui_not_verified',
  });
});

test('capability manifest classifies each operation as rpc, bridge, uiExplicit, or unavailable', () => {
  const manifest = createCapabilityManifest({
    profile: profile(),
    codexHomeFingerprint: 'sha256:test-home',
    supportedMethods: [
      REQUEST_METHODS.THREAD_LIST,
      REQUEST_METHODS.THREAD_FORK,
      REQUEST_METHODS.THREAD_COMPACT,
      REQUEST_METHODS.THREAD_SETTINGS_UPDATE,
      REQUEST_METHODS.MODEL_LIST,
      REQUEST_METHODS.TURN_START,
      REQUEST_METHODS.TURN_INTERRUPT,
      REQUEST_METHODS.TURN_STEER,
    ],
    bridgeOperations: ['turn.queueNext'],
    uiExplicitOperations: ['composer.plus'],
    unavailableOperations: {
      'turn.interrupt': 'disabledByPolicy',
      'desktop.restart': 'notNegotiated',
    },
    runtimeReady: true,
  });

  assert.equal(manifest.protocolProfile, 'app-server-v0144');
  assert.equal(manifest.schemaVersion, '0.144.0-alpha.4');
  assert.equal(manifest.schemaHash, profile().schema.sha256);
  assert.equal(manifest.codexHomeFingerprint, 'sha256:test-home');
  assert.equal(manifest.focusPolicy, FOCUS_POLICY);
  assert.deepEqual(manifest.operations['thread.list'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/list',
    ...state({ readbackSupported: true }),
  });
  assert.deepEqual(manifest.operations['turn.steer'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'turn/steer',
    ...state(),
    requiresExpectedTurnId: true,
  });
  assert.deepEqual(manifest.operations['thread.fork'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/fork',
    ...state(),
  });
  assert.deepEqual(manifest.operations['thread.compact'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/compact/start',
    ...state(),
  });
  assert.deepEqual(manifest.operations['thread.settings'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/settings/update',
    ...state(),
  });
  assert.deepEqual(manifest.operations['model.list'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'model/list',
    ...state({ readbackSupported: true }),
  });
  assert.deepEqual(manifest.operations['turn.queueNext'], {
    mode: CAPABILITY_MODES.BRIDGE,
    ...state({ source: 'bridge' }),
    persistent: true,
  });
  assert.deepEqual(manifest.operations['composer.plus'], {
    mode: CAPABILITY_MODES.UI_EXPLICIT,
    ...state({ source: 'desktopUi' }),
    requiresUserTap: true,
    restoresWindowState: true,
  });
  assert.deepEqual(manifest.operations['thread.archive'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    ...state({ available: false, ready: false, reason: 'method_missing' }),
    method: 'thread/archive',
  });
  assert.deepEqual(manifest.operations['turn.interrupt'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    method: 'turn/interrupt',
    ...state({ ready: false, reason: 'disabledByPolicy' }),
  });
  assert.deepEqual(manifest.operations['desktop.restart'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    ...state({ available: false, ready: false, source: 'policy', reason: 'notNegotiated' }),
  });
  assert.equal(Object.hasOwn(manifest, 'codexHome'), false);

  const validModes = new Set(Object.values(CAPABILITY_MODES));
  for (const capability of Object.values(manifest.operations)) {
    assert.equal(validModes.has(capability.mode), true);
  }
});

test('bridge and UI-only capabilities stay unavailable until their adapters are explicitly enabled', () => {
  const manifest = createCapabilityManifest({
    profile: profile(),
    supportedMethods: [],
  });

  assert.deepEqual(manifest.operations['turn.queueNext'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    ...state({ available: false, ready: false, source: 'bridge', reason: 'bridge_unavailable' }),
  });
  assert.deepEqual(manifest.operations['composer.plus'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    ...state({ available: false, ready: false, source: 'desktopUi', reason: 'ui_adapter_unavailable' }),
  });
  assert.deepEqual(manifest.operations['thread.list'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    method: 'thread/list',
    ...state({ available: false, ready: false, readbackSupported: true, reason: 'method_missing' }),
  });
});

test('requireCapability returns usable operations and throws a stable error for unavailable or unknown ones', () => {
  const manifest = createCapabilityManifest({
    profile: profile(),
    supportedMethods: [REQUEST_METHODS.THREAD_LIST],
    runtimeReady: true,
  });

  assert.equal(requireCapability(manifest, 'thread.list').method, 'thread/list');
  assert.throws(() => requireCapability(manifest, 'thread.archive'), error => {
    assert.equal(error instanceof CapabilityUnavailableError, true);
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(error.details, { operation: 'thread.archive', reason: 'method_missing' });
    return true;
  });
  assert.throws(() => requireCapability(manifest, 'future.operation'), error => {
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(error.details, { operation: 'future.operation', reason: 'notNegotiated' });
    return true;
  });
});
