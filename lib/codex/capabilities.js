'use strict';

const { REQUEST_METHODS } = require('../app-server/methods');
const { validateSchemaProfile } = require('../app-server/schema-profile');
const { CapabilityUnavailableError } = require('./errors');

const CAPABILITY_MODES = Object.freeze({
  RPC: 'rpc',
  BRIDGE: 'bridge',
  UI_EXPLICIT: 'uiExplicit',
  UNAVAILABLE: 'unavailable',
});

const FOCUS_POLICY = 'rpc-zero-focus-ui-explicit-restore';

const RPC_OPERATIONS = Object.freeze({
  'thread.list': REQUEST_METHODS.THREAD_LIST,
  'thread.read': REQUEST_METHODS.THREAD_READ,
  'thread.turns.list': REQUEST_METHODS.THREAD_TURNS_LIST,
  'thread.start': REQUEST_METHODS.THREAD_START,
  'thread.resume': REQUEST_METHODS.THREAD_RESUME,
  'thread.fork': REQUEST_METHODS.THREAD_FORK,
  'thread.archive': REQUEST_METHODS.THREAD_ARCHIVE,
  'thread.unarchive': REQUEST_METHODS.THREAD_UNARCHIVE,
  'thread.rename': REQUEST_METHODS.THREAD_SET_NAME,
  'thread.compact': REQUEST_METHODS.THREAD_COMPACT,
  'thread.settings': REQUEST_METHODS.THREAD_SETTINGS_UPDATE,
  'turn.start': REQUEST_METHODS.TURN_START,
  'turn.interrupt': REQUEST_METHODS.TURN_INTERRUPT,
  'turn.steer': REQUEST_METHODS.TURN_STEER,
  'model.list': REQUEST_METHODS.MODEL_LIST,
  'collaborationMode.list': REQUEST_METHODS.COLLABORATION_MODE_LIST,
});

const BRIDGE_OPERATIONS = Object.freeze({
  'turn.queueNext': Object.freeze({ persistent: true }),
});

const UI_EXPLICIT_OPERATIONS = Object.freeze({
  'composer.plus': Object.freeze({ requiresUserTap: true, restoresWindowState: true }),
});

function unavailable(reason, extra = {}) {
  return { mode: CAPABILITY_MODES.UNAVAILABLE, reason, ...extra };
}

function createCapabilityManifest(options = {}) {
  const profile = validateSchemaProfile(options.profile);
  const supportedMethods = new Set(Array.isArray(options.supportedMethods) ? options.supportedMethods : []);
  const bridgeOperations = new Set(Array.isArray(options.bridgeOperations) ? options.bridgeOperations : []);
  const uiExplicitOperations = new Set(Array.isArray(options.uiExplicitOperations) ? options.uiExplicitOperations : []);
  const disabled = options.unavailableOperations && typeof options.unavailableOperations === 'object'
    ? options.unavailableOperations
    : {};
  const operations = {};

  for (const [operation, method] of Object.entries(RPC_OPERATIONS)) {
    if (Object.hasOwn(disabled, operation)) {
      operations[operation] = unavailable(String(disabled[operation]), { method });
    } else if (supportedMethods.has(method)) {
      operations[operation] = {
        mode: CAPABILITY_MODES.RPC,
        method,
        ...(operation === 'turn.steer' ? { requiresExpectedTurnId: true } : {}),
      };
    } else {
      operations[operation] = unavailable('methodUnsupported', { method });
    }
  }

  for (const [operation, details] of Object.entries(BRIDGE_OPERATIONS)) {
    if (Object.hasOwn(disabled, operation)) {
      operations[operation] = unavailable(String(disabled[operation]));
    } else if (bridgeOperations.has(operation)) {
      operations[operation] = { mode: CAPABILITY_MODES.BRIDGE, ...details };
    } else {
      operations[operation] = unavailable('bridgeUnavailable');
    }
  }

  for (const [operation, details] of Object.entries(UI_EXPLICIT_OPERATIONS)) {
    if (Object.hasOwn(disabled, operation)) {
      operations[operation] = unavailable(String(disabled[operation]));
    } else if (uiExplicitOperations.has(operation)) {
      operations[operation] = { mode: CAPABILITY_MODES.UI_EXPLICIT, ...details };
    } else {
      operations[operation] = unavailable('uiAdapterUnavailable');
    }
  }

  for (const [operation, reason] of Object.entries(disabled)) {
    if (!Object.hasOwn(operations, operation)) {
      operations[operation] = unavailable(String(reason));
    }
  }

  return {
    protocolProfile: profile.id,
    schemaVersion: profile.schemaVersion,
    schemaHash: profile.schema.sha256,
    codexHomeFingerprint: String(options.codexHomeFingerprint || ''),
    focusPolicy: FOCUS_POLICY,
    operations,
  };
}

function requireCapability(manifest, operation) {
  const capability = manifest && manifest.operations
    ? manifest.operations[operation]
    : null;
  if (!capability || capability.mode === CAPABILITY_MODES.UNAVAILABLE) {
    throw new CapabilityUnavailableError(operation, capability ? capability.reason : 'notNegotiated');
  }
  return capability;
}

module.exports = {
  BRIDGE_OPERATIONS,
  CAPABILITY_MODES,
  FOCUS_POLICY,
  RPC_OPERATIONS,
  UI_EXPLICIT_OPERATIONS,
  createCapabilityManifest,
  requireCapability,
};
