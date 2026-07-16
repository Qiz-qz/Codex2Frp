'use strict';

const { createConfirmedControls } = require('../codex/capability-state');

const DESKTOP_SERVICE_METHODS = Object.freeze([
  'listModels',
  'startThread',
  'readThread',
  'updateThreadSettings',
  'startTurn',
  'interruptTurn',
  'steerTurn',
]);

const DESKTOP_CAPABILITY_OPERATIONS = Object.freeze({
  'model.list': 'model/list',
  'thread.start': 'thread/start',
  'thread.read': 'thread/read',
  'thread.settings': 'thread/settings/update',
  'turn.start': 'turn/start',
  'turn.interrupt': 'turn/interrupt',
  'turn.steer': 'turn/steer',
});

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function independentFacade(runtime, desktopAdapter) {
  const directService = {};
  for (const method of DESKTOP_SERVICE_METHODS) {
    if (typeof desktopAdapter[method] === 'function') {
      directService[method] = desktopAdapter[method].bind(desktopAdapter);
    }
  }
  const confirmedDesktopService = createConfirmedControls(directService);
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (DESKTOP_SERVICE_METHODS.includes(property)
        && typeof confirmedDesktopService[property] === 'function') {
        return confirmedDesktopService[property].bind(confirmedDesktopService);
      }
      return (...args) => runtime.withService(service => {
        if (!service || typeof service[property] !== 'function') {
          const error = new Error(`Codex service operation is unavailable: ${property}`);
          error.code = 'SERVICE_OPERATION_UNAVAILABLE';
          error.statusCode = 503;
          throw error;
        }
        return service[property](...args);
      });
    },
  });
}

class DesktopControlRuntime {
  constructor(options = {}) {
    if (!options.independentRuntime || typeof options.independentRuntime.getMeta !== 'function'
      || typeof options.independentRuntime.withService !== 'function') {
      throw new TypeError('DesktopControlRuntime requires an independent AppServerRuntime-compatible runtime.');
    }
    if (!options.desktopAdapter || typeof options.desktopAdapter.getStatus !== 'function') {
      throw new TypeError('DesktopControlRuntime requires a desktop internal RPC adapter.');
    }
    this.independentRuntime = options.independentRuntime;
    this.desktopAdapter = options.desktopAdapter;
  }

  getMeta() {
    const base = structuredClone(objectOrEmpty(this.independentRuntime.getMeta()));
    const independentAppServer = structuredClone(objectOrEmpty(base.appServer));
    const desktopInternalRpc = this.desktopAdapter.getStatus();
    const operations = structuredClone(objectOrEmpty(objectOrEmpty(base.capabilities).operations));
    for (const capability of Object.values(operations)) {
      if (capability && capability.source === 'appServer') capability.source = 'independentAppServer';
    }
    for (const [operation, method] of Object.entries(DESKTOP_CAPABILITY_OPERATIONS)) {
      const current = objectOrEmpty(operations[operation]);
      operations[operation] = {
        ...current,
        mode: 'rpc',
        method,
        source: 'desktopInternalRpc',
        methodPresent: true,
        runtimeReady: desktopInternalRpc.ready === true,
        available: desktopInternalRpc.ready === true,
        ready: desktopInternalRpc.ready === true,
        ...(desktopInternalRpc.ready === true
          ? { reason: undefined }
          : { reason: String(desktopInternalRpc.reason || 'desktop_internal_rpc_unavailable') }),
      };
    }
    return {
      ...base,
      independentAppServer,
      desktopInternalRpc,
      capabilities: {
        ...objectOrEmpty(base.capabilities),
        operations,
      },
    };
  }

  withService(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('DesktopControlRuntime.withService requires an operation callback.');
    }
    return operation(independentFacade(this.independentRuntime, this.desktopAdapter));
  }

  stop(signal) {
    return typeof this.independentRuntime.stop === 'function'
      ? this.independentRuntime.stop(signal)
      : false;
  }
}

module.exports = {
  DESKTOP_CAPABILITY_OPERATIONS,
  DESKTOP_SERVICE_METHODS,
  DesktopControlRuntime,
};
