'use strict';

const { NEGOTIATED_REQUEST_METHODS, REQUEST_METHODS } = require('../app-server/methods');
const { validateSchemaProfile } = require('../app-server/schema-profile');
const { CapabilityUnavailableError } = require('./errors');
const { capabilityState } = require('./capability-state');

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
  'permissionProfile.list': NEGOTIATED_REQUEST_METHODS.PERMISSION_PROFILE_LIST,
  'plugin.list': NEGOTIATED_REQUEST_METHODS.PLUGIN_LIST,
  'plugin.installed': NEGOTIATED_REQUEST_METHODS.PLUGIN_INSTALLED,
  'plugin.read': NEGOTIATED_REQUEST_METHODS.PLUGIN_READ,
  'plugin.skill.read': NEGOTIATED_REQUEST_METHODS.PLUGIN_SKILL_READ,
  'plugin.install': NEGOTIATED_REQUEST_METHODS.PLUGIN_INSTALL,
  'plugin.uninstall': NEGOTIATED_REQUEST_METHODS.PLUGIN_UNINSTALL,
  'collaborationMode.list': REQUEST_METHODS.COLLABORATION_MODE_LIST,
});

const READBACK_OPERATIONS = new Set([
  'thread.list',
  'thread.read',
  'thread.turns.list',
  'thread.start',
  'model.list',
  'permissionProfile.list',
  'plugin.list',
  'plugin.installed',
  'plugin.read',
  'plugin.skill.read',
]);

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
  const runtimeReady = options.runtimeReady === true;

  for (const [operation, method] of Object.entries(RPC_OPERATIONS)) {
    const methodPresent = supportedMethods.has(method);
    if (operation === 'collaborationMode.list') {
      operations[operation] = {
        ...unavailable('desktop_ui_not_verified', { method }),
        ...capabilityState({
          methodPresent,
          runtimeReady: false,
          source: 'appServer',
          reason: 'desktop_ui_not_verified',
        }),
      };
    } else if (Object.hasOwn(disabled, operation)) {
      operations[operation] = {
        ...unavailable(String(disabled[operation]), { method }),
        ...capabilityState({
          methodPresent,
          runtimeReady: false,
          source: 'appServer',
          readbackSupported: READBACK_OPERATIONS.has(operation),
          reason: String(disabled[operation]),
        }),
      };
    } else if (supportedMethods.has(method)) {
      operations[operation] = {
        mode: CAPABILITY_MODES.RPC,
        method,
        ...capabilityState({
          methodPresent: true,
          runtimeReady,
          source: 'appServer',
          readbackSupported: READBACK_OPERATIONS.has(operation),
        }),
        ...(operation === 'turn.steer' ? { requiresExpectedTurnId: true } : {}),
      };
    } else {
      operations[operation] = {
        ...unavailable('method_missing', { method }),
        ...capabilityState({
          methodPresent: false,
          runtimeReady,
          source: 'appServer',
          readbackSupported: READBACK_OPERATIONS.has(operation),
        }),
      };
    }
  }

  for (const [operation, details] of Object.entries(BRIDGE_OPERATIONS)) {
    if (Object.hasOwn(disabled, operation)) {
      operations[operation] = {
        ...unavailable(String(disabled[operation])),
        ...capabilityState({ methodPresent: true, runtimeReady: false, source: 'bridge', reason: String(disabled[operation]) }),
      };
    } else if (bridgeOperations.has(operation)) {
      operations[operation] = {
        mode: CAPABILITY_MODES.BRIDGE,
        ...capabilityState({ methodPresent: true, runtimeReady, source: 'bridge' }),
        ...details,
      };
    } else {
      operations[operation] = {
        ...unavailable('bridge_unavailable'),
        ...capabilityState({ methodPresent: false, runtimeReady, source: 'bridge', reason: 'bridge_unavailable' }),
      };
    }
  }

  for (const [operation, details] of Object.entries(UI_EXPLICIT_OPERATIONS)) {
    if (Object.hasOwn(disabled, operation)) {
      operations[operation] = {
        ...unavailable(String(disabled[operation])),
        ...capabilityState({ methodPresent: true, runtimeReady: false, source: 'desktopUi', reason: String(disabled[operation]) }),
      };
    } else if (uiExplicitOperations.has(operation)) {
      operations[operation] = {
        mode: CAPABILITY_MODES.UI_EXPLICIT,
        ...capabilityState({ methodPresent: true, runtimeReady: true, source: 'desktopUi' }),
        ...details,
      };
    } else {
      operations[operation] = {
        ...unavailable('ui_adapter_unavailable'),
        ...capabilityState({ methodPresent: false, runtimeReady: false, source: 'desktopUi', reason: 'ui_adapter_unavailable' }),
      };
    }
  }

  for (const [operation, reason] of Object.entries(disabled)) {
    if (!Object.hasOwn(operations, operation)) {
      operations[operation] = {
        ...unavailable(String(reason)),
        ...capabilityState({ methodPresent: false, runtimeReady: false, source: 'policy', reason: String(reason) }),
      };
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
  if (!capability || capability.mode === CAPABILITY_MODES.UNAVAILABLE || capability.ready !== true) {
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
