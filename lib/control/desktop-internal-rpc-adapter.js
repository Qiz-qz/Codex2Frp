'use strict';

const DESKTOP_RPC_METHODS = Object.freeze({
  listModels: Object.freeze({ action: 'model.list', method: 'model/list', access: 'read' }),
  startThread: Object.freeze({ action: 'thread.start', method: 'thread/start', access: 'mutation' }),
  readThread: Object.freeze({ action: 'thread.read', method: 'thread/read', access: 'read' }),
  updateThreadSettings: Object.freeze({ action: 'thread.settings', method: 'thread/settings/update', access: 'mutation' }),
  startTurn: Object.freeze({ action: 'turn.start', method: 'turn/start', access: 'mutation' }),
  interruptTurn: Object.freeze({ action: 'turn.interrupt', method: 'turn/interrupt', access: 'mutation' }),
  steerTurn: Object.freeze({ action: 'turn.steer', method: 'turn/steer', access: 'mutation' }),
});

const THREAD_START_TIMEOUT_MS = 15000;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function desktopRpcError(code, message, statusCode = 503, details = {}, options = {}) {
  const error = new Error(message, options);
  error.name = 'DesktopInternalRpcError';
  error.code = code;
  error.statusCode = statusCode;
  error.details = { ...details };
  return error;
}

function unwrapDesktopRpcResponse(data, hostId, requestId) {
  if (!data || typeof data !== 'object' || data.type !== 'mcp-response') return null;
  if (String(data.hostId || '') !== String(hostId || '')) return null;
  const response = objectOrEmpty(data.message || data.response);
  if (String(response.id ?? '') !== String(requestId ?? '')) return null;
  return response;
}

function desktopRpcExpression(options = {}) {
  const hostId = String(options.hostId || 'local');
  const request = objectOrEmpty(options.request);
  const timeoutMs = Math.max(250, Number(options.timeoutMs) || 4500);
  return `(async () => {
    const hostId = ${JSON.stringify(hostId)};
    const request = ${JSON.stringify(request)};
    const timeoutMs = ${JSON.stringify(timeoutMs)};
    const bridge = window.electronBridge && window.electronBridge.sendMessageFromView;
    if (typeof bridge !== 'function') {
      return { ok: false, code: 'DESKTOP_BRIDGE_UNAVAILABLE', message: 'The Codex desktop bridge is unavailable.' };
    }
    return await new Promise(resolve => {
      let settled = false;
      let timer = null;
      const events = ['message', 'codex-message-to-view', 'codex-message'];
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        for (const eventName of events) window.removeEventListener(eventName, onMessage);
      };
      const finish = value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onMessage = event => {
        const data = event && (event.data || event.detail || event);
        if (!data || data.type !== 'mcp-response') return;
        if (String(data.hostId || '') !== String(hostId)) return;
        const message = data.message || data.response;
        if (!message || String(message.id) !== String(request.id)) return;
        if (message.error) {
          finish({ ok: false, code: 'DESKTOP_RPC_ERROR', message: String(message.error.message || 'Desktop RPC failed.'), error: message.error });
        } else {
          finish({ ok: true, result: message.result });
        }
      };
      for (const eventName of events) window.addEventListener(eventName, onMessage);
      timer = setTimeout(() => finish({
        ok: false,
        code: 'DESKTOP_RPC_TIMEOUT',
        message: 'The Codex desktop RPC response timed out.',
      }), timeoutMs);
      Promise.resolve(bridge.call(window.electronBridge, {
        type: 'mcp-request',
        hostId,
        request,
      })).catch(error => finish({
        ok: false,
        code: 'DESKTOP_BRIDGE_SEND_FAILED',
        message: String(error && error.message || error || 'Desktop bridge send failed.'),
      }));
    });
  })()`;
}

function probeExpression() {
  return `(() => ({
    ok: Boolean(window.electronBridge && typeof window.electronBridge.sendMessageFromView === 'function'),
    code: window.electronBridge && typeof window.electronBridge.sendMessageFromView === 'function'
      ? ''
      : 'DESKTOP_BRIDGE_UNAVAILABLE'
  }))()`;
}

function targetThreadId(params = {}) {
  return String(params.threadId || '').trim();
}

function guardContext(descriptor, params = {}, control = {}) {
  const safeControl = objectOrEmpty(control);
  return {
    action: descriptor.action,
    mode: descriptor.access === 'read' ? 'read' : 'rpc',
    threadId: targetThreadId(params),
    observedThreadId: String(safeControl.observedThreadId || '').trim(),
    desktopThreadId: String(safeControl.desktopThreadId || '').trim(),
    requireObservedTargetMatch: safeControl.requireObservedTargetMatch === true,
  };
}

class DesktopInternalRpcAdapter {
  constructor(options = {}) {
    if (typeof options.evaluate !== 'function') {
      throw new TypeError('DesktopInternalRpcAdapter requires a CDP evaluate function.');
    }
    this.evaluate = options.evaluate;
    this.guard = options.guard || null;
    this.beforeInvoke = typeof options.beforeInvoke === 'function' ? options.beforeInvoke : null;
    this.onSettingsConfirmed = typeof options.onSettingsConfirmed === 'function'
      ? options.onSettingsConfirmed
      : null;
    this.normalizeSettings = typeof options.normalizeSettings === 'function'
      ? options.normalizeSettings
      : params => params;
    this.hostId = String(options.hostId || 'local');
    this.timeoutMs = Math.max(250, Number(options.timeoutMs) || 4500);
    this.nextRequestId = Math.floor(Date.now() % 1_000_000_000);
    this.status = {
      state: 'unavailable',
      ready: false,
      source: 'desktopInternalRpc',
      reason: 'not_probed',
      checkedAt: '',
    };
  }

  getStatus() {
    return structuredClone(this.status);
  }

  setStatus(ready, reason = '') {
    this.status = {
      state: ready ? 'ready' : 'unavailable',
      ready,
      source: 'desktopInternalRpc',
      ...(reason ? { reason } : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  async probe() {
    try {
      const result = await this.evaluate(probeExpression(), { timeoutMs: Math.min(this.timeoutMs, 1200) });
      const ready = Boolean(result && result.ok === true);
      this.setStatus(ready, ready ? '' : String(result && result.code || 'desktop_bridge_unavailable').toLowerCase());
      return this.getStatus();
    } catch (error) {
      this.setStatus(false, 'cdp_unavailable');
      return this.getStatus();
    }
  }

  assertAllowed(descriptor, params, control) {
    if (this.guard && typeof this.guard.assertAllowed === 'function') {
      this.guard.assertAllowed(guardContext(descriptor, params, control));
    }
  }

  async invoke(descriptor, params = {}, control = {}) {
    this.assertAllowed(descriptor, params, control);
    if (this.beforeInvoke) await this.beforeInvoke(descriptor, params, control);
    const requestId = ++this.nextRequestId;
    const operationTimeoutMs = descriptor.method === DESKTOP_RPC_METHODS.startThread.method
      ? Math.max(this.timeoutMs, THREAD_START_TIMEOUT_MS)
      : this.timeoutMs;
    let result;
    try {
      result = await this.evaluate(desktopRpcExpression({
        hostId: this.hostId,
        request: { id: requestId, method: descriptor.method, params: objectOrEmpty(params) },
        timeoutMs: operationTimeoutMs,
      }), { timeoutMs: operationTimeoutMs + 250 });
    } catch (error) {
      this.setStatus(false, 'cdp_unavailable');
      throw desktopRpcError(
        'DESKTOP_INTERNAL_RPC_UNAVAILABLE',
        'The Codex desktop internal RPC channel is unavailable.',
        503,
        { method: descriptor.method },
        { cause: error },
      );
    }
    if (!result || result.ok !== true) {
      const code = String(result && result.code || 'DESKTOP_INTERNAL_RPC_UNAVAILABLE');
      if (code === 'DESKTOP_RPC_ERROR') this.setStatus(true);
      else this.setStatus(false, code.toLowerCase());
      throw desktopRpcError(
        code,
        String(result && result.message || 'The Codex desktop internal RPC request failed.'),
        code === 'DESKTOP_RPC_ERROR' ? 409 : 503,
        { method: descriptor.method, rpcError: result && result.error || null },
      );
    }
    this.setStatus(true);
    return result.result;
  }

  listModels(params = {}) { return this.invoke(DESKTOP_RPC_METHODS.listModels, params); }
  startThread(params = {}, control = {}) { return this.invoke(DESKTOP_RPC_METHODS.startThread, params, control); }
  readThread(params = {}) { return this.invoke(DESKTOP_RPC_METHODS.readThread, params); }
  async updateThreadSettings(params = {}, control = {}) {
    const normalizedParams = objectOrEmpty(this.normalizeSettings(objectOrEmpty(params)));
    const result = await this.invoke(DESKTOP_RPC_METHODS.updateThreadSettings, normalizedParams, control);
    if (!this.onSettingsConfirmed) return result;
    const target = await this.onSettingsConfirmed(normalizedParams, result);
    if (!target) return result;
    return result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, target }
      : { result, target };
  }
  startTurn(params = {}, control = {}) { return this.invoke(DESKTOP_RPC_METHODS.startTurn, params, control); }
  interruptTurn(params = {}, control = {}) {
    return this.invoke(DESKTOP_RPC_METHODS.interruptTurn, params, control);
  }
  steerTurn(params = {}, control = {}) { return this.invoke(DESKTOP_RPC_METHODS.steerTurn, params, control); }

  async send(request = {}, control = {}) {
    let threadId = String(request.threadId || '').trim();
    let createdThread = false;
    if (!threadId) {
      const started = await this.startThread({
        ...(String(request.cwd || '').trim() ? { cwd: String(request.cwd).trim() } : {}),
        ephemeral: false,
        ...objectOrEmpty(request.threadParams),
      }, control);
      threadId = String(started && (started.threadId || started.thread?.id) || '').trim();
      if (!threadId) throw desktopRpcError('THREAD_START_ID_MISSING', 'Codex created a task without returning its id.', 502);
      createdThread = true;
    }
    const input = [];
    const text = String(request.text || '');
    if (text.trim()) input.push({ type: 'text', text });
    for (const attachment of Array.isArray(request.attachments) ? request.attachments : []) {
      const source = objectOrEmpty(attachment);
      const url = String(source.dataUrl || '').trim();
      if (!/^data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+$/i.test(url)) {
        throw desktopRpcError('ATTACHMENT_DATA_URL_INVALID', 'Only base64 image attachments are supported.', 400);
      }
      input.push({ type: 'image', url });
    }
    if (input.length === 0) throw desktopRpcError('EMPTY_INPUT', 'Enter text or attach an image.', 400);
    const started = await this.startTurn({
      threadId,
      input,
      ...(String(request.clientRequestId || '').trim()
        ? { clientUserMessageId: String(request.clientRequestId).trim() }
        : {}),
      ...objectOrEmpty(request.turnParams),
    }, control);
    const turnId = String(started && (started.turnId || started.turn?.id) || '').trim();
    if (!turnId) throw desktopRpcError('TURN_START_ID_MISSING', 'Codex accepted the input without returning its turn id.', 502);
    return { threadId, turnId, createdThread, start: started };
  }
}

module.exports = {
  DESKTOP_RPC_METHODS,
  DesktopInternalRpcAdapter,
  THREAD_START_TIMEOUT_MS,
  desktopRpcError,
  desktopRpcExpression,
  probeExpression,
  unwrapDesktopRpcResponse,
};
