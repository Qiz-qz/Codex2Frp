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

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');

function profile() {
  return loadSchemaProfile(PROFILE_FILE);
}

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
  });

  assert.equal(manifest.protocolProfile, 'app-server-v0144');
  assert.equal(manifest.schemaVersion, '0.144.0-alpha.4');
  assert.equal(manifest.schemaHash, profile().schema.sha256);
  assert.equal(manifest.codexHomeFingerprint, 'sha256:test-home');
  assert.equal(manifest.focusPolicy, FOCUS_POLICY);
  assert.deepEqual(manifest.operations['thread.list'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/list',
  });
  assert.deepEqual(manifest.operations['turn.steer'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'turn/steer',
    requiresExpectedTurnId: true,
  });
  assert.deepEqual(manifest.operations['thread.fork'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/fork',
  });
  assert.deepEqual(manifest.operations['thread.compact'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/compact/start',
  });
  assert.deepEqual(manifest.operations['thread.settings'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'thread/settings/update',
  });
  assert.deepEqual(manifest.operations['model.list'], {
    mode: CAPABILITY_MODES.RPC,
    method: 'model/list',
  });
  assert.deepEqual(manifest.operations['turn.queueNext'], {
    mode: CAPABILITY_MODES.BRIDGE,
    persistent: true,
  });
  assert.deepEqual(manifest.operations['composer.plus'], {
    mode: CAPABILITY_MODES.UI_EXPLICIT,
    requiresUserTap: true,
    restoresWindowState: true,
  });
  assert.deepEqual(manifest.operations['thread.archive'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    reason: 'methodUnsupported',
    method: 'thread/archive',
  });
  assert.deepEqual(manifest.operations['turn.interrupt'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    reason: 'disabledByPolicy',
    method: 'turn/interrupt',
  });
  assert.deepEqual(manifest.operations['desktop.restart'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    reason: 'notNegotiated',
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
    reason: 'bridgeUnavailable',
  });
  assert.deepEqual(manifest.operations['composer.plus'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    reason: 'uiAdapterUnavailable',
  });
  assert.deepEqual(manifest.operations['thread.list'], {
    mode: CAPABILITY_MODES.UNAVAILABLE,
    reason: 'methodUnsupported',
    method: 'thread/list',
  });
});

test('requireCapability returns usable operations and throws a stable error for unavailable or unknown ones', () => {
  const manifest = createCapabilityManifest({
    profile: profile(),
    supportedMethods: [REQUEST_METHODS.THREAD_LIST],
  });

  assert.equal(requireCapability(manifest, 'thread.list').method, 'thread/list');
  assert.throws(() => requireCapability(manifest, 'thread.archive'), error => {
    assert.equal(error instanceof CapabilityUnavailableError, true);
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(error.details, { operation: 'thread.archive', reason: 'methodUnsupported' });
    return true;
  });
  assert.throws(() => requireCapability(manifest, 'future.operation'), error => {
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    assert.deepEqual(error.details, { operation: 'future.operation', reason: 'notNegotiated' });
    return true;
  });
});
