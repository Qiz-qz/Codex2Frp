'use strict';

const MODERN_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

function installExpression(options = {}) {
  const hostId = String(options.hostId || 'local');
  return `(async () => {
    const bridgeKey = '__codex2frpServerRequestBridgeV1';
    const hostId = ${JSON.stringify(hostId)};
    const requestMethods = new Set(${JSON.stringify(MODERN_REQUEST_METHODS)});
    let state = window[bridgeKey];
    if (!state || state.hostId !== hostId || !(state.pending instanceof Map)) {
      const instanceId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      state = { hostId, instanceId, pending: new Map(), listeners: [] };
      const visit = (value, depth, seen) => {
        if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return;
        seen.add(value);
        if ((typeof value.id === 'string' || typeof value.id === 'number')
            && requestMethods.has(String(value.method || ''))
            && value.params && typeof value.params === 'object') {
          state.pending.set(typeof value.id + ':' + String(value.id), {
            id: value.id, method: value.method, params: value.params,
          });
        }
        if (value.method === 'serverRequest/resolved' && value.params
            && (typeof value.params.requestId === 'string' || typeof value.params.requestId === 'number')) {
          state.pending.delete(typeof value.params.requestId + ':' + String(value.params.requestId));
        }
        for (const nested of Object.values(value)) visit(nested, depth + 1, seen);
      };
      const onMessage = event => {
        const value = event && (event.data || event.detail || event);
        if (value && value.hostId != null && String(value.hostId) !== hostId) return;
        visit(value, 0, new WeakSet());
      };
      for (const eventName of ['message', 'codex-message-to-view', 'codex-message']) {
        window.addEventListener(eventName, onMessage);
        state.listeners.push([eventName, onMessage]);
      }
      window[bridgeKey] = state;
    }
    return { ok: true, instanceId: state.instanceId, requests: [...state.pending.values()] };
  })()`;
}

function respondExpression(options = {}) {
  const hostId = String(options.hostId || 'local');
  const instanceId = String(options.instanceId || '');
  const requestId = options.requestId;
  const result = options.result;
  return `(async () => {
    const expectedInstanceId = ${JSON.stringify(instanceId)};
    const requestId = ${JSON.stringify(requestId)};
    const state = window.__codex2frpServerRequestBridgeV1;
    if (!state || state.hostId !== ${JSON.stringify(hostId)} || state.instanceId !== expectedInstanceId) {
      return { ok: false, code: 'BRIDGE_INSTANCE_CHANGED' };
    }
    const requestKey = typeof requestId + ':' + String(requestId);
    if (!state.pending.has(requestKey)) return { ok: false, code: 'REQUEST_NOT_PENDING' };
    const bridge = window.electronBridge && window.electronBridge.sendMessageFromView;
    if (typeof bridge !== 'function') return { ok: false, code: 'DESKTOP_BRIDGE_UNAVAILABLE' };
    try {
      await Promise.resolve(bridge.call(window.electronBridge, {
        type: 'mcp-response',
        hostId: ${JSON.stringify(hostId)},
        response: { id: requestId, result: ${JSON.stringify(result)} },
      }));
    } catch (error) {
      return { ok: false, code: 'DESKTOP_BRIDGE_SEND_FAILED' };
    }
    state.pending.delete(requestKey);
    return { ok: true };
  })()`;
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class DesktopServerRequestBridge {
  constructor(options = {}) {
    if (typeof options.evaluate !== 'function') throw new TypeError('DesktopServerRequestBridge requires evaluate.');
    if (!options.store || typeof options.store.capture !== 'function') throw new TypeError('DesktopServerRequestBridge requires store.');
    this.evaluate = options.evaluate;
    this.store = options.store;
    this.hostId = String(options.hostId || 'local');
    this.instanceId = '';
    this.connectionEpoch = 0;
    this.seen = new Map();
  }

  async synchronize() {
    const snapshot = await this.evaluate(installExpression({ hostId: this.hostId }));
    if (!snapshot || snapshot.ok !== true || !snapshot.instanceId || !Array.isArray(snapshot.requests)) {
      throw bridgeError('APP_SERVER_CONNECTION_CLOSED', 'Desktop renderer approval bridge is unavailable.');
    }
    if (this.instanceId !== String(snapshot.instanceId)) {
      if (this.connectionEpoch > 0) this.store.expireConnectionEpoch(this.connectionEpoch, 'desktopRenderer');
      this.instanceId = String(snapshot.instanceId);
      this.connectionEpoch += 1;
      this.seen.clear();
    }
    const current = new Set();
    for (const request of snapshot.requests) {
      if (!request || !MODERN_REQUEST_METHODS.includes(String(request.method || ''))) continue;
      const key = `${typeof request.id}:${String(request.id)}`;
      current.add(key);
      if (this.seen.has(key)) continue;
      const captured = this.store.capture({
        ...request,
        requestId: request.id,
        connectionEpoch: this.connectionEpoch,
        connectionSource: 'desktopRenderer',
        respond: async result => {
          const response = await this.evaluate(respondExpression({
            hostId: this.hostId,
            instanceId: this.instanceId,
            requestId: request.id,
            result,
          }));
          if (response && response.ok === true) return;
          if (response && response.code === 'BRIDGE_INSTANCE_CHANGED') {
            throw bridgeError('APP_SERVER_CONNECTION_CLOSED', 'Desktop renderer was reloaded.');
          }
          if (response && response.code === 'REQUEST_NOT_PENDING') {
            throw bridgeError('APP_SERVER_PROTOCOL_ERROR', 'Desktop request was already resolved.');
          }
          throw bridgeError('DESKTOP_BRIDGE_UNAVAILABLE', 'Desktop renderer response bridge is unavailable.');
        },
      });
      if (captured) this.seen.set(key, { requestId: request.id, threadId: request.params && request.params.threadId });
    }
    for (const [key, request] of [...this.seen]) {
      if (current.has(key)) continue;
      this.store.resolveServerRequest({
        ...request,
        connectionEpoch: this.connectionEpoch,
        connectionSource: 'desktopRenderer',
      });
      this.seen.delete(key);
    }
    return { ok: true, instanceId: this.instanceId, pendingCount: this.seen.size };
  }
}

module.exports = { DesktopServerRequestBridge, MODERN_REQUEST_METHODS, installExpression, respondExpression };


