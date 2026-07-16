'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SAKURA_API_BASE = 'https://api.natfrp.com/v4';
const DEFAULT_SAKURA_DOMAIN = '';
const DEFAULT_SAKURA_REMOTE_PORT = 0;
const DEFAULT_SAKURA_TYPES = ['https', 'http', 'tcp'];

function defaultSakuraConfig() {
  return {
    enabled: false,
    apiBase: DEFAULT_SAKURA_API_BASE,
    apiToken: '',
    preferredDomain: DEFAULT_SAKURA_DOMAIN,
    remotePort: DEFAULT_SAKURA_REMOTE_PORT,
    preferredTypes: [...DEFAULT_SAKURA_TYPES],
    preferredNodeId: '',
    managedTunnelIds: [],
    lastStatus: null,
  };
}

function emptyState() {
  return {
    pinnedThreadIds: [],
    archivedThreadIds: [],
    titleOverrides: {},
    guiFailureReports: {},
    controlOverrides: {
      model: '',
      reasoning: '',
      speed: '',
      threadId: '',
      updatedAt: '',
    },
    sakura: defaultSakuraConfig(),
  };
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : [];
}

function normalizePort(value, fallback) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return fallback;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : fallback;
}

function normalizeThreadIdArray(value, isThreadId) {
  return [...new Set(normalizeStringArray(value).filter(isThreadId))];
}

function normalizeSakuraConfig(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const base = defaultSakuraConfig();
  const preferredDomain = String(value.preferredDomain || base.preferredDomain).trim().toLowerCase() || base.preferredDomain;
  const remotePort = normalizePort(value.remotePort, base.remotePort);
  const enabled = value.enabled === true || Boolean(preferredDomain && remotePort);
  const preferredTypes = normalizeStringArray(value.preferredTypes)
    .filter(type => ['https', 'http', 'tcp'].includes(type));
  return {
    enabled,
    apiBase: String(value.apiBase || base.apiBase).trim().replace(/\/+$/, '') || base.apiBase,
    apiToken: '',
    preferredDomain,
    remotePort,
    preferredTypes: preferredTypes.length ? preferredTypes : [...base.preferredTypes],
    preferredNodeId: String(value.preferredNodeId || '').trim(),
    managedTunnelIds: normalizeStringArray(value.managedTunnelIds),
    lastStatus: value.lastStatus && typeof value.lastStatus === 'object' ? value.lastStatus : null,
  };
}

function normalizeControlOverrides(value = {}, isThreadId = () => false) {
  if (!value || typeof value !== 'object') value = {};
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const reasoning = typeof value.reasoning === 'string' && ['low', 'medium', 'high', 'xhigh'].includes(value.reasoning.trim())
    ? value.reasoning.trim()
    : '';
  const speed = typeof value.speed === 'string' && ['standard', 'fast'].includes(value.speed.trim())
    ? value.speed.trim()
    : '';
  const threadId = typeof value.threadId === 'string' && isThreadId(value.threadId.trim()) ? value.threadId.trim() : '';
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt.trim() : '';
  return { model, reasoning, speed, threadId, updatedAt };
}

function normalizeState(value = {}, options = {}) {
  const isThreadId = typeof options.isThreadId === 'function' ? options.isThreadId : item => typeof item === 'string' && item.length > 0;
  return {
    pinnedThreadIds: normalizeThreadIdArray(value.pinnedThreadIds, isThreadId),
    archivedThreadIds: normalizeThreadIdArray(value.archivedThreadIds, isThreadId),
    titleOverrides: value.titleOverrides && typeof value.titleOverrides === 'object' ? value.titleOverrides : {},
    guiFailureReports: value.guiFailureReports && typeof value.guiFailureReports === 'object' ? value.guiFailureReports : {},
    controlOverrides: normalizeControlOverrides(value.controlOverrides, isThreadId),
    sakura: normalizeSakuraConfig(value.sakura),
  };
}

function readState(file, options = {}) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')), options);
  } catch {
    return normalizeState({}, options);
  }
}

function writeState(file, state, options = {}) {
  const normalized = normalizeState(state, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function sanitizeSakuraConfig(value = {}) {
  const config = normalizeSakuraConfig(value);
  return {
    enabled: config.enabled,
    configured: Boolean(config.preferredDomain && config.remotePort),
    apiBase: config.apiBase,
    preferredDomain: config.preferredDomain,
    remotePort: config.remotePort,
    preferredTypes: config.preferredTypes,
    preferredNodeId: config.preferredNodeId,
    managedTunnelIds: config.managedTunnelIds,
  };
}

module.exports = {
  DEFAULT_SAKURA_API_BASE,
  DEFAULT_SAKURA_DOMAIN,
  DEFAULT_SAKURA_REMOTE_PORT,
  DEFAULT_SAKURA_TYPES,
  defaultSakuraConfig,
  emptyState,
  normalizeControlOverrides,
  normalizeSakuraConfig,
  normalizeState,
  readState,
  writeState,
  sanitizeSakuraConfig,
};
