'use strict';

function normalizeCdpProbeHost(value = '') {
  return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHost(value = '') {
  const host = normalizeCdpProbeHost(value);
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function debuggerUrlForProbeEndpoint(value = '', endpoint = {}) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!/^wss?:$/.test(parsed.protocol) || !isLoopbackHost(parsed.hostname)) return raw;
  const host = normalizeCdpProbeHost(endpoint.host);
  const port = Number(endpoint.port);
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port <= 0 || port >= 65536) return raw;
  parsed.hostname = host.includes(':') ? `[${host}]` : host;
  parsed.port = String(port);
  return parsed.toString();
}

function bindCdpTargetToProbeEndpoint(target = {}, endpoint = {}) {
  if (!target || typeof target !== 'object') return target;
  const host = normalizeCdpProbeHost(endpoint.host);
  const port = Number(endpoint.port);
  if (!isLoopbackHost(host) || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    return { ...target };
  }
  return {
    ...target,
    webSocketDebuggerUrl: debuggerUrlForProbeEndpoint(target.webSocketDebuggerUrl, { host, port }),
    cdpEndpoint: { host, port },
  };
}

module.exports = {
  bindCdpTargetToProbeEndpoint,
  debuggerUrlForProbeEndpoint,
  isLoopbackHost,
  normalizeCdpProbeHost,
};
