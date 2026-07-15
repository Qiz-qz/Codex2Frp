'use strict';

const { selectCodexCdpTarget } = require('./cdp-target');
const {
  normalizeVerifiedDesktopSelection,
  verifiedSelectionExpression,
} = require('../control/desktop-selection-adapter');

class DesktopSelectionObserverError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DesktopSelectionObserverError';
    this.code = 'DESKTOP_SELECTION_OBSERVER_UNAVAILABLE';
  }
}

async function defaultListTargets(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new DesktopSelectionObserverError('CDP target discovery is unavailable.');
  const port = Number(options.port || process.env.CODEX_CDP_PORT || 9222);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DesktopSelectionObserverError('CDP target discovery is unavailable.');
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000),
    });
    if (!response || response.ok !== true) throw new Error('target list unavailable');
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch (error) {
    throw new DesktopSelectionObserverError('CDP target discovery is unavailable.', { cause: error });
  }
}

function defaultEvaluate(target, expression, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new DesktopSelectionObserverError('CDP evaluation is unavailable.'));
  }
  const endpoint = String(target && target.webSocketDebuggerUrl || '');
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket && socket.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new DesktopSelectionObserverError('CDP evaluation timed out.')),
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000);
    try {
      socket = new WebSocketImpl(endpoint);
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      })));
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data || '')); } catch { return; }
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) {
          finish(new DesktopSelectionObserverError('CDP evaluation failed.'));
          return;
        }
        finish(null, message.result?.result?.value ?? null);
      });
      socket.addEventListener('error', () => finish(new DesktopSelectionObserverError('CDP evaluation is unavailable.')));
      socket.addEventListener('close', () => finish(new DesktopSelectionObserverError('CDP evaluation closed.')));
    } catch (error) {
      finish(new DesktopSelectionObserverError('CDP evaluation is unavailable.', { cause: error }));
    }
  });
}

function createCodexCdpSelectionObserver(options = {}) {
  const listTargets = typeof options.listTargets === 'function'
    ? options.listTargets
    : () => defaultListTargets(options);
  const evaluate = typeof options.evaluate === 'function'
    ? options.evaluate
    : (target, expression) => defaultEvaluate(target, expression, options);
  return async () => {
    let targets;
    try { targets = await listTargets(); } catch (error) {
      if (error && error.code === 'DESKTOP_SELECTION_OBSERVER_UNAVAILABLE') throw error;
      throw new DesktopSelectionObserverError('CDP target discovery is unavailable.', { cause: error });
    }
    const canonicalTargets = targets.filter(target => {
      const url = String(target && target.url || '').trim().toLowerCase().split(/[?#]/, 1)[0];
      return url === 'app://-/index.html';
    });
    const target = selectCodexCdpTarget(canonicalTargets);
    if (!target) throw new DesktopSelectionObserverError('A verified Codex renderer is unavailable.');
    let evidence;
    try { evidence = await evaluate(target, verifiedSelectionExpression()); } catch (error) {
      if (error && error.code === 'DESKTOP_SELECTION_OBSERVER_UNAVAILABLE') throw error;
      throw new DesktopSelectionObserverError('CDP evaluation is unavailable.', { cause: error });
    }
    return normalizeVerifiedDesktopSelection(evidence);
  };
}

module.exports = {
  DesktopSelectionObserverError,
  createCodexCdpSelectionObserver,
  defaultEvaluate,
  defaultListTargets,
  verifiedSelectionExpression,
};
