'use strict';

const CAPABILITY_MODES = Object.freeze(['rpc', 'bridge', 'uiExplicit', 'unavailable']);
const QUEUE_STATES = new Set([
  'queued',
  'dispatching',
  'accepted',
  'running',
  'completed',
  'failed',
  'cancelled',
  'needs_reconcile',
]);

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactDiagnosticString(value, options = {}) {
  let text = String(value || '');
  for (const token of Array.isArray(options.tokens) ? options.tokens : []) {
    const normalized = String(token || '');
    if (!normalized) continue;
    text = text.replace(new RegExp(escapeRegExp(normalized), 'g'), '[REDACTED]');
  }
  text = text.replace(/\bBearer\s+[^\s|]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/data:[^,\s|]+,[A-Za-z0-9+/=]+/gi, 'data:[REDACTED]');
  text = text.replace(/([?&](?:token|access_token|api_key|key)=)[^&#\s|]+/gi, '$1[REDACTED]');
  text = text.replace(/\b[A-Za-z]:\\[^\s|,;]+/g, '<path>');
  text = text.replace(/\/(?:Users|home|tmp|var|workspace|mnt)\/[^\s|,;]+/g, '<path>');
  return text;
}

function safeIdentifier(value, fallback = 'unknown', options = {}) {
  const redacted = redactDiagnosticString(value, options);
  if (redacted.includes('[REDACTED]') || redacted.includes('<path>')) return fallback;
  return /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(redacted) ? redacted : fallback;
}

function safeEnum(value, allowed, fallback = 'unknown') {
  const normalized = String(value || '');
  return allowed.includes(normalized) ? normalized : fallback;
}

function safeInteger(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function capabilityCounts(capabilities) {
  const counts = { rpc: 0, bridge: 0, uiExplicit: 0, unavailable: 0, unknown: 0 };
  const operations = objectOrEmpty(objectOrEmpty(capabilities).operations);
  for (const capability of Object.values(operations)) {
    const mode = String(capability && capability.mode || '');
    if (CAPABILITY_MODES.includes(mode)) counts[mode] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function queueCounts(queue) {
  const states = {};
  let total = 0;
  const items = Array.isArray(objectOrEmpty(queue).items) ? queue.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    total += 1;
    const rawState = String(item.state || '');
    const state = QUEUE_STATES.has(rawState) ? rawState : 'unknown';
    states[state] = Number(states[state] || 0) + 1;
  }
  return { total, states };
}

function safeErrors(errors, options) {
  if (!Array.isArray(errors)) return [];
  const kinds = [
    'conflict',
    'forbidden',
    'incompatible',
    'invalidRequest',
    'notFound',
    'protocol',
    'remote',
    'timeout',
    'unauthorized',
    'uncertain',
    'unavailable',
    'unknown',
  ];
  return errors
    .filter(error => error && typeof error === 'object' && !Array.isArray(error))
    .slice(-50)
    .map(error => ({
      code: safeIdentifier(error.code, 'UNKNOWN', options),
      kind: safeEnum(error.kind, kinds),
      at: safeTimestamp(error.at),
    }));
}

function createDiagnosticReport(input = {}, options = {}) {
  const source = objectOrEmpty(input);
  const environment = objectOrEmpty(source.environment);
  const versions = objectOrEmpty(source.versions);
  const protocol = objectOrEmpty(source.protocol);
  const appServer = objectOrEmpty(source.appServer);
  const route = objectOrEmpty(source.route);
  const routeError = objectOrEmpty(route.error);
  const sync = objectOrEmpty(source.sync);
  const nowValue = typeof options.now === 'function' ? options.now() : new Date();
  const generatedAt = (nowValue instanceof Date ? nowValue : new Date(nowValue)).toISOString();
  const schemaHash = /^[a-f0-9]{64}$/i.test(String(protocol.schemaHash || ''))
    ? String(protocol.schemaHash).toLowerCase()
    : '';

  return {
    schemaVersion: 1,
    generatedAt,
    environment: {
      platform: safeEnum(environment.platform, ['win32', 'linux', 'darwin']),
      nodeVersion: safeIdentifier(environment.nodeVersion, 'unknown', options),
    },
    versions: {
      backend: safeIdentifier(versions.backend, 'unknown', options),
      desktop: safeIdentifier(versions.desktop, 'unknown', options),
      cli: safeIdentifier(versions.cli, 'unknown', options),
    },
    protocol: {
      profile: safeIdentifier(protocol.profile, 'unknown', options),
      schemaVersion: safeIdentifier(protocol.schemaVersion, 'unknown', options),
      schemaHash,
    },
    appServer: {
      state: safeEnum(
        appServer.state,
        ['stopped', 'starting', 'ready', 'stopping', 'failed', 'unavailable'],
      ),
      pid: safeInteger(appServer.pid, null),
      connectionEpoch: safeInteger(appServer.connectionEpoch, 0),
    },
    capabilities: capabilityCounts(source.capabilities),
    route: {
      kind: safeEnum(route.kind, ['local', 'lan', 'sakura', 'https', 'tcp']),
      status: safeEnum(route.status, ['healthy', 'degraded', 'offline']),
      latencyMs: safeNumber(route.latencyMs),
      lastSuccessAt: safeTimestamp(route.lastSuccessAt),
      nextRetryAt: safeTimestamp(route.nextRetryAt),
      errorCode: safeIdentifier(routeError.code, '', options),
    },
    sync: {
      snapshotVersion: safeInteger(sync.snapshotVersion, 0),
      stale: sync.stale === true,
      lastSyncedAt: safeTimestamp(sync.lastSyncedAt),
    },
    queue: queueCounts(source.queue),
    errors: safeErrors(source.errors, options),
  };
}

module.exports = {
  capabilityCounts,
  createDiagnosticReport,
  queueCounts,
  redactDiagnosticString,
};
