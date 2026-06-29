#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');
const {
  emptyState,
  readState,
  sanitizeSakuraConfig,
  writeState,
} = require('./lib/state-store');
const { createStaticAssetResponder } = require('./lib/static-assets');
const { getDesktopLocalBase, getLanApiBasesFromInterfaces, mergeRouteCandidates } = require('./lib/route-utils');
const { redactToken } = require('./lib/sakura-frp');
const {
  createForegroundNoticeForStatus,
  createForegroundNoticesForThreadSnapshots,
} = require('./lib/foreground-notice');
const {
  classifyThreadProject,
  isSubagentSessionMeta,
  normalizeThreadListLimit,
} = require('./lib/thread-utils');
const modelOptionUtils = require('./lib/model-options');

const APP_NAME = process.env.CODEX2FRP_APP_NAME || 'Codex2Frp';
const PORT = Number(process.env.PORT || 8988);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_FILE = process.env.MOBILE_TYPER_TOKEN_FILE || path.join(__dirname, '.runtime', 'mobile-token.txt');
const TOKEN = process.env.MOBILE_TYPER_TOKEN || loadOrCreateMobileToken(TOKEN_FILE);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = Number(process.env.CODEX2FRP_MAX_BODY_BYTES || 28 * 1024 * 1024);
const MAX_TEXT_LENGTH = 8000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = Number(process.env.CODEX2FRP_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);
const INLINE_ATTACHMENT_BYTES = Number(process.env.CODEX2FRP_INLINE_ATTACHMENT_BYTES || 512 * 1024);
const UPLOAD_DIR = path.join(os.tmpdir(), 'codex2frp-uploads');
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.codex2frp');
const STATE_DIR = process.env.CODEX2FRP_STATE_DIR || DEFAULT_STATE_DIR;
const STATE_FILE = path.join(STATE_DIR, 'state.json');
let sakuraRouteCache = { at: 0, result: null };
const inlineAttachmentCache = new Map();
const SAKURA_ROUTE_CACHE_MS = Number(process.env.CODEX2FRP_SAKURA_CACHE_MS || 30 * 1000);
const SAKURA_STATUS_MAX_AGE_MS = Number(process.env.CODEX2FRP_SAKURA_STATUS_MAX_AGE_MS || 2 * 60 * 1000);
const SAKURA_HEALTH_TIMEOUT_MS = Number(process.env.CODEX2FRP_SAKURA_HEALTH_TIMEOUT_MS || 2500);
const REMOTE_NETWORK_UNAVAILABLE_MESSAGE = '远程连接网络未启动，当前仅支持局域网连接。';

function loadOrCreateMobileToken(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(12).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8' });
  } catch {}
  return token;
}

const WINDOWS_LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const CODEX_MODEL_CACHE_FILE = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_DESKTOP_LOGS_DIR = process.env.CODEX_DESKTOP_LOGS_DIR || path.join(WINDOWS_LOCALAPPDATA, 'OpenAI', 'Codex', 'logs');
const CODEX_SESSION_TAIL_BYTES = 5 * 1024 * 1024;
const CODEX_ACTIVITY_TAIL_BYTES = 512 * 1024;
const CODEX_ACTIVITY_LOOKBACK_BYTES = CODEX_SESSION_TAIL_BYTES;
const CODEX_RUNTIME_STALE_MS = 2 * 60 * 60 * 1000;
const CODEX_HISTORY_TAIL_BYTES = 128 * 1024 * 1024;
const CODEX_TITLE_SCAN_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 120;
const GUI_FAILURE_REPORT_LIMIT = 80;
const GUI_FAILURE_LOG_SCAN_BYTES = 2 * 1024 * 1024;
const GUI_FAILURE_LOG_RECENT_MS = 15 * 60 * 1000;
const RECENT_SEND_TTL_MS = 5 * 60 * 1000;
const CODEX_THREAD_SYNC_FRESH_MS = 5000;
const CODEX_DEEPLINK_SETTLE_MS = 560;
const CODEX_APP_FOCUS_SETTLE_MS = 100;
const TEXT_PASTE_SETTLE_MS = 140;
const ATTACHMENT_PASTE_SETTLE_MS = 220;
const CODEX_COMMAND_SETTLE_MS = 180;
const CODEX_MODEL_COMMAND_SETTLE_MS = 450;
const CODEX_REASONING_COMMAND_SETTLE_MS = 450;
const CODEX_SESSION_FILE_CACHE_MS = 1200;
const CODEX_THREAD_LIST_CACHE_MS = 1200;
const CODEX_CURRENT_THREAD_CACHE_MS = 900;
const CODEX_HISTORY_INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const CODEX_CDP_PREFERRED_PORT = Number(process.env.CODEX2FRP_CDP_PORT || 39252);
const CODEX_CDP_PORT_SCAN_COUNT = Math.max(1, Number(process.env.CODEX2FRP_CDP_PORT_SCAN_COUNT || 12));
const CODEX_CDP_HOST = process.env.CODEX2FRP_CDP_HOST || '127.0.0.1';
const CODEX_CDP_SEND_TIMEOUT_MS = Number(process.env.CODEX2FRP_CDP_SEND_TIMEOUT_MS || 4500);
const CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS = Number(process.env.CODEX2FRP_CDP_PASSIVE_PROBE_TIMEOUT_MS || 250);
const CODEX_CDP_PASSIVE_SEND_TIMEOUT_MS = Number(process.env.CODEX2FRP_CDP_PASSIVE_SEND_TIMEOUT_MS || 800);
const CODEX_CDP_READY_TIMEOUT_SECONDS = Number(process.env.CODEX2FRP_CDP_READY_TIMEOUT_SECONDS || 45);
const CODEX_CDP_LAUNCH_TIMEOUT_MS = Number(process.env.CODEX2FRP_CDP_LAUNCH_TIMEOUT_MS || Math.max(55, CODEX_CDP_READY_TIMEOUT_SECONDS + 10) * 1000);
const CODEX_CDP_AUTO_OPEN = process.env.CODEX2FRP_CDP_AUTO_OPEN !== '0';
const CODEX_COMPOSER_REFERENCE_VERIFY_MS = Number(process.env.CODEX2FRP_COMPOSER_REFERENCE_VERIFY_MS || 1800);
const CODEX_MODE_OPTIONS_CACHE_MS = Number(process.env.CODEX2FRP_MODE_OPTIONS_CACHE_MS || 30000);
const CODEX_MODE_OPTIONS_REFRESH_TIMEOUT_MS = Number(process.env.CODEX2FRP_MODE_OPTIONS_REFRESH_TIMEOUT_MS || 6500);
const CODEX_CONFIG_SWITCH_VERIFY_MS = Number(process.env.CODEX2FRP_CONFIG_SWITCH_VERIFY_MS || 2200);
const CODEX_WINDOW_RESTORE_SETTLE_MS = Number(process.env.CODEX2FRP_WINDOW_RESTORE_SETTLE_MS || 260);
const REASONING_MODE_TARGETS = {
  low: { key: 'low', value: 'low', label: '低', displayName: '低' },
  medium: { key: 'medium', value: 'medium', label: '中', displayName: '中' },
  high: { key: 'high', value: 'high', label: '高', displayName: '高' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '超高', displayName: '超高' },
};
const SPEED_MODE_TARGETS = {
  standard: { key: 'standard', value: 'default', serviceTier: 'default', label: '标准', displayName: '标准' },
  fast: { key: 'fast', value: 'priority', serviceTier: 'priority', label: '高速', displayName: '高速' },
};
const recentSendRequests = new Map();
let lastCodexThreadActivation = { threadId: '', at: 0 };
let codexSessionFilesCache = { at: 0, files: [] };
let threadIndexCache = { mtimeMs: 0, size: 0, byId: null };
const sessionMetaCache = new Map();
const firstUserMessageCache = new Map();
const runtimeSummaryCache = new Map();
const codexThreadListCache = new Map();
const threadHistoryCache = new Map();
let codexCurrentThreadCache = { at: 0, selection: null };
let foregroundNoticeThreadSnapshot = [];
let foregroundNoticeSnapshotReady = false;
let modelCatalogCache = { mtimeMs: -1, path: '', models: null };
let liveModeOptionsCache = { at: 0, value: null };
let keepAwakeProcess = null;
let keepAwakeStartedAt = '';
let codexCdpLaunchPromise = null;
let codexCdpLastLaunch = { ok: false, at: 0, detail: '' };
let codexCdpPort = CODEX_CDP_PREFERRED_PORT;

function fileCacheSignature(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

function boundedSet(map, key, value, limit = 300) {
  if (map.size >= limit && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
  return value;
}

function invalidateCodexThreadListCache() {
  codexThreadListCache.clear();
  codexCurrentThreadCache = { at: 0, selection: null };
}

function isKeepAwakeActive() {
  return Boolean(keepAwakeProcess && keepAwakeProcess.exitCode === null && !keepAwakeProcess.killed);
}

function keepAwakeStatus() {
  return {
    enabled: isKeepAwakeActive(),
    startedAt: isKeepAwakeActive() ? keepAwakeStartedAt : '',
    command: 'SetThreadExecutionState',
  };
}

function startKeepAwake() {
  if (isKeepAwakeActive()) return keepAwakeStatus();
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Codex2FrpPower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
while ($true) {
  [Codex2FrpPower]::SetThreadExecutionState(0x80000003) | Out-Null
  Start-Sleep -Seconds 30
}
`;
  const child = spawn(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  keepAwakeProcess = child;
  keepAwakeStartedAt = new Date().toISOString();
  child.on('exit', () => {
    if (keepAwakeProcess === child) {
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
    }
  });
  child.on('error', () => {
    if (keepAwakeProcess === child) {
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
    }
  });
  return keepAwakeStatus();
}

function stopKeepAwake() {
  const child = keepAwakeProcess;
  keepAwakeProcess = null;
  keepAwakeStartedAt = '';
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM'); } catch {}
  }
  return keepAwakeStatus();
}

function cleanupKeepAwake() {
  stopKeepAwake();
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function writeCodexConfigStringValue(key, value) {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextLine = `${key} = ${JSON.stringify(String(value || ''))}`;
  let text = readCodexConfigText();
  if (!text.trim()) {
    text = `${nextLine}\n`;
  } else if (new RegExp(`^\\s*${escaped}\\s*=\\s*"[^"]*"\\s*$`, 'm').test(text)) {
    text = text.replace(new RegExp(`^\\s*${escaped}\\s*=\\s*"[^"]*"\\s*$`, 'm'), nextLine);
  } else {
    text = `${nextLine}\n${text}`;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, text, 'utf8');
  return tomlStringValue(text, key);
}

function tomlStringValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : '';
}

function labelFromModelName(name = '') {
  return modelOptionUtils.labelFromModelName(name);
}

function normalizeModelOption(row = {}) {
  return modelOptionUtils.normalizeModelOption(row, 'local');
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, 'model_catalog_json');
  const configuredPath = catalogPath.startsWith('~') ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const resolvedPath = configuredPath || path.join(os.homedir(), '.codex', 'models_cache.json');
  const fallback = () => {
    const current = tomlStringValue(configText, 'model');
    return current ? [{ key: current, id: current, label: labelFromModelName(current), displayName: current, source: 'local' }] : [];
  };
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility !== 'hide')
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? models : fallback();
  } catch {
    return fallback();
  }
}

function availableModelOptionsForSwitch() {
  const liveOptions = liveModeOptionsCache.value && Array.isArray(liveModeOptionsCache.value.modelOptions)
    ? liveModeOptionsCache.value.modelOptions
    : [];
  return uniqueModelOptions([...liveOptions, ...readModelCatalogOptions()]);
}

function modelOptionsForClient(liveModeOptions = null) {
  return modelOptionUtils.modelOptionsForClient(liveModeOptions, readModelCatalogOptions());
}

function findModelOption(id = '') {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  const targetKey = modelCompareKey(targetId);
  return availableModelOptionsForSwitch().find(item => {
    const candidates = [item.id, item.key, item.displayName, item.label, ...modelTextCandidates(item)]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    return candidates.some(candidate => candidate === targetId || modelCompareKey(candidate) === targetKey);
  }) || null;
}

function emptyAppState() {
  return emptyState();
}

function readAppState() {
  const state = readState(STATE_FILE, { isThreadId: isCodexThreadId });
  return {
    ...state,
    guiFailureReports: normalizeGuiFailureReports(state.guiFailureReports),
  };
}

function writeAppState(state) {
  const normalized = writeState(STATE_FILE, {
    ...state,
    guiFailureReports: normalizeGuiFailureReports(state.guiFailureReports),
  }, { isThreadId: isCodexThreadId });
  invalidateCodexThreadListCache();
  return normalized;
}

function writeControlOverride(kind, value) {
  const state = readAppState();
  const next = {
    ...(state.controlOverrides || {}),
    updatedAt: new Date().toISOString(),
  };
  if (kind === 'model') next.model = String(value || '').trim();
  if (kind === 'reasoning') next.reasoning = String(value || '').trim();
  if (kind === 'speed') next.speed = String(value || '').trim();
  state.controlOverrides = next;
  return writeAppState(state).controlOverrides;
}

function controlOverrideIsFresh(overrides = {}, parsedUpdatedAt = '') {
  const overrideMs = Date.parse(overrides.updatedAt || '');
  const parsedMs = Date.parse(parsedUpdatedAt || '');
  if (!Number.isFinite(overrideMs)) return false;
  if (!Number.isFinite(parsedMs)) return true;
  return overrideMs >= parsedMs;
}

function controlOverrideModel(overrides = {}, parsed = {}) {
  if (!overrides.model || !controlOverrideIsFresh(overrides, parsed.updatedAt || '')) return null;
  const model = modelInfoFromId(overrides.model, overrides.updatedAt);
  return model && model.available ? model : null;
}

function controlOverrideReasoning(overrides = {}, parsed = {}) {
  if (!overrides.reasoning || !controlOverrideIsFresh(overrides, parsed.updatedAt || '')) return null;
  const mode = reasoningModeFromValue(overrides.reasoning, overrides.updatedAt);
  return mode && mode.available ? mode : null;
}

function controlOverrideSpeed(overrides = {}, parsed = {}) {
  if (!overrides.speed || !controlOverrideIsFresh(overrides, parsed.updatedAt || '')) return null;
  const mode = speedModeFromValue(overrides.speed, overrides.updatedAt);
  return mode && mode.available ? mode : null;
}



function normalizeGuiFailureReports(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [threadId, rows] of Object.entries(value)) {
    if (!isCodexThreadId(threadId) || !Array.isArray(rows)) continue;
    const normalizedRows = rows
      .map(row => ({
        turnId: typeof row.turnId === 'string' ? row.turnId : '',
        text: truncateText(normalizeHistoryText(row.text || ''), 2000),
        capturedAt: typeof row.capturedAt === 'string' ? row.capturedAt : '',
        completedAt: typeof row.completedAt === 'string' ? row.completedAt : '',
        source: typeof row.source === 'string' ? row.source : 'unknown',
      }))
      .filter(row => row.text)
      .slice(-GUI_FAILURE_REPORT_LIMIT);
    if (normalizedRows.length) out[threadId] = normalizedRows;
  }
  return out;
}

function setThreadSetMembership(list, threadId, enabled) {
  const set = new Set((Array.isArray(list) ? list : []).filter(isCodexThreadId));
  if (enabled) set.add(threadId);
  else set.delete(threadId);
  return [...set];
}

function truncateText(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function truncateDisplayTextPreservingLines(value, max = 1200) {
  const text = normalizeHistoryText(value)
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractPlainTextDeep(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPlainTextDeep(item, seen));
    return out;
  }

  for (const key of ['message', 'detail', 'details', 'error', 'reason', 'description', 'status', 'code', 'title', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...extractPlainTextDeep(value[key], seen));
  }
  return out;
}

function isFailureLikePayload(payload = {}) {
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const code = String(payload.code || '').toLowerCase();
  return (
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
    payload.error != null ||
    payload.detail != null ||
    payload.details != null ||
    payload.reason != null
  );
}

function isTerminalFailurePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const type = String(payload.type || '').toLowerCase();
  return (
    type === 'turn_aborted' ||
    /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
    (
      isFailureLikePayload(payload) &&
      /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type)
    )
  );
}

function isInterruptedFailurePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const text = [
    payload.type,
    payload.reason,
    payload.message,
    payload.error,
    payload.status,
    payload.code,
  ].map(value => String(value || '').toLowerCase()).join(' ');
  return /interrupt|interrupted|abort|aborted|cancel|cancelled|canceled|stop|stopped|turn_aborted|终止|中断|取消/.test(text);
}

function extractFailureTextFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !isFailureLikePayload(payload)) return '';
  const text = extractPlainTextDeep(payload)
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^(true|false|null|undefined)$/i.test(value))
    .join('\n');
  return truncateText(text, 1600);
}

function emptyCodexFailureText() {
  return 'Codex GUI 这次没有返回可显示回复。会话日志也没有写入可读取的失败提示原文；请在电脑 Codex GUI 查看原始失败提示。';
}

function decodeLogQuotedValue(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function safeParseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonAssignment(line, key) {
  const marker = `${key}=`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const open = line.indexOf('{', start + marker.length);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return line.slice(open, i + 1);
    }
  }
  return null;
}

function extractDesktopLogFailureText(line) {
  const raw = String(line || '');
  if (!/(?:\berror\b|failed|failure|Forbidden|unexpected status|channel affinity|AiMaMi|revoked|Unauthorized)/i.test(raw)) return '';
  if (/(?:git\.command\.complete|worker_rpc_response_error|Conversation state not found|Received turn\/(?:started|completed) for unknown conversation|Item not found in turn state)/i.test(raw)) return '';
  const candidates = [];
  for (const key of ['error', 'result']) {
    const jsonText = extractJsonAssignment(raw, key);
    const parsed = jsonText ? safeParseJsonText(jsonText) : null;
    const directText = parsed && typeof parsed === 'object'
      ? normalizeHistoryText(parsed.message || parsed.detail || parsed.error || parsed.reason || '')
      : '';
    const text = parsed ? (directText || extractFailureTextFromPayload(parsed) || truncateText(extractPlainTextDeep(parsed).map(value => normalizeHistoryText(value)).filter(Boolean).join('\n'), 2000)) : '';
    if (text) candidates.push(text);
  }
  for (const key of ['errorMessage', 'message', 'detail']) {
    const match = raw.match(new RegExp(`(?:^|\\s)${key}="((?:\\\\.|[^"])*)"`, 'i'));
    if (match) candidates.push(decodeLogQuotedValue(match[1]));
  }
  if (!candidates.length && /(?:unexpected status|Forbidden|channel affinity|AiMaMi)/i.test(raw)) {
    candidates.push(raw.replace(/^\S+\s+\w+\s+\[[^\]]+\]\s*/, '').trim());
  }
  const text = uniqueList(candidates
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^Request failed$/i.test(value)))
    .join('\n');
  return truncateText(text, 2000);
}

function scoreDesktopFailureLine(line, text, options = {}) {
  const raw = String(line || '');
  const failure = String(text || '');
  if (!failure) return 0;
  let score = 1;
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (threadId && raw.includes(threadId)) score += 80;
  if (turnId && raw.includes(turnId)) score += 80;
  if (/Structured turn failed/i.test(failure)) score += 55;
  if (/unexpected status|Forbidden|channel affinity|AiMaMi/i.test(failure)) score += 45;
  if (/refresh token was revoked|log out and sign in again|access token could not be refreshed/i.test(failure)) score += 45;
  if (/Failed to generate thread title/i.test(raw) && /Structured turn failed/i.test(failure)) score += 25;
  if (/Conversation state not found|unknown conversation|Failed to write temporary index tree snapshot|remote\.upstream\.url/i.test(failure)) score -= 80;
  return score;
}

function recentCodexDesktopLogFiles(referenceMs = Date.now()) {
  return walkFiles(CODEX_DESKTOP_LOGS_DIR, file => file.endsWith('.log'))
    .map(file => {
      try {
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.mtimeMs >= referenceMs - GUI_FAILURE_LOG_RECENT_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 40)
    .map(item => item.file);
}

function findCodexDesktopFailureText(options = {}) {
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  const startedMs = Date.parse(options.startedAt || '') || 0;
  const completedMs = Date.parse(options.completedAt || '') || Date.now();
  const minMs = startedMs ? startedMs - 60 * 1000 : completedMs - GUI_FAILURE_LOG_RECENT_MS;
  const maxMs = completedMs + 2 * 60 * 1000;
  const matches = [];
  for (const file of recentCodexDesktopLogFiles(completedMs)) {
    let lines;
    try {
      lines = readTailLinesWithLimit(file, GUI_FAILURE_LOG_SCAN_BYTES);
    } catch {
      continue;
    }
    for (const line of lines) {
      const lineMs = Date.parse(line.slice(0, 24));
      if (Number.isFinite(lineMs) && (lineMs < minMs || lineMs > maxMs)) continue;
      const text = extractDesktopLogFailureText(line);
      const score = scoreDesktopFailureLine(line, text, options);
      if (score >= 50) matches.push({ text, lineMs: Number.isFinite(lineMs) ? lineMs : 0, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.lineMs - a.lineMs);
  return matches[0] ? matches[0].text : '';
}

function findStoredGuiFailureText(threadId, options = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const rows = readAppState().guiFailureReports[threadId] || [];
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (turnId) {
    const exact = [...rows].reverse().find(row => row.turnId === turnId && row.text);
    if (exact) return exact.text;
  }
  const completedMs = Date.parse(options.completedAt || '') || 0;
  if (completedMs) {
    const close = [...rows].reverse().find(row => {
      const rowMs = Date.parse(row.completedAt || row.capturedAt || '') || 0;
      return row.text && rowMs && Math.abs(rowMs - completedMs) <= GUI_FAILURE_LOG_RECENT_MS;
    });
    if (close) return close.text;
  }
  const latest = rows[rows.length - 1];
  return latest && latest.text ? latest.text : '';
}

function storeGuiFailureText(threadId, report = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const text = truncateText(normalizeHistoryText(report.text || ''), 2000);
  if (!text || text === emptyCodexFailureText()) return '';
  const state = readAppState();
  const rows = state.guiFailureReports[threadId] || [];
  const turnId = typeof report.turnId === 'string' ? report.turnId : '';
  const completedAt = typeof report.completedAt === 'string' ? report.completedAt : '';
  const existingIndex = rows.findIndex(row => (turnId && row.turnId === turnId) || (completedAt && row.completedAt === completedAt && row.text === text));
  const row = {
    turnId,
    text,
    capturedAt: new Date().toISOString(),
    completedAt,
    source: typeof report.source === 'string' ? report.source : 'codex_desktop',
  };
  if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...row };
  else rows.push(row);
  state.guiFailureReports[threadId] = rows.slice(-GUI_FAILURE_REPORT_LIMIT);
  writeAppState(state);
  return text;
}

function resolveFailureTextForTurn(threadId, options = {}) {
  const sessionText = normalizeHistoryText(options.failureText || '');
  if (sessionText) {
    storeGuiFailureText(threadId, { ...options, text: sessionText, source: 'codex_session' });
    return sessionText;
  }
  const storedText = findStoredGuiFailureText(threadId, options);
  if (storedText) return storedText;
  const desktopText = findCodexDesktopFailureText({ ...options, threadId });
  if (desktopText) return storeGuiFailureText(threadId, { ...options, text: desktopText, source: 'codex_desktop_log' }) || desktopText;
  return '';
}

function cleanUserHistoryText(value) {
  const goalText = extractGoalObjectiveText(value);
  const text = normalizeHistoryText(goalText || value);
  const marker = '## My request for Codex:';
  const index = text.indexOf(marker);
  if (index >= 0) return normalizeHistoryText(text.slice(index + marker.length));
  return text;
}

function isInternalCodexTitleText(value) {
  const text = normalizeHistoryText(value).trim().toLowerCase();
  if (!text) return true;
  return /^<(?:environment_context|turn_aborted|codex_internal_context|system_context|developer_context)\b/.test(text);
}

function attachForegroundNotice(status) {
  const foregroundNotice = createForegroundNoticeForStatus(status);
  return foregroundNotice ? { ...status, foregroundNotice } : status;
}

function extractGoalObjectiveText(value) {
  const text = normalizeHistoryText(value);
  if (!/<codex_internal_context\b[^>]*source=["']goal["'][^>]*>/i.test(text)) return '';
  const match = text.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  return match ? normalizeHistoryText(match[1]) : '';
}

function isPlaceholderThreadName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  if (isInternalCodexTitleText(text)) return true;
  return [
    '未命名线程',
    '未命名',
    'untitled',
    'untitled thread',
    'new thread',
  ].includes(text);
}

function summarizeThreadTitle(value, maxLength = 34) {
  let text = cleanUserHistoryText(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[key]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[#>*_[\]()~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}…`;
}

function titleFromCodexHistoryItem(item) {
  const payload = item?.payload || {};
  if (item?.type === 'event_msg' && payload.type === 'user_message') {
    const text = cleanUserHistoryText(payload.message);
    if (isInternalCodexTitleText(text)) return '';
    return summarizeThreadTitle(text);
  }
  if (item?.type === 'response_item' && payload.role === 'user') {
    const userHistoryMessage = extractUserHistoryMessage(item);
    if (!userHistoryMessage || isInternalCodexTitleText(userHistoryMessage.text)) return '';
    return summarizeThreadTitle(userHistoryMessage.text);
  }
  return '';
}

function walkFiles(dir, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function listCodexSessionFiles(options = {}) {
  const now = Date.now();
  if (!options.force && codexSessionFilesCache.files.length && now - codexSessionFilesCache.at <= CODEX_SESSION_FILE_CACHE_MS) {
    return codexSessionFilesCache.files;
  }
  const files = walkFiles(CODEX_SESSIONS_DIR, file => file.endsWith('.jsonl'));
  codexSessionFilesCache = { at: now, files };
  return files;
}

function threadIdFromSessionFile(file) {
  return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
}

function normalizeComparableMessage(value) {
  return cleanUserHistoryText(value).replace(/\s+/g, ' ').trim();
}

function findLatestCodexSessionFile(options = {}) {
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const afterMs = Number(options.afterMs) || 0;
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const files = listCodexSessionFiles(afterMs ? { force: true } : {});
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (afterMs && stat.mtimeMs < afterMs - 2500) continue;
      const meta = readSessionMeta(file);
      if (!shouldIncludeCodexSessionMeta(meta, options)) continue;
      if (expectedCwd) {
        const metaCwd = validLocalDirectory(meta.cwd || '');
        if (metaCwd !== expectedCwd) continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

function findCodexSessionFileByName(name) {
  if (!name || name.includes('/') || name.includes('..')) return null;
  const files = listCodexSessionFiles();
  return files.find(file => path.basename(file) === name) || null;
}

function findCodexSessionFileByThreadId(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  const files = listCodexSessionFiles();
  let best = null;
  for (const file of files) {
    if (!path.basename(file).includes(threadId)) continue;
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best && best.file;
}

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function normalizeCodexThreadId(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/(?:^|:)([a-f0-9]{8}-[a-f0-9-]{27,})$/i);
  return match ? match[1] : '';
}

function normalizeCurrentThreadPreviewText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^What should we get done\?\s*/i, '')
    .trim();
}

function currentThreadPreviewCandidates(value) {
  const text = normalizeCurrentThreadPreviewText(value);
  if (text.length < 48) return [];
  const candidates = [];
  candidates.push(text.slice(0, Math.min(140, text.length)));
  if (text.length > 220) candidates.push(text.slice(80, Math.min(240, text.length)));
  return candidates
    .map(item => item.trim())
    .filter(item => item.length >= 48);
}

function findCodexThreadIdByVisibleText(value) {
  const candidates = currentThreadPreviewCandidates(value);
  if (candidates.length === 0) return '';
  for (const file of listCodexSessionFiles()) {
    const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
    if (!match) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
      if (candidates.some(candidate => raw.includes(candidate))) return match[1];
    } catch {}
  }
  return '';
}

function codexThreadDeepLink(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  // Codex desktop's own “Copy app link” action uses codex://threads/<id>.
  // The previous codex://local/<id> only brought the app forward on this build,
  // but did not navigate the visible UI, so paste could still hit the wrong thread.
  return `codex://threads/${threadId}`;
}

function codexNewThreadDeepLink(cwd = '') {
  const url = new URL('codex://threads/new');
  if (cwd) url.searchParams.set('path', cwd);
  return url.toString();
}

function readThreadIndex() {
  let stat = null;
  try { stat = fs.statSync(CODEX_SESSION_INDEX); } catch {}
  if (
    stat &&
    threadIndexCache.byId &&
    threadIndexCache.mtimeMs === stat.mtimeMs &&
    threadIndexCache.size === stat.size
  ) {
    return new Map(threadIndexCache.byId);
  }
  const byId = new Map();
  try {
    const lines = fs.readFileSync(CODEX_SESSION_INDEX, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.thread_name || '',
          updatedAt: item.updated_at || '',
        });
      } catch {}
    }
  } catch {}
  if (stat) threadIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, byId: new Map(byId) };
  return byId;
}

function findFirstCodexUserMessage(file, maxBytes = CODEX_TITLE_SCAN_BYTES) {
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  const cacheKey = `${file}:${fileCacheSignature(stat)}:${maxBytes}`;
  if (firstUserMessageCache.has(cacheKey)) return firstUserMessageCache.get(cacheKey);
  const limit = Math.min(stat.size, maxBytes);
  const chunkSize = 64 * 1024;
  const maxLineBytes = 2 * 1024 * 1024;
  let fd;
  let carry = '';
  let skippingLongLine = false;

  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    while (offset < limit) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(chunkSize, limit - offset), offset);
      if (!bytes) break;
      offset += bytes;
      let text = buffer.toString('utf8', 0, bytes);

      if (skippingLongLine) {
        const newline = text.indexOf('\n');
        if (newline < 0) continue;
        text = text.slice(newline + 1);
        skippingLongLine = false;
      }

      carry += text;
      if (carry.length > maxLineBytes) {
        const newline = carry.indexOf('\n');
        if (newline < 0) {
          carry = '';
          skippingLongLine = true;
          continue;
        }
      }

      let newlineIndex;
      while ((newlineIndex = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newlineIndex);
        carry = carry.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const title = titleFromCodexHistoryItem(item);
        if (title) return boundedSet(firstUserMessageCache, cacheKey, title);
      }
    }

    if (carry.trim() && carry.length <= maxLineBytes) {
      try {
        const item = JSON.parse(carry);
        const title = titleFromCodexHistoryItem(item);
        if (title) return boundedSet(firstUserMessageCache, cacheKey, title);
      } catch {}
    }
  } catch {
    return '';
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return boundedSet(firstUserMessageCache, cacheKey, '');
}

function readSessionMeta(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch {}
  const cacheKey = stat ? `${file}:${fileCacheSignature(stat)}` : '';
  if (cacheKey && sessionMetaCache.has(cacheKey)) return sessionMetaCache.get(cacheKey);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lines = buffer.toString('utf8', 0, bytes).split('\n').filter(Boolean).slice(0, 80);
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'session_meta' && item.payload) return cacheKey ? boundedSet(sessionMetaCache, cacheKey, item.payload) : item.payload;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return cacheKey ? boundedSet(sessionMetaCache, cacheKey, {}) : {};
}

function userMessageMatchScore(file, sinceMs = 0, text = '') {
  const expected = normalizeComparableMessage(text);
  const items = readJsonlTailObjects(file, CODEX_TITLE_SCAN_BYTES);
  let score = 0;
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const t = Date.parse(item.timestamp || '');
    if (sinceMs && Number.isFinite(t) && t < sinceMs - 2500) continue;
    const actual = normalizeComparableMessage(payload.message || '');
    if (!actual && expected) continue;
    score = Math.max(score, 10);
    if (Number.isFinite(t)) score += Math.max(0, Math.min(25, Math.round((t - sinceMs) / 1000) + 20));
    if (expected && actual) {
      if (actual === expected) score += 100;
      else if (actual.includes(expected) || expected.includes(actual)) score += 70;
    }
  }
  return score;
}

function findCodexSessionFileForNewSend(options = {}) {
  const sinceMs = Number(options.sinceMs) || 0;
  const text = typeof options.text === 'string' ? options.text : '';
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const files = listCodexSessionFiles({ force: true });
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (sinceMs && stat.mtimeMs < sinceMs - 2500) continue;
      const meta = readSessionMeta(file);
      if (!shouldIncludeCodexSessionMeta(meta, options)) continue;
      let score = userMessageMatchScore(file, sinceMs, text);
      if (score <= 0 && text.trim()) continue;
      const metaCwd = validLocalDirectory(meta.cwd || '');
      if (expectedCwd) {
        if (metaCwd !== expectedCwd) continue;
        score += 35;
      }
      score += Math.max(0, Math.min(20, Math.round((stat.mtimeMs - sinceMs) / 1000) + 10));
      if (!best || score > best.score || (score === best.score && stat.mtimeMs > best.mtimeMs)) {
        best = { file, score, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

async function waitForCodexSessionFileForNewSend(options = {}, timeoutMs = 2600) {
  const deadline = Date.now() + timeoutMs;
  let file = null;
  while (Date.now() <= deadline) {
    file = findCodexSessionFileForNewSend(options);
    if (file) return file;
    await delay(220);
  }
  return findCodexSessionFileForNewSend(options);
}

function readJsonlTailObjects(file, maxBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const start = Math.max(0, stat.size - maxBytes);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function summarizeCodexRuntimeItems(items, stat = null) {
  let status = 'idle';
  let active = false;
  let startedAt = '';
  let completedAt = '';
  let terminalKind = '';
  let updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : '';
  let turnId = '';
  let sawRuntimeActivity = false;
  let sawTaskMarker = false;

  for (const item of items) {
    const payload = item.payload || {};
    if (item.timestamp) updatedAt = item.timestamp;
    if (item.type === 'response_item' || (item.type === 'event_msg' && payload.type && !String(payload.type).startsWith('task_'))) {
      sawRuntimeActivity = true;
    }
    if (item.type === 'turn_context' && payload.turn_id) turnId = payload.turn_id;
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      sawTaskMarker = true;
      status = 'running';
      active = true;
      terminalKind = '';
      startedAt = item.timestamp || startedAt;
      completedAt = '';
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      sawTaskMarker = true;
      status = 'complete';
      active = false;
      terminalKind = 'complete';
      completedAt = item.timestamp || completedAt;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      sawTaskMarker = true;
      status = 'error';
      active = false;
      terminalKind = isInterruptedFailurePayload(payload) ? 'interrupted' : 'error';
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  return { status, active, startedAt, completedAt, terminalKind, updatedAt, turnId, sawRuntimeActivity, sawTaskMarker };
}

function quickCodexRuntimeFromFile(file, stat = null) {
  let fileStat = stat;
  if (!fileStat) {
    try { fileStat = fs.statSync(file); } catch { fileStat = null; }
  }
  const cacheKey = fileStat ? `${file}:${fileCacheSignature(fileStat)}` : '';
  if (cacheKey && runtimeSummaryCache.has(cacheKey)) return runtimeSummaryCache.get(cacheKey);
  const isFresh = fileStat ? Date.now() - fileStat.mtimeMs <= CODEX_RUNTIME_STALE_MS : false;
  let runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_TAIL_BYTES), fileStat);

  if (
    runtime.status === 'idle' &&
    runtime.sawRuntimeActivity &&
    !runtime.sawTaskMarker &&
    isFresh &&
    fileStat &&
    fileStat.size > CODEX_ACTIVITY_TAIL_BYTES
  ) {
    runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_LOOKBACK_BYTES), fileStat);
  }

  if (runtime.status === 'idle' && runtime.sawRuntimeActivity && !runtime.sawTaskMarker && isFresh) {
    runtime.status = 'running';
    runtime.active = true;
  }
  if (runtime.status === 'running' && fileStat && !isFresh) {
    runtime.status = 'idle';
    runtime.active = false;
  }

  const { status, active, startedAt, completedAt, terminalKind, updatedAt, turnId } = runtime;
  return cacheKey
    ? boundedSet(runtimeSummaryCache, cacheKey, { status, active, startedAt, completedAt, terminalKind, updatedAt, turnId }, 600)
    : { status, active, startedAt, completedAt, terminalKind, updatedAt, turnId };
}

function shouldIncludeCodexSessionMeta(meta, options = {}) {
  return options.includeSubagents === true || !isSubagentSessionMeta(meta);
}

function normalizeCurrentThreadSelection(value) {
  if (!value || typeof value !== 'object') return null;
  const preview = typeof value.preview === 'string' ? value.preview : '';
  const threadId = normalizeCodexThreadId(value.threadId) || findCodexThreadIdByVisibleText(preview);
  if (!threadId) return null;
  return {
    threadId,
    title: typeof value.title === 'string' && value.title.trim()
      ? value.title.trim()
      : normalizeCurrentThreadPreviewText(preview).slice(0, 120),
    source: typeof value.source === 'string' ? value.source : 'codex-cdp',
    observedAt: new Date().toISOString(),
  };
}

async function readCurrentCodexThreadSelectionViaCdp() {
  const target = await findCodexCdpTarget({ autoOpen: false });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    const selection = await cdpEvaluate(client, `(() => {
      const threadIdPattern = /^(?:local:)?[a-f0-9]{8}-[a-f0-9-]{27,}$/i;
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          rect.bottom >= 0 && rect.y <= innerHeight &&
          rect.right >= 0 && rect.x <= innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden';
      };
      const cleanText = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .filter(visible)
        .map(el => ({
          threadId: el.getAttribute('data-app-action-sidebar-thread-id') || '',
          active: el.getAttribute('data-app-action-sidebar-thread-active') === 'true' ||
            el.getAttribute('aria-current') === 'true' ||
            el.matches('[aria-current="true"], [data-state="active"], .active, .is-active'),
          text: cleanText(el.textContent),
        }))
        .filter(row => threadIdPattern.test(row.threadId));
      const active = rows.find(row => row.active);
      if (active) return { threadId: active.threadId, title: active.text, source: 'codex-cdp-sidebar' };
      const urlMatch = String(location.href || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})/i);
      if (urlMatch && threadIdPattern.test(urlMatch[1])) {
        return { threadId: urlMatch[1], title: document.title || '', source: 'codex-cdp-location' };
      }
      const mainText = cleanText((document.querySelector('main') || document.body || {}).innerText || '');
      if (mainText.length > 0) {
        return { preview: mainText.slice(0, 2200), source: 'codex-cdp-main' };
      }
      return null;
    })()`);
    return normalizeCurrentThreadSelection(selection);
  } finally {
    client.close();
  }
}

async function readCurrentCodexThreadSelection(options = {}) {
  const now = Date.now();
  if (
    options.force !== true &&
    codexCurrentThreadCache.selection &&
    now - codexCurrentThreadCache.at <= CODEX_CURRENT_THREAD_CACHE_MS
  ) {
    return codexCurrentThreadCache.selection;
  }

  try {
    const selection = await readCurrentCodexThreadSelectionViaCdp();
    codexCurrentThreadCache = { at: now, selection };
    return selection;
  } catch {
    codexCurrentThreadCache = { at: now, selection: null };
    return null;
  }
}

function listCodexThreads(limit = 500, options = {}) {
  const normalizedLimit = normalizeThreadListLimit(limit);
  const includeSubagents = options.includeSubagents === true;
  const includeThreadId = normalizeCodexThreadId(options.includeThreadId);
  const cacheKey = `${normalizedLimit}:${includeSubagents ? 'with-subagents' : 'user-only'}:${includeThreadId}`;
  const cached = codexThreadListCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= CODEX_THREAD_LIST_CACHE_MS) return cached.threads;
  const miniState = readAppState();
  const pinnedThreadIds = new Set(miniState.pinnedThreadIds || []);
  const archivedThreadIds = new Set(miniState.archivedThreadIds || []);
  const titleOverrides = miniState.titleOverrides || {};
  const byId = readThreadIndex();
  for (const file of listCodexSessionFiles()) {
    const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
    if (!match) continue;
    const id = match[1];
    try {
      const stat = fs.statSync(file);
      const meta = readSessionMeta(file);
      if (!shouldIncludeCodexSessionMeta(meta, { includeSubagents })) continue;
      const runtime = quickCodexRuntimeFromFile(file, stat);
      const project = classifyThreadProject(meta.cwd || '');
      const existing = byId.get(id) || { id, name: '', updatedAt: '' };
      const fallbackName = isPlaceholderThreadName(existing.name) ? findFirstCodexUserMessage(file) : '';
      existing.name = isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名线程') : existing.name;
      existing.nameSource = fallbackName && existing.name === fallbackName ? 'first_user_message' : 'index';
      const override = titleOverrides[id];
      if (override && typeof override.name === 'string' && override.name.trim()) {
        const overrideTime = Date.parse(override.renamedAt || '') || 0;
        const indexTime = Date.parse(existing.updatedAt || '') || 0;
        if (!indexTime || !overrideTime || indexTime <= overrideTime + 2000 || existing.name === override.name || isPlaceholderThreadName(existing.name)) {
          existing.name = override.name.trim();
          existing.nameSource = 'codex2frp_override';
        }
      }
      existing.sessionFile = path.basename(file);
      existing.mtimeMs = stat.mtimeMs;
      existing.updatedAt = existing.updatedAt || meta.timestamp || new Date(stat.mtimeMs).toISOString();
      existing.effectiveUpdatedMs = Math.max(Date.parse(existing.updatedAt) || 0, stat.mtimeMs || 0);
      existing.cwd = meta.cwd || '';
      existing.source = meta.source || '';
      existing.threadSource = meta.thread_source || '';
      existing.runtimeStatus = runtime.status;
      existing.runtimeActive = runtime.active;
      existing.runtimeStartedAt = runtime.startedAt;
      existing.runtimeCompletedAt = runtime.completedAt;
      existing.runtimeTerminalKind = runtime.terminalKind;
      existing.runtimeUpdatedAt = runtime.updatedAt;
      existing.runtimeTurnId = runtime.turnId;
      existing.pinned = pinnedThreadIds.has(id);
      Object.assign(existing, project);
      byId.set(id, existing);
    } catch {}
  }
  const sortedThreads = [...byId.values()]
    .filter(item => item.sessionFile && !archivedThreadIds.has(item.id))
    .map(item => {
      const effectiveUpdatedMs = item.effectiveUpdatedMs || Math.max(Date.parse(item.updatedAt) || 0, item.mtimeMs || 0);
      return { ...item, effectiveUpdatedMs, effectiveUpdatedAt: new Date(effectiveUpdatedMs).toISOString() };
    })
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.effectiveUpdatedMs - a.effectiveUpdatedMs);
  const threads = sortedThreads.slice(0, normalizedLimit);
  if (includeThreadId && !threads.some(item => item.id === includeThreadId)) {
    const selected = sortedThreads.find(item => item.id === includeThreadId);
    if (selected) {
      if (threads.length >= normalizedLimit && threads.length > 0) threads[threads.length - 1] = selected;
      else threads.push(selected);
    }
  }
  boundedSet(codexThreadListCache, cacheKey, { at: Date.now(), threads }, 20);
  return threads;
}

async function handleThreads(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const forceRefresh = url.searchParams.get('refresh') === '1';
  if (forceRefresh) invalidateCodexThreadListCache();
  const limit = normalizeThreadListLimit(url.searchParams.get('limit'));
  const includeSubagents = url.searchParams.get('includeSubagents') === '1';
  const currentThread = await readCurrentCodexThreadSelection({ force: forceRefresh });
  const selectedThreadId = currentThread && currentThread.threadId ? currentThread.threadId : '';
  const threads = listCodexThreads(limit, { includeSubagents, includeThreadId: selectedThreadId });
  return json(res, 200, {
    ok: true,
    selectedThreadId,
    currentThreadId: selectedThreadId,
    currentThread,
    threads,
  });
}

function compactForegroundThreadSnapshot(thread) {
  return {
    id: thread.id,
    name: thread.name || thread.title || '',
    runtimeStatus: thread.runtimeStatus || '',
    runtimeActive: Boolean(thread.runtimeActive),
    runtimeStartedAt: thread.runtimeStartedAt || '',
    runtimeCompletedAt: thread.runtimeCompletedAt || '',
    runtimeTerminalKind: thread.runtimeTerminalKind || '',
    runtimeUpdatedAt: thread.runtimeUpdatedAt || '',
    runtimeTurnId: thread.runtimeTurnId || '',
    runtimeError: thread.runtimeError || '',
    runtimeFinalText: thread.runtimeFinalText || '',
  };
}

function handleForegroundNotices(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.searchParams.get('refresh') === '1') invalidateCodexThreadListCache();
  const limit = normalizeThreadListLimit(url.searchParams.get('limit') || 500);
  const now = new Date().toISOString();
  const threads = listCodexThreads(limit, { includeSubagents: false });
  const currentSnapshot = threads.map(compactForegroundThreadSnapshot);
  const notices = foregroundNoticeSnapshotReady
    ? createForegroundNoticesForThreadSnapshots(foregroundNoticeThreadSnapshot, currentSnapshot, { now }).slice(0, 8)
    : [];
  foregroundNoticeThreadSnapshot = currentSnapshot;
  foregroundNoticeSnapshotReady = true;
  return json(res, 200, {
    ok: true,
    notices,
    count: notices.length,
    snapshotAt: now,
  });
}

function readTailLines(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readTailLinesWithLimit(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function statusTailNeedsExpansion(lines, sinceMs = 0, stat = null) {
  let hasRuntimeActivity = false;
  let lastTaskMarker = '';
  let runtimeAfterTerminal = false;
  let sawSinceWindow = !sinceMs;

  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};
    const timestampMs = Date.parse(item.timestamp || '');
    const inSinceWindow = !sinceMs || !Number.isFinite(timestampMs) || timestampMs >= sinceMs;
    if (!inSinceWindow) continue;
    sawSinceWindow = true;

    const isRuntimeActivity = item.type === 'response_item' ||
      (item.type === 'event_msg' && payload.type && !String(payload.type).startsWith('task_') && payload.type !== 'token_count');
    if (isRuntimeActivity) {
      hasRuntimeActivity = true;
      if (lastTaskMarker === 'terminal') runtimeAfterTerminal = true;
    }

    if (item.type === 'event_msg' && payload.type === 'task_started') {
      lastTaskMarker = 'started';
      runtimeAfterTerminal = false;
    } else if (item.type === 'event_msg' && (payload.type === 'task_complete' || isTerminalFailurePayload(payload))) {
      lastTaskMarker = 'terminal';
      runtimeAfterTerminal = false;
    }
  }

  if (!sawSinceWindow) return true;
  if (hasRuntimeActivity && !lastTaskMarker) return true;
  if (runtimeAfterTerminal) return true;
  const isFresh = stat ? Date.now() - stat.mtimeMs <= CODEX_RUNTIME_STALE_MS : false;
  return !sinceMs && isFresh && hasRuntimeActivity && lastTaskMarker === '';
}

function readStatusLinesAdaptive(file, options = {}) {
  const stat = fs.statSync(file);
  const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
  const sinceMs = Number(options.sinceMs || 0) || 0;
  const candidateSizes = [
    CODEX_SESSION_TAIL_BYTES,
    CODEX_SESSION_TAIL_BYTES * 3,
    CODEX_HISTORY_INITIAL_TAIL_BYTES * 6,
    CODEX_HISTORY_TAIL_BYTES,
  ];
  let lastLines = [];
  let lastBytes = 0;
  for (const candidateSize of candidateSizes) {
    const bytes = Math.min(maxBytes, candidateSize);
    if (bytes <= lastBytes) continue;
    lastBytes = bytes;
    lastLines = readTailLinesWithLimit(file, bytes);
    if (bytes >= maxBytes || !statusTailNeedsExpansion(lastLines, sinceMs, stat)) {
      return lastLines;
    }
  }
  return lastLines;
}

function countCodexHistoryMessages(lines, maxNeeded = MAX_HISTORY_MESSAGES) {
  let count = 0;
  let currentTurn = null;
  let lastUserHistoryMessage = null;
  const need = Math.max(1, Math.min(Number(maxNeeded) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = { hasAssistant: false };
      continue;
    }
    const userHistoryMessage = extractUserHistoryMessage(item);
    if (userHistoryMessage) {
      if (
        (userHistoryMessage.text || userHistoryMessage.attachments.length) &&
        !isDuplicateAdjacentUserHistoryMessage(lastUserHistoryMessage, userHistoryMessage, item.timestamp || '')
      ) {
        count += 1;
      }
      lastUserHistoryMessage = { ...userHistoryMessage, timestamp: item.timestamp || '' };
    } else if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
      const text = normalizeHistoryText(extractMessageText(payload.content));
      if (text) {
        count += 1;
        if (currentTurn) currentTurn.hasAssistant = true;
      }
    } else if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      if (currentTurn && !currentTurn.hasAssistant) count += lastMessage ? 1 : 1;
      currentTurn = null;
    } else if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      if (currentTurn && !currentTurn.hasAssistant) count += 1;
      currentTurn = null;
    }
    if (count >= need) return count;
  }
  return count;
}

function readHistoryLinesAdaptive(file, desiredMessages = MAX_HISTORY_MESSAGES) {
  const stat = fs.statSync(file);
  const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
  const desired = Math.max(1, Math.min(Number(desiredMessages) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));

  if (maxBytes <= CODEX_HISTORY_INITIAL_TAIL_BYTES * 6) {
    return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
  }

  const initialBytes = Math.min(CODEX_HISTORY_INITIAL_TAIL_BYTES, maxBytes);
  const initialLines = readTailLinesWithLimit(file, initialBytes);
  if (countCodexHistoryMessages(initialLines, desired) >= desired) {
    return { lines: initialLines, stat, scannedBytes: initialBytes };
  }

  return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
}

function extractUserAttachments(payload) {
  const paths = [];
  for (const key of ['local_images', 'images']) {
    if (!Array.isArray(payload[key])) continue;
    for (const item of payload[key]) {
      if (typeof item === 'string') paths.push(item);
      else if (item && typeof item.path === 'string') paths.push(item.path);
      else if (item && typeof item.filePath === 'string') paths.push(item.filePath);
    }
  }
  return paths;
}

function extractUserHistoryMessage(item) {
  const payload = item?.payload || {};
  if (item?.type === 'event_msg' && payload.type === 'user_message') {
    const text = cleanUserHistoryText(payload.message);
    const attachments = extractUserAttachments(payload);
    return (text || attachments.length) ? { text, attachments } : null;
  }
  if (item?.type !== 'response_item' || payload.role !== 'user') return null;
  let rawText = '';
  if (payload.type === 'message' && payload.role === 'user') rawText = extractMessageText(payload.content);
  else rawText = payload.message || payload.text || extractMessageText(payload.content);
  const objectiveText = extractGoalObjectiveText(rawText);
  const text = cleanUserHistoryText(objectiveText || rawText);
  const attachments = extractUserAttachments(payload);
  return (text || attachments.length) ? { text, attachments } : null;
}

function isDuplicateAdjacentUserHistoryMessage(previous, next, timestamp = '') {
  if (!previous || !next) return false;
  if (previous.role && previous.role !== 'user') return false;
  const previousText = normalizeComparableMessage(previous.text || '');
  const nextText = normalizeComparableMessage(next.text || '');
  if (previousText !== nextText) return false;
  const previousAttachmentCount = Array.isArray(previous.attachments) ? previous.attachments.length : 0;
  const nextAttachmentCount = Array.isArray(next.attachments) ? next.attachments.length : 0;
  if (previousAttachmentCount !== nextAttachmentCount) return false;
  const previousTime = Date.parse(previous.timestamp || '');
  const nextTime = Date.parse(timestamp || next.timestamp || '');
  return !Number.isFinite(previousTime) || !Number.isFinite(nextTime) || Math.abs(previousTime - nextTime) <= 1500;
}

function parseCodexThreadHistory(threadId, limit = MAX_HISTORY_MESSAGES) {
  const file = findCodexSessionFileByThreadId(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      messages: [],
      message: '没有找到所选线程的 Codex 会话文件。',
    };
  }
  let fileStat;
  try {
    fileStat = fs.statSync(file);
  } catch {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      messages: [],
      message: '没有找到所选线程的 Codex 会话文件。',
    };
  }

  const normalizedLimit = Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  const cacheKey = `${threadId}:${file}:${fileCacheSignature(fileStat)}:${normalizedLimit}`;
  if (threadHistoryCache.has(cacheKey)) return threadHistoryCache.get(cacheKey);

  const messages = [];
  let currentTurn = null;
  function addAssistantMessage(turn, text, timestamp, label = 'Codex') {
    const normalizedText = normalizeHistoryText(text);
    if (!normalizedText) return;
    if (turn && turn.hasAssistant && turn.assistantIndex >= 0 && messages[turn.assistantIndex]) {
      const existing = normalizeComparableMessage(messages[turn.assistantIndex].text || '');
      const next = normalizeComparableMessage(normalizedText);
      if (existing && next && (existing === next || existing.startsWith(next) || next.startsWith(existing))) return;
    }
    const assistantIndex = messages.length;
    messages.push({
      role: 'assistant',
      label,
      text: normalizedText,
      timestamp: timestamp || '',
    });
    if (turn) {
      turn.hasAssistant = true;
      turn.assistantIndex = assistantIndex;
    }
  }
  function updateApplyPatchStep(turn, item) {
    if (!turn) return;
    const payload = item.payload || {};
    if (
      item.type !== 'response_item' ||
      !['function_call_output', 'custom_tool_call_output'].includes(payload.type) ||
      !payload.call_id ||
      !turn.toolStepIndexById.has(payload.call_id)
    ) {
      return;
    }
    const callPayload = turn.toolCallsById.get(payload.call_id);
    if (callPayload && String(callPayload.name || '').split('.').pop() === 'apply_patch') {
      const stepIndex = turn.toolStepIndexById.get(payload.call_id);
      if (turn.steps[stepIndex]) {
        const summary = formatToolCallSummary(callPayload, { complete: true });
        turn.steps[stepIndex].text = summary.text;
        turn.steps[stepIndex].summaryKind = summary.kind;
        turn.steps[stepIndex].summaryCount = summary.count;
      }
    }
  }
  function addHistoryStep(turn, item) {
    if (!turn) return null;
    updateApplyPatchStep(turn, item);
    const step = stepFromEvent(item);
    if (!step) return null;
    if (step.kind === 'thinking') {
      const key = step.text || 'thinking';
      if (turn.seenThinking.has(key)) return step;
      turn.seenThinking.add(key);
    }
    if (['start', 'thinking', 'tool', 'complete', 'error'].includes(step.kind)) {
      if (step.kind === 'tool' && step.callId) {
        turn.toolCallsById.set(step.callId, item.payload || {});
        turn.toolStepIndexById.set(step.callId, turn.steps.length);
      }
      turn.steps.push(step);
    }
    return step;
  }
  function progressMessageForTurn(turn, status, completedAt = '') {
    if (!turn || !hasUsefulProcessSteps(turn.steps)) return null;
    return {
      id: progressMessageIdForTurn(threadId, turn.turnId || '', turn.startedAt || ''),
      role: status === 'error' ? 'system' : 'assistant',
      kind: 'progress',
      label: status === 'error' ? '失败' : '完成',
      text: compactProcessText(turn.steps),
      timestamp: turn.startedAt || completedAt || '',
      createdAt: turn.startedAt || completedAt || '',
      threadId,
      processSteps: turn.steps.slice(),
      processSummary: processSummaryFromSteps(status, turn.steps),
      processCollapsed: true,
      processStatus: status,
    };
  }
  function insertProgressBeforeFinal(turn, status, completedAt = '') {
    const progress = progressMessageForTurn(turn, status, completedAt);
    if (!progress) return;
    if (turn.assistantIndex >= 0 && messages[turn.assistantIndex]) {
      messages.splice(turn.assistantIndex, 0, progress);
      turn.assistantIndex += 1;
      return;
    }
    messages.push(progress);
  }
  function historyDurationText(startedAt = '', completedAt = '') {
    const startMs = Date.parse(startedAt || '');
    const endMs = Date.parse(completedAt || '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
    const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
  function historyCompleteLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 已处理 ${duration}` : 'Codex';
  }
  function historyFailureLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 失败 ${duration}` : 'Codex';
  }
  const historyTail = readHistoryLinesAdaptive(file, normalizedLimit);
  for (const line of historyTail.lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};

    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = {
        hasAssistant: false,
        assistantIndex: -1,
        failureText: '',
        startedAt: item.timestamp || '',
        turnId: payload.turn_id || '',
        steps: [],
        seenThinking: new Set(),
        toolCallsById: new Map(),
        toolStepIndexById: new Map(),
      };
      addHistoryStep(currentTurn, item);
      continue;
    }

    if (currentTurn && item.type === 'event_msg') {
      currentTurn.failureText = currentTurn.failureText || extractFailureTextFromPayload(payload);
    }

    if (currentTurn && item.type === 'turn_context') {
      currentTurn.turnId = payload.turn_id || currentTurn.turnId;
    }

    const userHistoryMessage = extractUserHistoryMessage(item);
    if (userHistoryMessage) {
      const { text, attachments } = userHistoryMessage;
      if (
        (text || attachments.length) &&
        !isDuplicateAdjacentUserHistoryMessage(messages[messages.length - 1], userHistoryMessage, item.timestamp || '')
      ) {
        messages.push({
          role: 'user',
          label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
          text: text || (attachments.length ? ' ' : ''),
          attachments: attachments.map(filePath => ({ filePath, name: path.basename(filePath) })),
          timestamp: item.timestamp || '',
        });
      }
      continue;
    }

    if (currentTurn) {
      const step = addHistoryStep(currentTurn, item);
      if (step && step.kind === 'final') {
        addAssistantMessage(currentTurn, step.text, item.timestamp || '', 'Codex');
        continue;
      }
    } else if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
      const text = normalizeHistoryText(extractMessageText(payload.content));
      addAssistantMessage(null, text, item.timestamp || '', 'Codex');
      continue;
    }

    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      const completedAt = item.timestamp || '';
      insertProgressBeforeFinal(currentTurn, 'complete', completedAt);
      if (currentTurn && !currentTurn.hasAssistant) {
        const failureText = resolveFailureTextForTurn(threadId, {
          turnId: currentTurn.turnId || '',
          startedAt: currentTurn.startedAt || '',
          completedAt,
          failureText: currentTurn.failureText || '',
        });
        const fallbackText = isProcessEchoMessage(lastMessage, currentTurn.steps) ? '' : lastMessage;
        if (fallbackText || failureText) {
          addAssistantMessage(
            currentTurn,
            fallbackText || failureText || emptyCodexFailureText(),
            completedAt || currentTurn.startedAt || '',
            failureText ? historyFailureLabel(currentTurn.startedAt, completedAt) : historyCompleteLabel(currentTurn.startedAt, completedAt)
          );
        }
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyCompleteLabel(currentTurn.startedAt, completedAt);
      }
      currentTurn = null;
    }

    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      const failureText = normalizeHistoryText(extractFailureTextFromPayload(payload) || currentTurn?.failureText || '');
      insertProgressBeforeFinal(currentTurn, 'error', item.timestamp || '');
      if (currentTurn && !currentTurn.hasAssistant) {
        addAssistantMessage(
          currentTurn,
          failureText || emptyCodexFailureText(),
          item.timestamp || currentTurn.startedAt || '',
          historyFailureLabel(currentTurn.startedAt, item.timestamp || '')
        );
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyFailureLabel(currentTurn.startedAt, item.timestamp || '');
      }
      currentTurn = null;
    }
  }

  return boundedSet(threadHistoryCache, cacheKey, {
    ok: true,
    available: true,
    threadId,
    sessionFile: path.basename(file),
    truncated: historyTail.stat.size > CODEX_HISTORY_TAIL_BYTES,
    messages: messages.slice(-normalizedLimit),
  }, 80);
}

function requestBaseUrl(req) {
  const headers = req.headers || {};
  const host = splitHeaderList(headerValues(headers['x-forwarded-host'])[0] || headers.host || '')[0] || `127.0.0.1:${PORT}`;
  const proto = splitHeaderList(headerValues(headers['x-forwarded-proto'])[0] || '')[0] || (isLocalHostValue(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

function imageMimeTypeForFile(filePath = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return '';
}

function attachmentUrlFor(req, filePath = '') {
  const url = new URL('/codex/attachment', requestBaseUrl(req));
  url.searchParams.set('path', filePath);
  url.searchParams.set('token', TOKEN);
  return url.toString();
}

function inlineAttachmentDataUrl(filePath = '', mimeType = '') {
  if (!filePath || !mimeType || INLINE_ATTACHMENT_BYTES <= 0) return '';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return '';
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > INLINE_ATTACHMENT_BYTES) return '';
  const key = `${filePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  const cached = inlineAttachmentCache.get(key);
  if (cached !== undefined) return cached;
  let dataUrl = '';
  try {
    dataUrl = `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
  } catch {
    dataUrl = '';
  }
  inlineAttachmentCache.set(key, dataUrl);
  while (inlineAttachmentCache.size > 64) {
    const firstKey = inlineAttachmentCache.keys().next().value;
    inlineAttachmentCache.delete(firstKey);
  }
  return dataUrl;
}

function attachmentFilePath(attachment = {}) {
  const directPath = String(attachment.filePath || attachment.path || '');
  if (directPath) return directPath;
  const sourceUrl = String(attachment.url || '');
  if (!sourceUrl) return '';
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.pathname !== '/codex/attachment') return '';
    return String(parsed.searchParams.get('path') || '');
  } catch {
    return '';
  }
}

function enrichAttachmentList(attachments, req, options = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return attachments;
  const inlineData = options.inlineData !== false;
  return attachments.map(attachment => {
    const filePath = attachmentFilePath(attachment);
    const mimeType = attachment.mime || attachment.mimeType || imageMimeTypeForFile(filePath);
    if (!filePath || !imageMimeTypeForFile(filePath)) {
      return {
        ...attachment,
        mime: attachment.mime || mimeType,
        mimeType: attachment.mimeType || mimeType,
      };
    }
    return {
      ...attachment,
      path: filePath,
      filePath,
      mime: attachment.mime || mimeType,
      mimeType: attachment.mimeType || mimeType,
      url: attachmentUrlFor(req, filePath),
      dataUrl: inlineData ? (attachment.dataUrl || inlineAttachmentDataUrl(filePath, mimeType)) : '',
    };
  });
}

function enrichStatusAttachments(status, req) {
  if (!status || !Array.isArray(status.steps)) return status;
  return {
    ...status,
    steps: status.steps.map(step => {
      if (!step || !Array.isArray(step.attachments) || !step.attachments.length) return step;
      return { ...step, attachments: enrichAttachmentList(step.attachments, req, { inlineData: false }) };
    }),
  };
}

function enrichHistoryAttachments(history, req) {
  if (!history || !Array.isArray(history.messages)) return history;
  return {
    ...history,
    messages: history.messages.map(message => {
      let next = message;
      if (Array.isArray(message.attachments) && message.attachments.length) {
        next = { ...next, attachments: enrichAttachmentList(message.attachments, req, { inlineData: false }) };
      }
      if (Array.isArray(message.processSteps) && message.processSteps.length) {
        next = {
          ...next,
          processSteps: message.processSteps.map(step => {
            if (!step || !Array.isArray(step.attachments) || !step.attachments.length) return step;
            return { ...step, attachments: enrichAttachmentList(step.attachments, req, { inlineData: false }) };
          }),
        };
      }
      return next;
    }),
  };
}

function handleThreadHistory(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const threadId = url.searchParams.get('thread') || '';
    if (!isCodexThreadId(threadId)) {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
    }
    if (url.searchParams.get('refresh') === '1' || url.searchParams.has('since')) invalidateCodexThreadListCache();
    return json(res, 200, enrichHistoryAttachments(parseCodexThreadHistory(threadId, url.searchParams.get('limit') || MAX_HISTORY_MESSAGES), req));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_HISTORY_FAILED', message: '读取 Codex 聊天记录失败。', detail: String(error && error.message || error) });
  }
}

function handleAttachment(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filePath = String(url.searchParams.get('path') || '');
    const mimeType = imageMimeTypeForFile(filePath);
    if (!filePath || !mimeType) {
      return json(res, 400, { ok: false, code: 'BAD_ATTACHMENT', message: '附件路径不是可显示图片。' });
    }
    const resolvedPath = path.resolve(filePath);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片附件不存在。' });
    }
    res.writeHead(200, {
      ...corsHeaders(),
      'content-type': mimeType,
      'cache-control': 'private, max-age=60',
      'content-length': stat.size,
    });
    fs.createReadStream(resolvedPath).pipe(res);
  } catch (error) {
    return json(res, 404, { ok: false, code: 'ATTACHMENT_NOT_FOUND', message: '图片附件无法读取。', detail: String(error && error.message || error) });
  }
}

function extractReasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload.summary)) {
    for (const item of payload.summary) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
      else if (item && typeof item.summary === 'string') parts.push(item.summary);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
    }
  }
  if (typeof payload.text === 'string') parts.push(payload.text);
  const visible = parts.map(x => String(x).trim()).filter(Boolean).join('\n');
  return visible;
}

function parseToolArguments(payload) {
  const raw = payload.arguments || payload.input || '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { raw: String(raw) }; }
}

function shellQuotePattern() {
  return String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:\\\S|\S)+)`;
}

function stripShellQuotes(value) {
  let text = String(value || '').trim();
  while ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\([\s"'])/g, '$1');
}

function shortPath(value) {
  const text = stripShellQuotes(value).replace(/^~\//, '~/');
  if (!text) return '';
  const home = os.homedir();
  const normalized = text.startsWith(home) ? `~${text.slice(home.length)}` : text;
  if (/^[./~\w-].*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest|png|jpg|jpeg|gif|svg)$/i.test(normalized)) {
    return normalized.replace(/^\.\//, '');
  }
  return normalized.replace(/^\.\//, '');
}


function isLikelyToolFile(value) {
  const text = stripShellQuotes(value);
  if (!text || text.startsWith('-') || text.startsWith('<') || /^\d+$/.test(text)) return false;
  if (/^[A-Z_]+$/.test(text)) return false;
  return /[./~]/.test(text) || /\.[A-Za-z0-9]{1,12}$/.test(text);
}

function uniqueList(values, limit = 3) {
  const out = [];
  for (const value of values) {
    const text = shortPath(value);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function joinToolTargets(values) {
  const list = uniqueList(values, 4);
  if (!list.length) return '';
  return list.join(', ');
}

function extractCommandFiles(cmd) {
  const files = [];
  const token = shellQuotePattern();
  const commandPatterns = [
    new RegExp(String.raw`\bsed\s+(?:-[A-Za-z]+\s+)?${token}\s+(${token})`, 'g'),
    new RegExp(String.raw`\bnl\s+(?:-[A-Za-z]+\s+)*(${token})`, 'g'),
    new RegExp(String.raw`\b(?:cat|head|tail)\s+(?:-[A-Za-z0-9]+\s+)*(?:-n\s+\d+\s+)?(${token})`, 'g'),
  ];
  for (const re of commandPatterns) {
    let match;
    while ((match = re.exec(cmd))) files.push(match[1]);
  }
  const redirectMatch = cmd.match(/<\s*([^\s|;&]+)/);
  if (redirectMatch && !/<<\s*$/.test(cmd.slice(Math.max(0, redirectMatch.index - 3), redirectMatch.index + 1))) files.push(redirectMatch[1]);
  return uniqueList(files.filter(isLikelyToolFile), 4);
}

function extractSearchTargets(cmd) {
  const afterGlob = cmd.replace(/--glob\s+(?:"[^"]+"|'[^']+'|\S+)/g, '');
  const matches = [...afterGlob.matchAll(/(?:^|\s)([./~\w-][^\s|;&]*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest))(?:\s|$)/gi)];
  return uniqueList(matches.map(match => match[1]), 4);
}

function truncateCommand(cmd, max = 120) {
  const oneLine = String(cmd || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  const home = os.homedir();
  const text = oneLine.startsWith(home) ? `~${oneLine.slice(home.length)}` : oneLine.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function patchStats(patch) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of String(patch || '').split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/) || line.match(/^@@\s+(.+?)\s*$/);
    if (fileMatch && !fileMatch[1].startsWith('@@')) files.push(fileMatch[1].trim());
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { files: uniqueList(files, 3), added, removed };
}

function CommandStepSummary(kind, text, count = 1, attachments = []) {
  return { kind, text, count: Math.max(1, Number(count) || 1), attachments };
}

function safeProgressId(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 72);
}

function progressMessageIdForTurn(threadId = '', turnId = '', startedAt = '') {
  const normalizedThreadId = threadId ? threadId : 'current';
  const turnKey = turnId || startedAt || 'history';
  return `progress-${safeProgressId(normalizedThreadId)}-${safeProgressId(String(turnKey))}`;
}

function normalizeImageSource(value = '', args = {}) {
  let text = String(value || '').trim().replace(/[),，。；;]+$/g, '');
  text = stripShellQuotes(text);
  if (!text) return '';
  if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return text;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')) return text;
  if ((args.workdir || args.cwd) && /\.(?:png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(text)) {
    return path.resolve(String(args.workdir || args.cwd), text);
  }
  return text;
}

function looksLikeImageSource(value = '') {
  const text = String(value || '').trim();
  return /^data:image\//i.test(text) ||
    /^https?:\/\/.+\.(?:png|jpe?g|gif|webp|bmp|heic|heif)(?:[?#].*)?$/i.test(text) ||
    /\.(?:png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(text);
}

function localImageFileExists(source = '') {
  try {
    return fs.statSync(path.resolve(String(source || ''))).isFile();
  } catch {
    return false;
  }
}

function imageAttachmentFromSource(value = '', args = {}) {
  const source = normalizeImageSource(value, args);
  if (!source || !looksLikeImageSource(source)) return null;
  if (/^data:image\//i.test(source)) {
    const mime = (source.match(/^data:([^;,]+)/i) || [])[1] || 'image/*';
    return { name: 'image', dataUrl: source, mime, mimeType: mime };
  }
  if (/^https?:\/\//i.test(source)) {
    let name = 'image';
    try { name = path.basename(new URL(source).pathname) || name; } catch {}
    return { name, url: source, mime: imageMimeTypeForFile(name) || 'image/*', mimeType: imageMimeTypeForFile(name) || 'image/*' };
  }
  if (!localImageFileExists(source)) return null;
  const filePath = path.resolve(source);
  const mime = imageMimeTypeForFile(filePath) || 'image/*';
  return { name: path.basename(filePath) || 'image', path: filePath, filePath, mime, mimeType: mime };
}

function addImageAttachment(attachments, seen, source, args = {}) {
  const attachment = imageAttachmentFromSource(source, args);
  if (!attachment) return;
  const key = attachment.url || attachment.dataUrl || attachment.filePath || attachment.path || '';
  if (!key || seen.has(key)) return;
  seen.add(key);
  attachments.push(attachment);
}

function imageSourcesFromText(text = '', args = {}, allowRelative = false) {
  const sources = [];
  const raw = String(text || '');
  const patterns = [
    /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif)(?:[?#][^\s"'<>]*)?/gi,
    /[A-Za-z]:\\[^\r\n"'<>|]+?\.(?:png|jpe?g|gif|webp|bmp|heic|heif)/gi,
  ];
  if (allowRelative) {
    patterns.push(/(?:^|[\s"'=])((?:\.\\|\.\/|\.\.\\|\.\.\/|[A-Za-z0-9_.-]+[\\/])?[A-Za-z0-9_.-]+[\\/][^\r\n"'<>|]+?\.(?:png|jpe?g|gif|webp|bmp|heic|heif)|[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif))/gi);
  }
  for (const pattern of patterns) {
    let match = pattern.exec(raw);
    while (match) {
      sources.push(match[1] || match[0]);
      match = pattern.exec(raw);
    }
  }
  return sources.map(source => normalizeImageSource(source, args)).filter(Boolean);
}

function imageAttachmentsFromTool(payload = {}, args = {}) {
  const rawName = String(payload.name || 'tool');
  const name = rawName.split('.').pop();
  const attachments = [];
  const seen = new Set();
  const candidateKeys = ['path', 'filePath', 'filename', 'file', 'url', 'dataUrl'];
  for (const key of candidateKeys) {
    const value = args[key];
    if (typeof value === 'string') addImageAttachment(attachments, seen, value, args);
    else if (Array.isArray(value)) value.forEach(item => addImageAttachment(attachments, seen, item, args));
  }
  if (Array.isArray(args.paths)) {
    args.paths.forEach(item => addImageAttachment(attachments, seen, item, args));
  }
  const commandText = String(args.command || args.cmd || args.raw || '');
  if (
    name === 'view_image' ||
    name.includes('screenshot') ||
    /snapshot_display|screencap|uitest|file\s+recv/i.test(commandText)
  ) {
    imageSourcesFromText(commandText, args, true).forEach(source => addImageAttachment(attachments, seen, source, args));
  }
  return attachments.slice(0, 4);
}

function formatToolCall(payload, options = {}) {
  const rawName = String(payload.name || 'tool');
  const name = rawName.split('.').pop();
  if (name === 'shell_command') {
    return CommandStepSummary('command', '已运行 1 条命令').text;
  }
  return formatToolCallSummary(payload, options).text;
}

function formatToolCallSummary(payload, options = {}) {
  const rawName = String(payload.name || 'tool');
  const name = rawName.split('.').pop();
  const args = parseToolArguments(payload);
  const imageAttachments = imageAttachmentsFromTool(payload, args);

  if (payload.type === 'web_search_call') {
    return CommandStepSummary('command', '已运行 1 次搜索');
  }

  if (name === 'exec_command' || name === 'shell_command') {
    const cmd = String(args.command || args.cmd || args.raw || '').trim();
    if (imageAttachments.length > 0) {
      return CommandStepSummary('image', `已接收 ${imageAttachments.length} 张图片`, imageAttachments.length, imageAttachments);
    }
    return CommandStepSummary('command', '已运行 1 条命令', cmd ? 1 : 1);
  }

  if (name === 'apply_patch') {
    const patch = typeof args.raw === 'string' ? args.raw : String(payload.arguments || '');
    const stats = patchStats(patch);
    const count = Math.max(1, stats.files.length || 1);
    return CommandStepSummary('file', `已修改 ${count} 个文件`, count);
  }

  if (name === 'write_stdin') return CommandStepSummary('command', '已运行 1 条命令');
  if (name === 'view_image' || name.includes('screenshot')) {
    return CommandStepSummary('image', `已接收 ${Math.max(1, imageAttachments.length)} 张图片`, Math.max(1, imageAttachments.length), imageAttachments);
  }
  if (name === 'read_mcp_resource') return CommandStepSummary('command', '已运行 1 条命令');
  if (name.includes('browser') || name.includes('chrome')) return CommandStepSummary('command', '已运行 1 条命令');
  return CommandStepSummary('command', '已运行 1 条命令');
}


function contextUsageFromItems(items) {
  let windowTokens = 0;
  let latestUsage = null;
  let updatedAt = '';

  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      const value = Number(payload.model_context_window || 0);
      if (Number.isFinite(value) && value > 0) windowTokens = value;
    }
    if (item.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info || {};
    const value = Number(info.model_context_window || 0);
    if (Number.isFinite(value) && value > 0) windowTokens = value;
    const usage = info.last_token_usage || info.current_token_usage || null;
    if (usage && typeof usage === 'object') {
      latestUsage = usage;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  if (!latestUsage || !windowTokens) {
    return {
      available: false,
      usedTokens: 0,
      windowTokens: windowTokens || 0,
      remainingTokens: windowTokens || 0,
      percent: null,
      updatedAt,
    };
  }

  const inputTokens = Number(latestUsage.input_tokens || 0) || 0;
  const outputTokens = Number(latestUsage.output_tokens || 0) || 0;
  const totalTokens = Number(latestUsage.total_tokens || 0) || 0;
  let usedTokens = totalTokens || (inputTokens + outputTokens) || inputTokens;
  if (usedTokens > windowTokens * 1.15 && inputTokens > 0 && inputTokens <= windowTokens * 1.15) {
    usedTokens = inputTokens + outputTokens;
  }
  usedTokens = Math.max(0, Math.round(usedTokens));
  const percent = Math.max(0, Math.min(100, (usedTokens / windowTokens) * 100));

  return {
    available: true,
    usedTokens,
    windowTokens,
    remainingTokens: Math.max(0, Math.round(windowTokens - usedTokens)),
    percent,
    updatedAt,
  };
}

function modelInfoFromId(modelId = '', updatedAt = '') {
  return modelOptionUtils.modelInfoFromId(modelId, availableModelOptionsForSwitch(), updatedAt);
}

function codexModelSupportsSpeed(model = {}) {
  return modelOptionUtils.modelSupportsSpeed(model, availableModelOptionsForSwitch());
}

function currentModelFromItems(items) {
  let modelId = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'session_meta' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || payload.timestamp || updatedAt;
    }
    if (item.type === 'turn_context' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return modelInfoFromId(modelId, updatedAt);
}

function reasoningModeFromValue(value = '', updatedAt = '') {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    low: 'low',
    '低': 'low',
    medium: 'medium',
    med: 'medium',
    middle: 'medium',
    '中': 'medium',
    high: 'high',
    '高': 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    'extra-high': 'xhigh',
    extreme: 'xhigh',
    max: 'xhigh',
    '超高': 'xhigh',
    '极高': 'xhigh',
  };
  const key = aliases[raw] || '';
  const target = key ? REASONING_MODE_TARGETS[key] : null;
  return {
    available: Boolean(target || raw),
    key: target?.key || '',
    value: target?.value || raw,
    label: target?.label || '',
    displayName: target?.displayName || value || '',
    updatedAt,
  };
}

function currentReasoningModeFromItems(items) {
  let value = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    const settings = payload.collaboration_mode && typeof payload.collaboration_mode === 'object'
      ? payload.collaboration_mode.settings || {}
      : {};
    const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
    const next = payload.reasoning_effort || payload.reasoningMode || payload.reasoning_mode || settings.reasoning_effort || reasoning.effort || '';
    if (item.type === 'turn_context' && next) {
      value = next;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return reasoningModeFromValue(value, updatedAt);
}

function speedModeFromValue(value = '', updatedAt = '') {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    default: 'standard',
    standard: 'standard',
    normal: 'standard',
    auto: 'standard',
    '标准': 'standard',
    '默认': 'standard',
    priority: 'fast',
    fast: 'fast',
    quick: 'fast',
    '快速': 'fast',
    '高速': 'fast',
    '高': 'fast',
    '1.5x': 'fast',
  };
  const key = aliases[raw] || '';
  const target = key ? SPEED_MODE_TARGETS[key] : null;
  return {
    available: Boolean(target || raw),
    key: target?.key || '',
    value: target?.value || raw,
    serviceTier: target?.serviceTier || raw,
    label: target?.label || '',
    displayName: target?.displayName || value || '',
    updatedAt,
  };
}

function currentSpeedModeFromItems(items) {
  let value = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    const settings = payload.collaboration_mode && typeof payload.collaboration_mode === 'object'
      ? payload.collaboration_mode.settings || {}
      : {};
    const next = payload.service_tier || payload.serviceTier || payload.speedMode || payload.speed_mode || settings.service_tier || settings.serviceTier || '';
    if ((item.type === 'turn_context' || item.type === 'session_meta') && next) {
      value = next;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return speedModeFromValue(value, updatedAt);
}

function compactProcessText(steps) {
  const thinking = [];
  let commandCount = 0;
  let fileCount = 0;
  let imageCount = 0;
  const errors = [];

  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const text = String(step.text || '').trim();
    if (step.kind === 'thinking' && text) {
      thinking.push(text);
      continue;
    }
    if (step.kind === 'error' && text) {
      errors.push(text);
      continue;
    }
    if (step.kind !== 'tool') continue;
    const count = Math.max(1, Number(step.summaryCount) || 1);
    if (step.summaryKind === 'file') fileCount += count;
    else if (step.summaryKind === 'image') imageCount += count;
    else commandCount += count;
  }

  const rows = [];
  if (thinking.length) rows.push(thinking.join('\n\n'));
  if (commandCount > 0) rows.push(`已运行 ${commandCount} 条命令`);
  if (fileCount > 0) rows.push(`已修改 ${fileCount} 个文件`);
  if (imageCount > 0) rows.push(`已接收 ${imageCount} 张图片`);
  if (errors.length) rows.push(errors.join('\n\n'));
  return rows.join('\n\n');
}

function processSummaryFromSteps(status, steps) {
  let commandCount = 0;
  let fileCount = 0;
  let imageCount = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object' || step.kind !== 'tool') continue;
    const count = Math.max(1, Number(step.summaryCount) || 1);
    if (step.summaryKind === 'file') fileCount += count;
    else if (step.summaryKind === 'image') imageCount += count;
    else commandCount += count;
  }
  const prefix = status === 'error' ? '执行失败' : status === 'complete' ? '已完成' : '正在执行';
  const rows = [];
  rows.push(commandCount > 0 ? `已运行 ${commandCount} 条命令` : '正在同步终端过程');
  if (fileCount > 0) rows.push(`修改 ${fileCount} 个文件`);
  if (imageCount > 0) rows.push(`接收 ${imageCount} 张图片`);
  return `${prefix} · ${rows.join(' · ')}`;
}

function hasUsefulProcessSteps(steps) {
  return (Array.isArray(steps) ? steps : []).some(step => {
    if (!step || typeof step !== 'object') return false;
    return step.kind === 'thinking' || step.kind === 'tool' || step.kind === 'error';
  });
}

function isProcessEchoMessage(text = '', steps = []) {
  const target = normalizeComparableMessage(text);
  if (!target) return false;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object') continue;
    const kind = String(step.kind || '');
    if (!['start', 'thinking', 'tool', 'complete', 'error'].includes(kind)) continue;
    const stepText = normalizeComparableMessage(step.text || step.status || '');
    if (!stepText) continue;
    if (target === stepText || target.startsWith(stepText) || stepText.startsWith(target)) return true;
  }
  return false;
}

function stepFromEvent(item) {
  const payload = item.payload || {};
  if (item.type === 'event_msg') {
    const failureText = extractFailureTextFromPayload(payload);
    if (failureText) return { kind: 'error', label: '失败', text: failureText, time: item.timestamp };
    if (payload.type === 'task_started') return { kind: 'start', label: '开始', text: '开始处理这条消息', time: item.timestamp };
    if (payload.type === 'task_complete') return { kind: 'complete', label: '完成', text: '回复完成', time: item.timestamp };
    if (payload.type === 'agent_message' && payload.message) {
      const text = payload.phase === 'final_answer'
        ? truncateDisplayTextPreservingLines(String(payload.message), 1200)
        : truncateText(String(payload.message).trim(), 1200);
      if (payload.phase === 'final_answer') return { kind: 'final', label: '回复', text, time: item.timestamp };
      if (payload.phase === 'commentary') return { kind: 'thinking', label: '思考', text, time: item.timestamp };
      return { kind: 'assistant', label: '回复', text, time: item.timestamp };
    }
    return null;
  }

  if (item.type === 'response_item') {
    if (payload.type === 'reasoning') {
      const text = extractReasoningText(payload);
      return text ? { kind: 'thinking', label: '思考', text, time: item.timestamp } : null;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'web_search_call') {
      const toolName = payload.name || 'tool';
      const summary = formatToolCallSummary(payload);
      return { kind: 'tool', label: '工具', text: summary.text, summaryKind: summary.kind, summaryCount: summary.count, attachments: summary.attachments, callId: payload.call_id || '', time: item.timestamp };
    }
    if (payload.type === 'message') {
      const text = extractMessageText(payload.content);
      if (text && payload.role === 'assistant' && payload.phase === 'commentary') return { kind: 'thinking', label: '思考', text: truncateText(text, 1200), time: item.timestamp };
      if (text && payload.role === 'assistant') {
        const displayText = payload.phase === 'final_answer'
          ? truncateDisplayTextPreservingLines(text, 1200)
          : truncateText(text, 1200);
        return { kind: payload.phase === 'final_answer' ? 'final' : 'assistant', label: '回复', text: displayText, time: item.timestamp };
      }
    }
  }
  return null;
}

function parseCodexStatus(options = {}) {
  const sinceMs = options.since ? Date.parse(options.since) : 0;
  const wantsExactSession = Boolean(options.threadId || options.sessionFile);
  const requestedFile = options.threadId ? findCodexSessionFileByThreadId(options.threadId) : options.sessionFile ? findCodexSessionFileByName(options.sessionFile) : null;
  const file = requestedFile || (wantsExactSession ? null : findLatestCodexSessionFile({
    afterMs: options.expectNewThread ? sinceMs : 0,
    excludeThreadId: options.excludeThreadId || '',
    cwd: options.cwd || '',
  }));
  if (!file) {
    return {
      ok: true,
      available: false,
      active: Boolean(options.expectNewThread && sinceMs),
      status: wantsExactSession ? 'missing' : options.expectNewThread && sinceMs ? 'waiting' : 'idle',
      threadId: options.threadId || '',
      sessionFile: options.sessionFile || '',
      message: wantsExactSession ? '没有找到所选线程的 Codex 会话文件。' : '还没有找到 Codex 会话文件。',
      steps: [],
      preview: options.expectNewThread && sinceMs ? '已发送，等待 Codex 创建新线程记录…' : '还没有找到这个线程的回复记录。',
      final: '',
      durationMs: 0,
    };
  }

  const rawItems = [];
  for (const line of readStatusLinesAdaptive(file, { sinceMs })) {
    try { rawItems.push(JSON.parse(line)); } catch { /* ignore partial/corrupt lines */ }
  }

  let startIndex = -1;
  if (sinceMs) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const t = Date.parse(rawItems[i].timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs) {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex < 0) {
    for (let i = rawItems.length - 1; i >= 0; i -= 1) {
      if (rawItems[i].type === 'event_msg' && rawItems[i].payload && rawItems[i].payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) startIndex = Math.max(0, rawItems.length - 80);

  // If watching a specific send, begin at the first task_started after that send when possible.
  if (sinceMs) {
    for (let i = startIndex; i < rawItems.length; i += 1) {
      const item = rawItems[i];
      const t = Date.parse(item.timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs && item.type === 'event_msg' && item.payload && item.payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }

  const turnItems = rawItems.slice(startIndex).filter(item => {
    if (!sinceMs) return true;
    const t = Date.parse(item.timestamp || '');
    return !Number.isFinite(t) || t >= sinceMs;
  });

  let active = Boolean(sinceMs);
  let completed = false;
  let turnId = null;
  let final = '';
  let preview = '';
  let startedAt = '';
  let completedAt = '';
  let sawTaskStarted = false;
  let failureText = '';
  let emptyComplete = false;
  const steps = [];
  const seenThinking = new Set();
  const toolCallsById = new Map();
  const toolStepIndexById = new Map();

  for (const item of turnItems) {
    const payload = item.payload || {};
    failureText = failureText || extractFailureTextFromPayload(payload);
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      active = true;
      sawTaskStarted = true;
      turnId = payload.turn_id || turnId;
      startedAt = startedAt || item.timestamp || '';
    }
    if (item.type === 'turn_context') turnId = payload.turn_id || turnId;
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      if (lastMessage && !isProcessEchoMessage(lastMessage, steps)) {
        final = lastMessage || final;
      }
      if (!lastMessage && !final && !preview && sawTaskStarted) emptyComplete = true;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
    }

    if (item.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id && toolStepIndexById.has(payload.call_id)) {
      const callPayload = toolCallsById.get(payload.call_id);
      if (callPayload && String(callPayload.name || '').split('.').pop() === 'apply_patch') {
        const stepIndex = toolStepIndexById.get(payload.call_id);
        if (steps[stepIndex]) {
          const summary = formatToolCallSummary(callPayload, { complete: true });
          steps[stepIndex].text = summary.text;
          steps[stepIndex].summaryKind = summary.kind;
          steps[stepIndex].summaryCount = summary.count;
        }
      }
    }

    const step = stepFromEvent(item);
    if (!step) continue;
    if (step.kind === 'thinking') {
      const key = step.text || 'thinking';
      if (seenThinking.has(key)) continue;
      seenThinking.add(key);
    }
    if ((step.kind === 'assistant' || step.kind === 'final') && step.text) preview = step.text;
    if (step.kind === 'final' && step.text) final = step.text;
    if (['start', 'thinking', 'tool', 'complete', 'error'].includes(step.kind)) {
      if (step.kind === 'tool' && step.callId) {
        toolCallsById.set(step.callId, payload);
        toolStepIndexById.set(step.callId, steps.length);
      }
      steps.push(step);
    }
  }

  const context = contextUsageFromItems(rawItems);
  const configText = readCodexConfigText();
  const parsedModel = currentModelFromItems(rawItems);
  const parsedReasoningMode = currentReasoningModeFromItems(rawItems);
  const parsedSpeedMode = currentSpeedModeFromItems(rawItems);
  const configModel = modelInfoFromId(tomlStringValue(configText, 'model'));
  const configReasoningMode = reasoningModeFromValue(tomlStringValue(configText, 'model_reasoning_effort'));
  const configSpeedMode = speedModeFromValue(tomlStringValue(configText, 'service_tier'));
  const controlOverrides = readAppState().controlOverrides || {};
  const liveModeState = options.liveModeState || null;
  const liveModeOptions = options.liveModeOptions || null;
  const liveModel = liveModeState && liveModeState.model && liveModeState.model.available ? liveModeState.model : null;
  const liveReasoningMode = liveModeState && liveModeState.reasoningMode && liveModeState.reasoningMode.available ? liveModeState.reasoningMode : null;
  const liveSpeedMode = liveModeState && liveModeState.speedMode && liveModeState.speedMode.available ? liveModeState.speedMode : null;
  const overrideModel = controlOverrideModel(controlOverrides, parsedModel);
  const overrideReasoningMode = controlOverrideReasoning(controlOverrides, parsedReasoningMode);
  const overrideSpeedMode = controlOverrideSpeed(controlOverrides, parsedSpeedMode);
  const model = [
    liveModel,
    overrideModel,
    configModel,
    parsedModel && parsedModel.available ? parsedModel : null,
  ].find(Boolean);
  const reasoningMode = [
    liveReasoningMode,
    overrideReasoningMode,
    configReasoningMode,
    parsedReasoningMode && parsedReasoningMode.available ? parsedReasoningMode : null,
  ].find(Boolean);
  const speedMode = [
    liveSpeedMode,
    overrideSpeedMode,
    configSpeedMode,
    parsedSpeedMode && parsedSpeedMode.available ? parsedSpeedMode : null,
  ].find(Boolean);
  const speedSupported = codexModelSupportsSpeed(model);
  const modelOptions = modelOptionsForClient(liveModeOptions);
  const reasoningOptions = liveModeOptions && Array.isArray(liveModeOptions.reasoningOptions) && liveModeOptions.reasoningOptions.length
    ? liveModeOptions.reasoningOptions
    : Object.values(REASONING_MODE_TARGETS);
  const speedOptions = resolveLiveSpeedOptions(speedSupported, speedMode, liveModeOptions);
  const threadId = threadIdFromSessionFile(file);
  const failed = completed && !final && (emptyComplete || Boolean(failureText));
  const finalFailureText = failed
    ? (resolveFailureTextForTurn(threadId, { turnId, startedAt, completedAt, failureText }) || emptyCodexFailureText())
    : '';
  const statusSteps = steps;
  if (failed && finalFailureText && !statusSteps.some(step => step.kind === 'error' && step.text === finalFailureText)) {
    statusSteps.push({ kind: 'error', label: '失败', text: finalFailureText, time: completedAt || new Date(fs.statSync(file).mtimeMs).toISOString() });
  }
  const lastStep = statusSteps[statusSteps.length - 1] || steps[steps.length - 1];
  const status = failed ? 'error' : completed ? 'complete' : active ? 'running' : 'idle';
  const waiting = sinceMs && !steps.length;
  const startMs = Date.parse(startedAt || '') || sinceMs || 0;
  const endMs = completedAt ? Date.parse(completedAt) : Date.now();
  const durationMs = startMs ? Math.max(0, endMs - startMs) : 0;
  return {
    ok: true,
    available: true,
    active: waiting ? true : active,
    status: waiting ? 'waiting' : status,
    turnId,
    sessionFile: path.basename(file),
    threadId,
    updatedAt: lastStep ? lastStep.time : new Date(fs.statSync(file).mtimeMs).toISOString(),
    startedAt,
    completedAt,
    durationMs,
    context,
    model,
    currentModel: model,
    modelOptions,
    reasoningMode,
    currentReasoning: reasoningMode,
    reasoningOptions,
    speedMode,
    currentSpeed: speedMode,
    speedSupported,
    speedOptions,
    processText: compactProcessText(statusSteps),
    preview: final || preview || finalFailureText || (waiting ? '已发送，等待 Codex 开始回复…' : active ? 'Codex 正在回复…' : '暂无可显示回复。'),
    final: final || '',
    error: finalFailureText,
    steps: statusSteps,
  };
}

async function handleCodexStatus(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const liveModeState = await readLiveCodexComposerModeState();
    const liveModeOptions = cachedLiveModeOptions();
    const status = attachForegroundNotice(enrichStatusAttachments(parseCodexStatus({
      since: url.searchParams.get('since') || '',
      sessionFile: url.searchParams.get('session') || '',
      threadId: url.searchParams.get('thread') || '',
      expectNewThread: url.searchParams.get('expectNewThread') === '1',
      excludeThreadId: url.searchParams.get('excludeThread') || '',
      cwd: url.searchParams.get('cwd') || '',
      liveModeState,
      liveModeOptions,
    }), req));
    return json(res, 200, status);
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_STATUS_FAILED', message: '读取 Codex 回复状态失败。', detail: String(error && error.message || error) });
  }
}

async function handleSelectThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    invalidateCodexThreadListCache();
    await activateCodexThread(threadId);
    return json(res, 200, { ok: true, threadId, message: '已切换到所选 Codex 线程。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}


function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-mobile-typer-token',
    'access-control-allow-private-network': 'true',
  };
}

function options(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('输入太长了，请分段发送。'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const fromHeader = req.headers['x-mobile-typer-token'];
  const fromQuery = url.searchParams.get('token');
  const fromCookie = parseCookies(req.headers.cookie || '').codex2frpToken;
  return fromHeader === TOKEN || fromQuery === TOKEN || fromCookie === TOKEN;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function cleanupRecentSendRequests() {
  const cutoff = Date.now() - RECENT_SEND_TTL_MS;
  for (const [id, entry] of recentSendRequests) {
    if (!entry || entry.createdAt < cutoff) recentSendRequests.delete(id);
  }
}

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(id) ? id : '';
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { code, stdout, stderr }));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function powershellExe() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

function psSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function runPowerShell(script, input = '') {
  return runProcess(powershellExe(), ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], input);
}

async function restoreCodexDesktopWindow(options = {}) {
  if (process.platform !== 'win32') return false;
  const settleMs = Number(options.settleMs ?? CODEX_WINDOW_RESTORE_SETTLE_MS);
  const script = `
$definition = @"
using System;
using System.Runtime.InteropServices;
public static class Codex2FrpWindowOps {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
Add-Type -TypeDefinition $definition -ErrorAction SilentlyContinue | Out-Null
$windows = Get-Process Codex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
$count = 0
foreach ($process in $windows) {
  [Codex2FrpWindowOps]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
  [Codex2FrpWindowOps]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  $count += 1
}
Write-Output $count
`;
  try {
    const { stdout } = await runPowerShell(script);
    if (settleMs > 0) await delay(settleMs);
    return Number(String(stdout || '').trim()) > 0;
  } catch {
    return false;
  }
}

async function openWindowsUri(uri) {
  await runPowerShell(`Start-Process -FilePath ${psSingleQuote(uri)}`);
}

async function sendWindowsKeys(keys) {
  await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psSingleQuote(keys)})`);
}

function windowsShortcutExpression(key, modifiers = []) {
  const normalized = new Set(modifiers.map(item => String(item || '').toLowerCase() === 'command' ? 'control' : String(item || '').toLowerCase()));
  let prefix = '';
  if (normalized.has('control') || normalized.has('ctrl')) prefix += '^';
  if (normalized.has('alt') || normalized.has('option')) prefix += '%';
  if (normalized.has('shift')) prefix += '+';
  return prefix + String(key || '');
}

function explainAutomationError(error) {
  const raw = String(error && (error.stderr || error.message) || '');
  const lower = raw.toLowerCase();
  if (lower.includes('clipboard') || lower.includes('sendkeys') || lower.includes('access is denied') || lower.includes('拒绝访问')) {
    return {
      code: 'WINDOWS_AUTOMATION_PERMISSION_REQUIRED',
      message: 'Windows 自动粘贴失败。请确认 Codex2Frp 仍在运行，前台桌面未被锁定，并允许本机 PowerShell 调用剪贴板和按键。',
      detail: raw,
    };
  }
  return {
    code: 'WINDOWS_AUTOMATION_FAILED',
    message: 'Windows 自动粘贴失败。请确认 Codex 正在运行，桌面未锁屏，且当前有可输入的窗口。',
    detail: raw,
  };
}

function explainTargetError(error, target) {
  const raw = String(error && (error.stderr || error.message) || '');
  if (target === 'codex') {
    return {
      code: 'CODEX_FOCUS_FAILED',
      message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex 正在运行，且当前终端已开启辅助功能权限。',
      detail: raw,
    };
  }
  return explainAutomationError(error);
}

async function copyTextToClipboard(text) {
  const filePath = path.join(os.tmpdir(), `codex2frp-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(filePath, String(text || ''), 'utf8');
  try {
    await runPowerShell(`$value = Get-Content -LiteralPath ${psSingleQuote(filePath)} -Raw -Encoding UTF8; Set-Clipboard -Value $value`);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutFallback(ms, value = null) {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

function cdpHostForUrl(value) {
  const raw = String(value || '').trim() || '127.0.0.1';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw;
  return raw.includes(':') ? `[${raw}]` : raw;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function codexCdpPortCandidates() {
  const ports = [codexCdpPort, CODEX_CDP_PREFERRED_PORT];
  for (let offset = 1; offset < CODEX_CDP_PORT_SCAN_COUNT; offset += 1) {
    ports.push(CODEX_CDP_PREFERRED_PORT + offset);
  }
  return [...new Set(ports.filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
}

function canBindCdpPort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, CODEX_CDP_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findRunningCodexCdpPorts() {
  if (process.platform !== 'win32') return [];
  const script = String.raw`
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" |
  ForEach-Object {
    $exe = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    if (-not $cmd) { return }
    if ($cmd -match '\s--type=') { return }
    if ($exe -and (($exe -replace '/', '\') -notmatch '\\app\\Codex\.exe$')) { return }
    if ($cmd -match '--remote-debugging-port=(\d+)') {
      [PSCustomObject]@{ port = [int]$Matches[1]; processId = [int]$_.ProcessId }
    }
  } |
  Sort-Object port -Unique |
  ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await runPowerShell(script);
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return [...new Set(rows
      .map(row => Number(row && row.port))
      .filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
  } catch {
    return [];
  }
}

async function probeCodexCdpTarget(timeoutMs = 1200) {
  const hosts = [CODEX_CDP_HOST, '127.0.0.1', '[::1]', 'localhost']
    .map(cdpHostForUrl)
    .filter((item, index, list) => item && list.indexOf(item) === index);
  let lastError = null;
  for (const port of codexCdpPortCandidates()) {
    for (const host of hosts) {
      try {
        const targets = await fetchJsonWithTimeout(`http://${host}:${port}/json/list`, timeoutMs);
        const pages = Array.isArray(targets) ? targets : [];
        const target = pages.find(item => item.type === 'page' && item.url === 'app://-/index.html' && item.webSocketDebuggerUrl)
          || pages.find(item => item.type === 'page' && String(item.url || '').startsWith('app://-/index.html') && !String(item.url || '').includes('initialRoute=') && item.webSocketDebuggerUrl)
          || pages.find(item => item.type === 'page' && String(item.url || '').startsWith('app://-/index.html') && item.webSocketDebuggerUrl)
          || pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) {
          codexCdpPort = port;
          return target;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error('Codex CDP target not found.');
}

function codexCdpLauncherScriptPath() {
  return path.join(__dirname, 'scripts', 'launch-main-codex-cdp.ps1');
}

function codexCdpUserDataDir(launchPort) {
  return path.join(__dirname, '.runtime', `codex-cdp-profile-${launchPort}`);
}

function shouldAutoOpenCodexCdp(options = {}) {
  return options.autoOpen === true && CODEX_CDP_AUTO_OPEN && process.platform === 'win32';
}

async function runCodexCdpLauncher(options = {}) {
  const scriptPath = codexCdpLauncherScriptPath();
  if (!fs.existsSync(scriptPath)) {
    const error = new Error('Codex CDP launcher script was not found.');
    error.status = 502;
    error.code = 'CODEX_CDP_LAUNCHER_MISSING';
    error.detail = scriptPath;
    throw error;
  }

  const forceRestart = options.forceRestart === true;
  const runningPorts = await findRunningCodexCdpPorts();
  if (runningPorts.length > 0) {
    for (const runningPort of runningPorts) {
      codexCdpPort = runningPort;
      try {
        await probeCodexCdpTarget(options.verifyTimeoutMs || 2500);
        if (forceRestart) break;
        const readyPort = codexCdpPort;
        codexCdpLastLaunch = {
          ok: true,
          at: Date.now(),
          detail: `Reused existing Codex CDP process on port ${readyPort}.`,
          port: readyPort,
        };
        return { ok: true, code: 0, detail: codexCdpLastLaunch.detail, port: readyPort, reused: true, launched: false };
      } catch {}
    }
    if (!forceRestart) {
      const error = new Error(`Codex CDP is already running on port(s) ${runningPorts.join(', ')}, but the control target is not ready. Refusing to open another Codex client.`);
      error.status = 502;
      error.code = 'CODEX_CDP_EXISTING_UNREADY';
      error.detail = `runningPorts=${runningPorts.join(',')}`;
      throw error;
    }
  }

  let lastError = null;
  for (const launchPort of codexCdpPortCandidates()) {
    if (!forceRestart && !(await canBindCdpPort(launchPort))) continue;
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-OpenAfterPrepare',
      '-CdpPort',
      String(launchPort),
      '-CdpAddress',
      CODEX_CDP_HOST,
      '-ReadyTimeoutSeconds',
      String(CODEX_CDP_READY_TIMEOUT_SECONDS),
    ];
    if (forceRestart) args.push('-ForceRestart');

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(powershellExe(), args, {
          cwd: __dirname,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {}
          const error = new Error('Timed out while opening Codex control port.');
          error.status = 502;
          error.code = 'CODEX_CDP_LAUNCH_TIMEOUT';
          error.detail = [stdout, stderr].filter(Boolean).join('\n').slice(-4000);
          reject(error);
        }, CODEX_CDP_LAUNCH_TIMEOUT_MS);

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', error => {
          clearTimeout(timer);
          error.status = error.status || 502;
          error.code = error.code || 'CODEX_CDP_LAUNCH_FAILED';
          error.detail = [stdout, stderr].filter(Boolean).join('\n').slice(-4000);
          reject(error);
        });
        child.on('close', code => {
          clearTimeout(timer);
          const detail = [stdout, stderr].filter(Boolean).join('\n').slice(-4000);
          if (code === 0) {
            resolve({ ok: true, code, detail });
          } else {
            const error = new Error(stderr.trim() || stdout.trim() || `Codex CDP launcher exited with code ${code}`);
            error.status = 502;
            error.code = 'CODEX_CDP_LAUNCH_FAILED';
            error.detail = detail;
            reject(error);
          }
        });
      });
      codexCdpPort = launchPort;
      codexCdpLastLaunch = { ok: true, at: Date.now(), detail: result.detail, port: launchPort };
      return { ...result, port: launchPort };
    } catch (error) {
      lastError = error;
      codexCdpLastLaunch = { ok: false, at: Date.now(), detail: error.detail || error.message || String(error), port: launchPort };
    }
  }

  throw lastError || Object.assign(new Error('No usable Codex CDP port was available.'), {
    status: 502,
    code: 'CODEX_CDP_PORT_UNAVAILABLE',
  });
}

async function ensureCodexCdpReady(options = {}) {
  try {
    const target = await probeCodexCdpTarget(options.probeTimeoutMs || 1200);
    return {
      ok: true,
      ready: true,
      launched: false,
      target,
      port: codexCdpPort,
      host: CODEX_CDP_HOST,
      lastLaunch: codexCdpLastLaunch,
    };
  } catch (initialError) {
    if (options.autoOpen !== true || !shouldAutoOpenCodexCdp(options)) {
      initialError.status = initialError.status || 502;
      initialError.code = initialError.code || 'CODEX_CDP_REQUIRED';
      throw initialError;
    }
  }

  if (!codexCdpLaunchPromise) {
    codexCdpLaunchPromise = runCodexCdpLauncher(options)
      .finally(() => { codexCdpLaunchPromise = null; });
  }
  const launch = await codexCdpLaunchPromise;
  const target = await probeCodexCdpTarget(options.verifyTimeoutMs || 2500);
  return {
    ok: true,
    ready: true,
    launched: launch.launched !== false,
    launch,
    target,
    port: codexCdpPort,
    host: CODEX_CDP_HOST,
    lastLaunch: codexCdpLastLaunch,
  };
}

async function findCodexCdpTarget(options = {}) {
  try {
    return await probeCodexCdpTarget(options.probeTimeoutMs || 1200);
  } catch (error) {
    if (options.autoOpen !== true) throw error;
    const ready = await ensureCodexCdpReady(options);
    return ready.target;
  }
}

function connectCdpWebSocket(wsUrl, timeoutMs = CODEX_CDP_SEND_TIMEOUT_MS) {
  if (typeof WebSocket !== 'function') {
    throw new Error('This Node runtime does not provide WebSocket for Codex CDP.');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Codex CDP connection timed out.'));
    }, timeoutMs);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        call(method, params = {}) {
          return new Promise((callResolve, callReject) => {
            const id = ++nextId;
            const callTimer = setTimeout(() => {
              pending.delete(id);
              callReject(new Error(`${method} timed out.`));
            }, timeoutMs);
            pending.set(id, {
              resolve: value => {
                clearTimeout(callTimer);
                callResolve(value);
              },
              reject: error => {
                clearTimeout(callTimer);
                callReject(error);
              },
            });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              clearTimeout(callTimer);
              pending.delete(id);
              callReject(error);
            }
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    };
    ws.onerror = error => {
      clearTimeout(timer);
      reject(error);
    };
    ws.onclose = () => {
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(new Error('Codex CDP connection closed.'));
      }
    };
    ws.onmessage = event => {
      let message = null;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || !message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  });
}

async function cdpEvaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Codex CDP evaluation failed.');
  }
  return result.result && result.result.value;
}

async function focusCodexComposerInCdpClient(client) {
  await client.call('Runtime.enable').catch(() => {});
  await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
  const focused = await cdpEvaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editors = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const editor = editors[0];
    if (!editor) return { ok: false, reason: 'editor not found' };
    editor.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = editor.getBoundingClientRect();
    const clientX = rect.left + Math.min(rect.width - 8, Math.max(8, rect.width / 2));
    const clientY = rect.top + Math.min(rect.height - 8, Math.max(8, rect.height / 2));
    editor.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
    editor.focus();
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
    const active = document.activeElement;
    const ok = active === editor || editor.contains(active) || editor.matches(':focus');
    return ok ? { ok: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : { ok: false, reason: 'editor focus was not accepted' };
  })()`);
  if (!focused || focused.ok !== true) {
    throw new Error(focused && focused.reason || 'Codex editor not focused.');
  }
  return focused;
}

async function clickCodexSendButtonInCdpClient(client) {
  const clicked = await cdpEvaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    const root = editor && (editor.closest('form') || editor.closest('[class*="composer"]') || editor.closest('.relative'));
    const candidates = root ? [...root.querySelectorAll('button,[role="button"]')].filter(visible) : [];
    const blocked = /停止|取消|听写|添加|选择|附件|Stop|Cancel|Dictate|Attach|Add/i;
    const preferred = candidates.find(button => {
      const text = [button.textContent || '', button.getAttribute('aria-label') || '', button.getAttribute('title') || ''].join(' ');
      return /发送|提交|Send|Submit/i.test(text) && !blocked.test(text) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    });
    const fallback = candidates
      .filter(button => {
        const text = [button.textContent || '', button.getAttribute('aria-label') || '', button.getAttribute('title') || ''].join(' ');
        const rect = button.getBoundingClientRect();
        return rect.width <= 60 && rect.height <= 60 && !blocked.test(text) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    const sendButton = preferred || fallback;
    if (!sendButton) {
      return {
        ok: false,
        reason: 'send button not found',
        buttons: candidates.map(button => ({
          text: (button.textContent || '').replace(/\\s+/g, ' ').trim(),
          aria: button.getAttribute('aria-label') || '',
          disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true'),
        })).slice(-12),
      };
    }
    const rect = sendButton.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    sendButton.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
    sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
    return { ok: true };
  })()`);
  if (!clicked || clicked.ok !== true) {
    const detail = clicked && clicked.buttons ? ` ${JSON.stringify(clicked.buttons)}` : '';
    throw new Error((clicked && clicked.reason || 'Codex send button not found.') + detail);
  }
  return clicked;
}

async function focusCodexComposerViaCdp() {
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    return await focusCodexComposerInCdpClient(client);
  } finally {
    client.close();
  }
}

async function sendTextViaCodexCdp(text) {
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await focusCodexComposerInCdpClient(client);
    await client.call('Input.insertText', { text: String(text || '') });
    await delay(120);
    await clickCodexSendButtonInCdpClient(client);
    return { ok: true, method: 'cdp' };
  } finally {
    client.close();
  }
}

async function clearCodexComposerViaCdpClient(client) {
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Control',
    code: 'ControlLeft',
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).catch(() => {});
  await delay(80);
}

function mobileComposerCommandForText(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  if (['/压缩', '/compact', '/compress', '/summarize', '/summary'].includes(normalized)) {
    return { action: 'compact', target: '' };
  }
  return null;
}

function textMatchesAnyLabel(text = '', labels = []) {
  const haystack = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return labels.some(label => {
    const needle = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return needle && haystack.includes(needle);
  });
}

function itemTextForCompare(text = '') {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

function isCodexStopControlText(text = '') {
  const compact = itemTextForCompare(text);
  return compact === '\u505c\u6b62' || compact === 'stop' ||
    compact.includes('\u505c\u6b62') ||
    compact.includes('\u7ec8\u6b62') ||
    compact.includes('\u53d6\u6d88') ||
    compact.includes('stop') ||
    compact.includes('interrupt') ||
    compact.includes('cancel');
}

function codexRunningStopControls(snapshot = {}) {
  const viewportHeight = Number(snapshot.innerHeight || 0);
  return (snapshot.items || []).filter(item => {
    if (!item || item.disabled || !isCodexStopControlText(item.text)) return false;
    const rect = item.rect || {};
    const y = Number(rect.y || 0);
    const h = Number(rect.h || rect.height || 0);
    const w = Number(rect.w || rect.width || 0);
    if (y < 0 || h < 18 || w < 18) return false;
    if (viewportHeight && y < viewportHeight * 0.55) return false;
    return true;
  });
}

function hasCodexRunningStopControl(snapshot = {}) {
  return codexRunningStopControls(snapshot).length > 0;
}

function findCodexSlashCommandMenuItem(snapshot = {}, labels = []) {
  const targetLabels = uniqueTextList(labels);
  return codexModeMenuItems(snapshot)
    .filter(item => textMatchesAnyLabel(item.text, targetLabels))
    .sort((a, b) => {
      const aText = itemTextForCompare(a.text);
      const bText = itemTextForCompare(b.text);
      const aExact = targetLabels.some(label => aText === itemTextForCompare(label)) ? 1 : 0;
      const bExact = targetLabels.some(label => bText === itemTextForCompare(label)) ? 1 : 0;
      return bExact - aExact || Number(a.rect && a.rect.y || 0) - Number(b.rect && b.rect.y || 0);
    })[0];
}

function codexComposerTextForCompare(text = '') {
  return String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, '').trim();
}

function isDisposableSlashComposerText(text = '') {
  const compact = codexComposerTextForCompare(text).toLowerCase();
  return compact === '' || compact === '/';
}

async function readCodexComposerTextInCdpClient(client) {
  return await cdpEvaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.y <= innerHeight &&
        rect.right >= 0 && rect.x <= innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (!editor) return { ok: false, text: '', reason: 'editor not found' };
    const text = editor.matches('textarea,input') ? editor.value || '' : editor.textContent || '';
    return { ok: true, text: text.replace(/\\s+/g, ' ').trim() };
  })()`);
}

function composerReferenceKindForSection(section = '') {
  if (section === '插件') return 'plugin';
  if (section === 'Add') return 'mode';
  return 'reference';
}

function composerSelectionFromLabel(label = '', source = {}) {
  const text = String(label || source.label || source.text || source.target || '').replace(/\s+/g, ' ').trim();
  const row = findKnownCodexPlusMenuRow(text) || findKnownCodexPlusMenuRow(source.text || '') || { label: text, section: source.section || '插件' };
  const target = String(source.target || row.label || text).replace(/\s+/g, ' ').trim();
  const section = row.section || source.section || '';
  const kind = source.kind || composerReferenceKindForSection(section);
  const safeId = (target || row.label || text || 'reference')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'reference';
  return {
    id: `codex-composer-${safeId}`,
    kind,
    section,
    label: row.label || text,
    target: target || row.label || text,
    text: source.text || text,
    removable: true,
    source: 'codex-cdp-composer',
  };
}

function shouldVerifyCodexPlusMenuInsertion(labels = []) {
  const text = uniqueTextList(labels).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  return !/files and folders|file and folder|文件|文件夹|folder/.test(text);
}

function normalizeComposerSelectionHint(selection = {}, fallbackTarget = '') {
  const target = String(selection && (selection.target || selection.label || selection.text || selection.id) || fallbackTarget || '')
    .replace(/\s+/g, ' ')
    .trim();
  const label = String(selection && (selection.label || selection.target || selection.text) || target || '')
    .replace(/\s+/g, ' ')
    .trim();
  const section = String(selection && selection.section || '').trim();
  const kind = String(selection && selection.kind || '').trim();
  const row = findKnownCodexPlusMenuRow(target) || findKnownCodexPlusMenuRow(label) || null;
  return {
    id: String(selection && selection.id || '').trim(),
    kind: kind || composerReferenceKindForSection(section || row && row.section || ''),
    section: section || row && row.section || '',
    label: label || target,
    target,
    text: String(selection && selection.text || label || target).replace(/\s+/g, ' ').trim(),
    source: String(selection && selection.source || '').trim(),
  };
}

function isPluginComposerSelection(selection = {}, labels = []) {
  const hint = normalizeComposerSelectionHint(selection, uniqueTextList(labels)[0] || '');
  const section = String(hint.section || '').trim();
  const kind = String(hint.kind || '').trim().toLowerCase();
  const row = findKnownCodexPlusMenuRow(hint.target) || findKnownCodexPlusMenuRow(hint.label) || null;
  return kind === 'plugin' || section === '插件' || Boolean(row && row.section === '插件');
}

async function readCodexComposerReferenceStateInCdpClient(client, labels = []) {
  const targetLabels = uniqueTextList(labels);
  return await cdpEvaluate(client, `(() => {
    const labels = ${JSON.stringify(targetLabels)};
    const compact = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const labelKeys = labels.map(compact).filter(Boolean);
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => !el ? '' : [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      };
    };
    const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
    const root = editor && (editor.closest('form') || editor.closest('[class*="composer"]') || editor.closest('.relative'));
    const editorRect = editor ? rectOf(editor) : null;
    const matchesLabel = text => {
      const key = compact(text);
      return key && labelKeys.some(label => key.includes(label) || label.includes(key));
    };
    const nearEditor = rect => {
      if (!editorRect) return true;
      const top = editorRect.y - 96;
      const bottom = editorRect.bottom + 96;
      const left = editorRect.x - 160;
      const right = editorRect.right + 160;
      return rect.bottom >= top && rect.y <= bottom && rect.right >= left && rect.x <= right;
    };
    const references = root
      ? [...root.querySelectorAll('button,[role="button"],span,div,[contenteditable="false"],[data-state],[data-testid],[aria-label]')]
        .filter(visible)
        .map(el => ({ el, text: textOf(el), rect: rectOf(el), html: (el.outerHTML || '').slice(0, 700) }))
        .filter(item => matchesLabel([item.text, item.html].join(' ')))
        .filter(item => nearEditor(item.rect))
        .filter(item => item.rect.w <= 360 && item.rect.h <= 80)
        .sort((a, b) => {
          const aExact = labelKeys.some(label => compact(a.text) === label) ? 1 : 0;
          const bExact = labelKeys.some(label => compact(b.text) === label) ? 1 : 0;
          return bExact - aExact || Math.abs(a.rect.y - (editorRect ? editorRect.y : a.rect.y)) - Math.abs(b.rect.y - (editorRect ? editorRect.y : b.rect.y));
        })
        .map(item => ({ text: item.text, rect: item.rect, html: item.html }))
      : [];
    const editorText = editor
      ? (editor.matches('textarea,input') ? editor.value || '' : editor.textContent || '').replace(/\\s+/g, ' ').trim()
      : '';
    return {
      ok: Boolean(editor),
      labels,
      matched: references.length > 0,
      editorText,
      editorRect,
      references,
    };
  })()`);
}

async function verifyCodexComposerReferenceInserted(client, labels = [], selected = null) {
  const targetLabels = uniqueTextList(labels);
  const deadline = Date.now() + CODEX_COMPOSER_REFERENCE_VERIFY_MS;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readCodexComposerReferenceStateInCdpClient(client, targetLabels).catch(error => ({ ok: false, error: error.message || String(error) }));
    if (lastState && lastState.matched === true) {
      const first = Array.isArray(lastState.references) ? lastState.references[0] : null;
      const selection = composerSelectionFromLabel(targetLabels[0], {
        text: first && first.text || selected && selected.text || targetLabels[0],
        label: selected && selected.label || '',
        section: selected && selected.section || '',
        target: targetLabels[0],
      });
      return { ok: true, selection, state: lastState };
    }
    await delay(120);
  }
  const error = new Error(`Codex 已点击菜单项，但输入框中没有出现系统引用：${targetLabels.join(', ')}`);
  error.status = 502;
  error.code = 'CODEX_COMPOSER_REFERENCE_NOT_INSERTED';
  error.detail = JSON.stringify(lastState || {});
  throw error;
}

async function findCodexComposerReferenceRemoveRectInCdpClient(client, labels = []) {
  const targetLabels = uniqueTextList(labels);
  return await cdpEvaluate(client, `(() => {
    const labels = ${JSON.stringify(targetLabels)};
    const compact = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const labelKeys = labels.map(compact).filter(Boolean);
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => !el ? '' : [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      };
    };
    const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
    const root = editor && (editor.closest('form') || editor.closest('[class*="composer"]') || editor.closest('.relative'));
    if (!root) return null;
    const matchesLabel = text => {
      const key = compact(text);
      return key && labelKeys.some(label => key.includes(label) || label.includes(key));
    };
    const reference = [...root.querySelectorAll('button,[role="button"],span,div,[contenteditable="false"],[data-state],[data-testid],[aria-label]')]
      .filter(visible)
      .filter(el => matchesLabel([textOf(el), el.outerHTML || ''].join(' ')))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0];
    if (!reference) return null;
    const removeText = /remove|delete|close|dismiss|clear|取消|删除|移除|关闭|×/i;
    const removeButton = [...reference.querySelectorAll('button,[role="button"],[aria-label],[title]')]
      .filter(visible)
      .find(el => removeText.test(textOf(el)));
    if (removeButton) return rectOf(removeButton);
    return rectOf(reference);
  })()`);
}

async function positionCodexComposerSelectionAroundReferenceInCdpClient(client, labels = [], mode = 'after') {
  const targetLabels = uniqueTextList(labels);
  return await cdpEvaluate(client, `(() => {
    const labels = ${JSON.stringify(targetLabels)};
    const mode = ${JSON.stringify(mode)};
    const compact = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const labelKeys = labels.map(compact).filter(Boolean);
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => !el ? '' : [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      };
    };
    const matchesLabel = text => {
      const key = compact(text);
      return key && labelKeys.some(label => key.includes(label) || label.includes(key));
    };
    const editor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
    if (!editor || editor.matches('textarea,input')) {
      return { ok: false, reason: editor ? 'plain editor' : 'editor not found' };
    }
    const references = [...editor.querySelectorAll('button,[role="button"],span,div,[contenteditable="false"],[data-state],[data-testid],[aria-label]')]
      .filter(el => el !== editor && visible(el))
      .map(el => ({ el, text: textOf(el), rect: rectOf(el), html: (el.outerHTML || '').slice(0, 700) }))
      .filter(item => matchesLabel([item.text, item.html].join(' ')))
      .filter(item => item.rect.w <= 420 && item.rect.h <= 100)
      .sort((a, b) => {
        const aExact = labelKeys.some(label => compact(a.text) === label) ? 1 : 0;
        const bExact = labelKeys.some(label => compact(b.text) === label) ? 1 : 0;
        return bExact - aExact || (a.rect.w * a.rect.h) - (b.rect.w * b.rect.h);
      });
    const reference = references[0];
    if (!reference || !reference.el.parentNode) {
      return { ok: false, reason: 'reference not found', labels };
    }
    editor.focus();
    const range = document.createRange();
    if (mode === 'select') {
      range.selectNode(reference.el);
    } else {
      range.setStartAfter(reference.el);
      range.collapse(true);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true, mode, text: reference.text, rect: reference.rect };
  })()`);
}

async function removeCodexPluginReferenceByEditingCdpClient(client, labels = [], selectionHint = {}, beforeState = null) {
  const targetLabels = uniqueTextList(labels);
  let positioned = await positionCodexComposerSelectionAroundReferenceInCdpClient(client, targetLabels, 'after').catch(error => ({
    ok: false,
    reason: error && error.message || String(error),
  }));
  if (!positioned || positioned.ok !== true) {
    const error = new Error(`未能在 Codex 输入框定位插件引用：${targetLabels.join(', ')}`);
    error.status = 502;
    error.code = 'CODEX_PLUGIN_REFERENCE_NOT_EDITABLE';
    error.detail = JSON.stringify({ beforeState, positioned });
    throw error;
  }

  await cdpPressKey(client, 'Backspace', 'Backspace', 8);
  await delay(220);
  let after = await readCodexComposerReferenceStateInCdpClient(client, targetLabels).catch(() => ({ matched: false }));
  if (!after || after.matched !== true) {
    return {
      ok: true,
      removed: true,
      method: 'edit-backspace',
      selection: composerSelectionFromLabel(targetLabels[0], selectionHint),
      state: after,
    };
  }

  positioned = await positionCodexComposerSelectionAroundReferenceInCdpClient(client, targetLabels, 'select').catch(error => ({
    ok: false,
    reason: error && error.message || String(error),
  }));
  if (positioned && positioned.ok === true) {
    await cdpPressKey(client, 'Delete', 'Delete', 46);
    await delay(220);
    after = await readCodexComposerReferenceStateInCdpClient(client, targetLabels).catch(() => ({ matched: false }));
    if (!after || after.matched !== true) {
      return {
        ok: true,
        removed: true,
        method: 'edit-delete',
        selection: composerSelectionFromLabel(targetLabels[0], selectionHint),
        state: after,
      };
    }
  }

  const error = new Error(`未能从 Codex 输入框删除插件引用：${targetLabels.join(', ')}`);
  error.status = 502;
  error.code = 'CODEX_PLUGIN_REFERENCE_REMOVE_FAILED';
  error.detail = JSON.stringify({ after, positioned });
  throw error;
}

async function removeCodexPlusMenuItemViaCdp(labels = [], selectionHint = {}) {
  const targetLabels = uniqueTextList(labels);
  const target = await findCodexCdpTarget({ autoOpen: false });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await focusCodexComposerInCdpClient(client);
    const before = await readCodexComposerReferenceStateInCdpClient(client, targetLabels);
    if (!before || before.matched !== true) {
      return { ok: true, removed: false, selection: composerSelectionFromLabel(targetLabels[0], selectionHint), state: before };
    }

    if (isPluginComposerSelection(selectionHint, targetLabels)) {
      return await removeCodexPluginReferenceByEditingCdpClient(client, targetLabels, selectionHint, before);
    }

    const removeRect = await findCodexComposerReferenceRemoveRectInCdpClient(client, targetLabels).catch(() => null);
    if (removeRect) {
      await cdpClickRect(client, removeRect);
      await delay(180);
    } else {
      const editorText = String(before.editorText || '').trim();
      if (editorText.length > 0) {
        const error = new Error('Codex 输入框中已有文本，无法安全自动删除插件引用。');
        error.status = 409;
        error.code = 'CODEX_COMPOSER_REFERENCE_REMOVE_UNSAFE';
        error.detail = JSON.stringify(before);
        throw error;
      }
      await clearCodexComposerViaCdpClient(client);
    }

    const after = await readCodexComposerReferenceStateInCdpClient(client, targetLabels).catch(() => ({ matched: false }));
    if (after && after.matched === true) {
      const editorText = String(after.editorText || '').trim();
      if (editorText.length === 0) {
        await clearCodexComposerViaCdpClient(client);
        const cleared = await readCodexComposerReferenceStateInCdpClient(client, targetLabels).catch(() => ({ matched: false }));
        if (!cleared || cleared.matched !== true) {
          return { ok: true, removed: true, selection: composerSelectionFromLabel(targetLabels[0], selectionHint), state: cleared };
        }
      }
      const error = new Error(`未能从 Codex 输入框删除引用：${targetLabels.join(', ')}`);
      error.status = 502;
      error.code = 'CODEX_COMPOSER_REFERENCE_REMOVE_FAILED';
      error.detail = JSON.stringify(after || {});
      throw error;
    }
    return { ok: true, removed: true, selection: composerSelectionFromLabel(targetLabels[0], selectionHint), state: after };
  } finally {
    client.close();
  }
}

async function selectCodexSlashCommandViaCdp(commandLabels = [], inputText = '/') {
  const labels = uniqueTextList(commandLabels);
  if (!labels.length || !inputText) {
    const error = new Error('No Codex slash command target was provided.');
    error.status = 400;
    error.code = 'BAD_SLASH_COMMAND_TARGET';
    throw error;
  }
  const target = await findCodexCdpTarget({ autoOpen: false });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  let typedTemporaryCommand = false;
  const runningError = snapshot => {
    const error = new Error('Codex 当前正在回复，压缩命令暂不可用，请等待回复结束后再试。');
    error.status = 409;
    error.code = 'CODEX_COMPACT_UNAVAILABLE_WHILE_RUNNING';
    error.detail = JSON.stringify(codexRunningStopControls(snapshot).slice(0, 5));
    return error;
  };
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await closeCodexCdpMenus(client).catch(() => {});
    await focusCodexComposerInCdpClient(client);
    let snapshot = await readCodexModeMenuSnapshot(client);
    if (hasCodexRunningStopControl(snapshot)) throw runningError(snapshot);

    const composerState = await readCodexComposerTextInCdpClient(client).catch(() => ({ ok: false, text: '' }));
    if (!isDisposableSlashComposerText(composerState && composerState.text || '')) {
      const error = new Error('Codex 输入框不是空白，压缩需要在空白输入框输入 / 后选择。');
      error.status = 409;
      error.code = 'CODEX_COMPACT_REQUIRES_EMPTY_COMPOSER';
      error.detail = String(composerState && composerState.text || '').slice(0, 120);
      throw error;
    }

    await clearCodexComposerViaCdpClient(client);
    await client.call('Input.insertText', { text: String(inputText || '') });
    typedTemporaryCommand = true;
    await delay(420);
    snapshot = await readCodexModeMenuSnapshot(client);
    if (hasCodexRunningStopControl(snapshot)) throw runningError(snapshot);
    const item = findCodexSlashCommandMenuItem(snapshot, labels);

    if (!item) {
      await clearCodexComposerViaCdpClient(client).catch(() => {});
      typedTemporaryCommand = false;
      const error = new Error(`未在 Codex slash 命令菜单中找到：${labels.join(', ')}`);
      error.status = 502;
      error.code = 'CODEX_SLASH_COMMAND_NOT_FOUND';
      error.detail = JSON.stringify(codexModeMenuItems(snapshot).slice(-80));
      throw error;
    }
    await cdpClickRect(client, item.rect);
    typedTemporaryCommand = false;
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { ok: true, selected: item };
  } catch (error) {
    if (typedTemporaryCommand) await clearCodexComposerViaCdpClient(client).catch(() => {});
    throw error;
  } finally {
    client.close();
  }
}

function findCodexPlusButton(snapshot = {}) {
  const viewportHeight = Number(snapshot.innerHeight || 0);
  const viewportWidth = Number(snapshot.innerWidth || 0);
  const editorRect = snapshot.composerEditor && snapshot.composerEditor.rect ? snapshot.composerEditor.rect : null;
  const plusText = item => /Add files and more|添加|附件|Add|Attach|\+/i.test(String(item && item.text || ''));
  if (editorRect) {
    const left = Number(editorRect.x || 0) - 240;
    const right = Number(editorRect.right || (Number(editorRect.x || 0) + Number(editorRect.w || 0))) + 240;
    const top = Number(editorRect.y || 0) - 120;
    const bottom = Number(editorRect.bottom || (Number(editorRect.y || 0) + Number(editorRect.h || 0))) + 120;
    const anchored = (snapshot.items || [])
      .filter(item => {
        if (!item || item.disabled || !plusText(item)) return false;
        const rect = item.rect || {};
        const x = Number(rect.x || 0);
        const y = Number(rect.y || 0);
        const w = Number(rect.w || 0);
        const h = Number(rect.h || 0);
        if (w > 100 || h > 80) return false;
        return x >= left && x <= right && y >= top && y <= bottom;
      })
      .sort((a, b) => {
        const aDistance = Math.abs(Number(a.rect.x || 0) - Number(editorRect.x || 0));
        const bDistance = Math.abs(Number(b.rect.x || 0) - Number(editorRect.x || 0));
        return aDistance - bDistance || Number(a.rect.y || 0) - Number(b.rect.y || 0);
      })[0];
    if (anchored) return anchored;
  }
  return (snapshot.items || [])
    .filter(item => {
      if (!item || item.disabled) return false;
      const rect = item.rect || {};
      if (viewportHeight && Number(rect.y || 0) < viewportHeight * 0.55) return false;
      if (Number(rect.w || 0) > 88 || Number(rect.h || 0) > 72) return false;
      if (viewportWidth && Number(rect.x || 0) < viewportWidth * 0.25) return false;
      return plusText(item);
    })
    .sort((a, b) => a.rect.x - b.rect.x || b.rect.y - a.rect.y)[0];
}

function findCodexSidebarButton(snapshot = {}, labels = []) {
  const targetLabels = uniqueTextList(labels);
  const viewportWidth = Number(snapshot.innerWidth || 0);
  const sidebarRight = viewportWidth > 0 ? Math.min(420, Math.max(300, viewportWidth * 0.28)) : 420;
  return (snapshot.items || [])
    .filter(item => {
      if (!item || !item.text || item.disabled) return false;
      const rect = item.rect || {};
      if (Number(rect.x || 0) > sidebarRight) return false;
      if (Number(rect.w || 0) < 24 || Number(rect.h || 0) < 20) return false;
      return textMatchesAnyLabel(item.text, targetLabels);
    })
    .sort((a, b) => {
      const aExact = targetLabels.some(label => itemTextForCompare(a.text) === itemTextForCompare(label)) ? 1 : 0;
      const bExact = targetLabels.some(label => itemTextForCompare(b.text) === itemTextForCompare(label)) ? 1 : 0;
      return bExact - aExact || Number(a.rect.y || 0) - Number(b.rect.y || 0);
    })[0];
}

function findCodexPlusMenuItem(snapshot = {}, labels = []) {
  const targetLabels = uniqueTextList(labels);
  const editorRect = snapshot.composerEditor && snapshot.composerEditor.rect ? snapshot.composerEditor.rect : null;
  const viewportWidth = Number(snapshot.innerWidth || 0);
  const viewportHeight = Number(snapshot.innerHeight || 0);
  const items = (snapshot.items || [])
    .filter(item => {
      if (!item || !item.text || item.disabled) return false;
      if (!item.listNavigationItem && item.role !== 'menuitem' && !item.cmdkItem) return false;
      if (!textMatchesAnyLabel(item.text, targetLabels)) return false;
      const rect = item.rect || {};
      const x = Number(rect.x || 0);
      const y = Number(rect.y || 0);
      const w = Number(rect.w || 0);
      const right = Number(rect.right || (x + w));
      if (editorRect) {
        const editorX = Number(editorRect.x || 0);
        const editorY = Number(editorRect.y || 0);
        const editorHeight = Number(editorRect.h || editorRect.height || 0);
        const editorRight = Number(editorRect.right || (editorX + Number(editorRect.w || 0)));
        const editorBottom = Number(editorRect.bottom || (editorY + editorHeight));
        const verticalReach = Math.max(520, editorHeight + 420);
        const menuTop = editorY - verticalReach;
        const menuBottom = editorBottom + verticalReach;
        const menuLeft = editorX - 96;
        const menuRight = editorRight + 96;
        if (right < menuLeft || x > menuRight) return false;
        if (y < menuTop || y > menuBottom) return false;
      } else {
        if (viewportWidth && x < viewportWidth * 0.25) return false;
        if (viewportHeight && y > viewportHeight * 0.98) return false;
      }
      return true;
    });
  return items.sort((a, b) => {
    const aExact = targetLabels.some(label => itemTextForCompare(a.text) === itemTextForCompare(label)) ? 1 : 0;
    const bExact = targetLabels.some(label => itemTextForCompare(b.text) === itemTextForCompare(label)) ? 1 : 0;
    const aMenu = a.listNavigationItem ? 1 : 0;
    const bMenu = b.listNavigationItem ? 1 : 0;
    return bExact - aExact || bMenu - aMenu || Number(a.rect.y || 0) - Number(b.rect.y || 0);
  })[0];
}

function knownCodexPlusMenuRows() {
  return [
    { label: 'Files and folders', section: 'Add' },
    { label: '目标', section: 'Add' },
    { label: '计划模式', section: 'Add' },
    { label: 'Documents', section: '插件' },
    { label: 'PDF', section: '插件' },
    { label: 'Spreadsheets', section: '插件' },
    { label: 'Presentations', section: '插件' },
    { label: '浏览器', section: '插件' },
    { label: '电脑', section: '插件' },
    { label: 'Superpowers', section: '插件' },
  ];
}

function compactCodexPlusMenuText(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function findKnownCodexPlusMenuRow(text = '') {
  const rawText = String(text || '').replace(/\s+/g, ' ').trim();
  const compactText = value => String(value || '').replace(/\s+/g, '').toLowerCase();
  const rawCompact = compactText(rawText);
  const knownRowMatches = row => rawText === row.label || rawText.startsWith(row.label) || rawCompact.startsWith(compactText(row.label));
  return knownCodexPlusMenuRows().find(knownRowMatches) || null;
}

function normalizeCodexPlusMenuItem(item = {}, order = 0) {
  const rawLines = Array.isArray(item.lines)
    ? item.lines.map(line => String(line || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  const rawText = String(item.text || rawLines.join(' ') || '').replace(/\s+/g, ' ').trim();
  if (!rawText) return null;
  const row = findKnownCodexPlusMenuRow(rawText)
    || { label: rawLines[0] || rawText, section: '插件' };
  const description = rawLines.length > 1
    ? rawLines.slice(1).join(' ')
    : (rawText === row.label ? '' : rawText.slice(row.label.length).replace(/\s+/g, ' ').trim());
  const id = `codex-plus-${order}-${row.label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'item'}`;
  return {
    id,
    section: row.section,
    label: row.label,
    description,
    text: rawText,
    target: row.label,
    disabled: false,
    order,
  };
}

function codexPlusSearchHint(order = 0) {
  return {
    id: 'codex-plus-files-and-chats-search',
    section: 'Files and chats',
    label: 'Type to search files or chats',
    description: '',
    text: 'Type to search files or chats',
    target: '',
    disabled: true,
    order,
  };
}

function fallbackCodexPlusMenuItems(error = null) {
  const items = knownCodexPlusMenuRows()
    .map((row, index) => normalizeCodexPlusMenuItem({ text: row.label }, index))
    .filter(Boolean);
  items.push(codexPlusSearchHint(items.length));
  const response = {
    ok: true,
    fallback: true,
    source: 'codex-fallback-plus-menu',
    updatedAt: new Date().toISOString(),
    sections: ['Add', '插件', 'Files and chats'],
    items,
  };
  if (error) {
    response.liveError = {
      code: error.code || 'CODEX_PLUS_MENU_UNAVAILABLE',
      message: error.message || 'Codex plus menu is unavailable.',
    };
  }
  return response;
}

function codexPlusMenuItemKey(item = {}) {
  return `${String(item.section || '').trim()}::${String(item.target || item.label || '').trim().toLowerCase()}`;
}

function mergeCodexPlusMenuItems(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const key = codexPlusMenuItemKey(item);
      if (!key || key === '::') continue;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    }
  }
  const sectionOrder = { Add: 0, '插件': 1, 'Files and chats': 2 };
  return Array.from(byKey.values())
    .sort((a, b) => {
      const aSection = sectionOrder[a.section] ?? 9;
      const bSection = sectionOrder[b.section] ?? 9;
      return aSection - bSection || Number(a.order || 0) - Number(b.order || 0) || String(a.label || '').localeCompare(String(b.label || ''));
    })
    .map((item, index) => ({ ...item, order: index }));
}

function hasAllKnownCodexPlusMenuRows(items = []) {
  const keys = new Set(items.map(item => codexPlusMenuItemKey(item)));
  return knownCodexPlusMenuRows().every(row => keys.has(codexPlusMenuItemKey(row)));
}

function codexPlusMenuScrollPoint(snapshot = {}) {
  const menuItems = (snapshot.items || [])
    .filter(item => item && item.rect && (item.listNavigationItem || item.role === 'menuitem' || item.cmdkItem || String(item.html || '').includes('data-list-navigation-item')))
    .sort((a, b) => Number(a.rect.y || 0) - Number(b.rect.y || 0));
  if (menuItems.length) {
    const left = Math.min(...menuItems.map(item => Number(item.rect.x || 0)));
    const right = Math.max(...menuItems.map(item => Number(item.rect.right || (Number(item.rect.x || 0) + Number(item.rect.w || 0)))));
    const top = Math.min(...menuItems.map(item => Number(item.rect.y || 0)));
    const bottom = Math.max(...menuItems.map(item => Number(item.rect.bottom || (Number(item.rect.y || 0) + Number(item.rect.h || 0)))));
    return {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
    };
  }
  return {
    x: Math.round(Number(snapshot.innerWidth || 1200) / 2),
    y: Math.round(Number(snapshot.innerHeight || 900) / 2),
  };
}

async function scrollCodexPlusMenuInCdpClient(client, snapshot = {}, deltaY = 360) {
  const point = codexPlusMenuScrollPoint(snapshot);
  await client.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
  });
  await delay(180);
}

async function clickCodexPlusButtonDomFallback(client, rect = {}) {
  const centerX = Math.round(Number(rect.x || 0) + Number(rect.w || rect.width || 0) / 2);
  const centerY = Math.round(Number(rect.y || 0) + Number(rect.h || rect.height || 0) / 2);
  const result = await cdpEvaluate(client, `(() => {
    const centerX = ${JSON.stringify(centerX)};
    const centerY = ${JSON.stringify(centerY)};
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.y <= innerHeight &&
        rect.right >= 0 && rect.x <= innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => [
      el.innerText || el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const plusText = text => /Add files and more|添加|附件|Add|Attach|\\+/i.test(String(text || ''));
    const candidates = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          text: textOf(el),
          distance: Math.abs((rect.x + rect.width / 2) - centerX) + Math.abs((rect.y + rect.height / 2) - centerY),
        };
      })
      .filter(item => plusText(item.text))
      .sort((a, b) => a.distance - b.distance);
    const item = candidates[0];
    if (!item) return { ok: false, reason: 'plus button not found' };
    item.el.click();
    return { ok: true, text: item.text };
  })()`);
  if (!result || result.ok !== true) {
    const error = new Error(`Codex plus button fallback click failed: ${result && result.reason || 'unknown'}`);
    error.status = 502;
    error.code = 'CODEX_PLUS_BUTTON_FALLBACK_FAILED';
    throw error;
  }
  await delay(220);
  return result;
}

async function clickCodexPlusMenuItemDomFallback(client, labels = [], rect = {}) {
  const targetLabels = uniqueTextList(labels);
  const result = await cdpEvaluate(client, `(() => {
    const labels = ${JSON.stringify(targetLabels)};
    const targetRect = ${JSON.stringify(rect || {})};
    const compact = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const labelKeys = labels.map(compact).filter(Boolean);
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.y <= innerHeight &&
        rect.right >= 0 && rect.x <= innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => [
      el.innerText || el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      };
    };
    const matchesLabel = text => {
      const key = compact(text);
      return key && labelKeys.some(label => key.includes(label) || label.includes(key));
    };
    const nearTarget = rect => {
      const x = Number(targetRect.x || 0);
      const y = Number(targetRect.y || 0);
      const w = Number(targetRect.w || targetRect.width || 0);
      const h = Number(targetRect.h || targetRect.height || 0);
      if (!w || !h) return true;
      const right = Number(targetRect.right || (x + w));
      const bottom = Number(targetRect.bottom || (y + h));
      return rect.right >= x - 120 && rect.x <= right + 120 && rect.bottom >= y - 160 && rect.y <= bottom + 160;
    };
    const candidates = [...document.querySelectorAll('[data-list-navigation-item],[cmdk-item],[role="menuitem"],[role="option"],button,[role="button"]')]
      .filter(visible)
      .map(el => ({ el, text: textOf(el), rect: rectOf(el), html: (el.outerHTML || '').slice(0, 900) }))
      .filter(item => matchesLabel([item.text, item.html].join(' ')))
      .filter(item => nearTarget(item.rect))
      .sort((a, b) => {
        const aExact = labelKeys.some(label => compact(a.text) === label) ? 1 : 0;
        const bExact = labelKeys.some(label => compact(b.text) === label) ? 1 : 0;
        const aDistance = Math.abs((a.rect.x + a.rect.w / 2) - (Number(targetRect.x || 0) + Number(targetRect.w || targetRect.width || 0) / 2)) +
          Math.abs((a.rect.y + a.rect.h / 2) - (Number(targetRect.y || 0) + Number(targetRect.h || targetRect.height || 0) / 2));
        const bDistance = Math.abs((b.rect.x + b.rect.w / 2) - (Number(targetRect.x || 0) + Number(targetRect.w || targetRect.width || 0) / 2)) +
          Math.abs((b.rect.y + b.rect.h / 2) - (Number(targetRect.y || 0) + Number(targetRect.h || targetRect.height || 0) / 2));
        return bExact - aExact || aDistance - bDistance;
      });
    const item = candidates[0];
    if (!item) {
      return {
        ok: false,
        reason: 'menu item not found',
        labels,
        candidates: candidates.slice(0, 8).map(candidate => ({ text: candidate.text, rect: candidate.rect })),
      };
    }
    const clientX = item.rect.x + item.rect.w / 2;
    const clientY = item.rect.y + item.rect.h / 2;
    item.el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    item.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
    item.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
    item.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
    if (typeof item.el.click === 'function') item.el.click();
    return { ok: true, text: item.text, rect: item.rect };
  })()`);
  if (!result || result.ok !== true) {
    const error = new Error(`Codex plus menu item fallback click failed: ${result && result.reason || 'unknown'}`);
    error.status = 502;
    error.code = 'CODEX_PLUS_MENU_ITEM_FALLBACK_FAILED';
    error.detail = JSON.stringify(result || {});
    throw error;
  }
  await delay(260);
  return result;
}

async function clickCodexPlusMenuItemWithFallback(client, item = {}, labels = []) {
  await cdpClickRect(client, item.rect);
  await delay(260);
  if (shouldVerifyCodexPlusMenuInsertion(labels)) {
    const state = await readCodexComposerReferenceStateInCdpClient(client, labels).catch(() => null);
    if (state && state.matched === true) {
      return { ok: true, method: 'cdp-mouse', state };
    }
    await clickCodexPlusMenuItemDomFallback(client, labels, item.rect);
    return { ok: true, method: 'dom-fallback', state };
  }
  return { ok: true, method: 'cdp-mouse' };
}

function codexPlusMenuItemsFromSnapshot(snapshot = {}) {
  return (snapshot.items || [])
    .filter(item => item && item.text && !item.disabled && (item.listNavigationItem || item.role === 'menuitem' || item.cmdkItem || String(item.html || '').includes('data-list-navigation-item')))
    .filter(item => {
      const rect = item.rect || {};
      const width = Number(rect.w || 0);
      const x = Number(rect.x || 0);
      const y = Number(rect.y || 0);
      if (width < 180) return false;
      if (snapshot.innerWidth && x < Number(snapshot.innerWidth) * 0.25) return false;
      if (snapshot.innerHeight && y > Number(snapshot.innerHeight) - 64) return false;
      return true;
    })
    .sort((a, b) => Number(a.rect && a.rect.y || 0) - Number(b.rect && b.rect.y || 0))
    .map((item, index) => normalizeCodexPlusMenuItem(item, index))
    .filter(Boolean);
}

async function readCodexPlusMenuItemsViaCdp() {
  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await focusCodexComposerInCdpClient(client).catch(() => {});
    const readOpenedPlusItems = async () => {
      await closeCodexCdpMenus(client).catch(() => {});
      let snapshot = await readCodexModeMenuSnapshot(client);
      const plusButton = findCodexPlusButton(snapshot);
      if (!plusButton) {
        const error = new Error('Codex plus button not found.');
        error.status = 502;
        error.code = 'CODEX_PLUS_BUTTON_NOT_FOUND';
        error.detail = JSON.stringify((snapshot.items || []).slice(-80));
        throw error;
      }
      await clickCodexPlusRectWithoutSendCheck(client, plusButton.rect);
      await delay(420);
      let collected = [];
      let latestSnapshot = await readCodexModeMenuSnapshot(client);
      for (let index = 0; index < 6; index += 1) {
        const visibleItems = codexPlusMenuItemsFromSnapshot(latestSnapshot);
        collected = mergeCodexPlusMenuItems(collected, visibleItems);
        if (hasAllKnownCodexPlusMenuRows(collected)) break;
        await scrollCodexPlusMenuInCdpClient(client, latestSnapshot, 360);
        latestSnapshot = await readCodexModeMenuSnapshot(client);
      }
      return {
        items: collected,
        snapshot: latestSnapshot,
      };
    };
    let result = await readOpenedPlusItems();
    if (!result.items.length) {
      await delay(220);
      result = await readOpenedPlusItems();
    }
    const items = result.items;
    if (!items.length) {
      const error = new Error('Codex plus menu items were not found.');
      error.status = 502;
      error.code = 'CODEX_PLUS_MENU_EMPTY';
      error.detail = JSON.stringify((result.snapshot.items || [])
        .filter(candidate => candidate && (candidate.listNavigationItem || String(candidate.html || '').includes('data-list-navigation-item')))
        .slice(-80));
      throw error;
    }
    items.push(codexPlusSearchHint(items.length));
    return {
      ok: true,
      source: 'codex-cdp-plus-menu',
      updatedAt: new Date().toISOString(),
      sections: ['Add', '插件', 'Files and chats'],
      items,
    };
  } finally {
    await closeCodexCdpMenus(client).catch(() => {});
    client.close();
  }
}

async function findCodexPlusMenuItemWithScroll(client, labels = [], snapshot = {}) {
  let latestSnapshot = snapshot;
  for (let index = 0; index < 7; index += 1) {
    const item = findCodexPlusMenuItem(latestSnapshot, labels);
    if (item) {
      return { item, snapshot: latestSnapshot };
    }
    await scrollCodexPlusMenuInCdpClient(client, latestSnapshot, 360);
    latestSnapshot = await readCodexModeMenuSnapshot(client);
  }
  return { item: null, snapshot: latestSnapshot };
}

async function clickCodexPlusRectWithoutSendCheck(client, rect = {}) {
  const x = Math.round(Number(rect.x || 0) + Number(rect.w || rect.width || 0) / 2);
  const y = Math.round(Number(rect.y || 0) + Number(rect.h || rect.height || 0) / 2);
  await assertSafeCdpClickTarget(client, x, y);
  try {
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await delay(80);
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await delay(40);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  } catch (error) {
    await clickCodexPlusButtonDomFallback(client, rect);
  }
}

async function selectCodexPlusMenuItemViaCdp(labels = []) {
  const targetLabels = uniqueTextList(labels);
  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await focusCodexComposerInCdpClient(client).catch(() => {});
    await closeCodexCdpMenus(client).catch(() => {});
    let snapshot = await readCodexModeMenuSnapshot(client);
    if (shouldVerifyCodexPlusMenuInsertion(targetLabels) && hasCodexRunningStopControl(snapshot)) {
      const error = new Error('Codex 当前正在回复，插件或模式引用暂不可插入，请等待回复结束后再试。');
      error.status = 409;
      error.code = 'CODEX_COMPOSER_ACTION_UNAVAILABLE_WHILE_RUNNING';
      error.detail = JSON.stringify(codexRunningStopControls(snapshot).slice(0, 5));
      throw error;
    }
    const plusButton = findCodexPlusButton(snapshot);
    if (!plusButton) {
      const error = new Error('Codex plus button not found.');
      error.status = 502;
      error.code = 'CODEX_PLUS_BUTTON_NOT_FOUND';
      error.detail = JSON.stringify((snapshot.items || []).slice(-80));
      throw error;
    }
    await clickCodexPlusRectWithoutSendCheck(client, plusButton.rect);
    await delay(320);
    snapshot = await readCodexModeMenuSnapshot(client);
    const found = await findCodexPlusMenuItemWithScroll(client, targetLabels, snapshot);
    const item = found.item;
    snapshot = found.snapshot || snapshot;
    if (!item) {
      const error = new Error(`Codex plus menu item not found: ${targetLabels.join(', ')}`);
      error.status = 502;
      error.code = 'CODEX_PLUS_MENU_ITEM_NOT_FOUND';
      error.detail = JSON.stringify((snapshot.items || [])
        .filter(candidate => candidate && (candidate.listNavigationItem || candidate.role === 'menuitem' || candidate.cmdkItem))
        .slice(-80));
      throw error;
    }
    await clickCodexPlusMenuItemWithFallback(client, item, targetLabels);
    await delay(CODEX_COMMAND_SETTLE_MS);
    if (shouldVerifyCodexPlusMenuInsertion(targetLabels)) {
      const verified = await verifyCodexComposerReferenceInserted(client, targetLabels, item);
      return { ok: true, selected: item, selection: verified.selection, state: verified.state };
    }
    return { ok: true, selected: item, selection: null };
  } finally {
    client.close();
  }
}

async function clickCodexSidebarButtonViaCdp(labels = []) {
  const targetLabels = uniqueTextList(labels);
  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await closeCodexCdpMenus(client).catch(() => {});
    await delay(180);
    const snapshot = await readCodexModeMenuSnapshot(client);
    const button = findCodexSidebarButton(snapshot, targetLabels);
    if (!button) {
      const error = new Error(`Codex sidebar button not found: ${targetLabels.join(', ')}`);
      error.status = 502;
      error.code = 'CODEX_SIDEBAR_BUTTON_NOT_FOUND';
      error.detail = JSON.stringify((snapshot.items || [])
        .filter(item => item && item.rect && Number(item.rect.x || 0) <= 420)
        .slice(0, 80));
      throw error;
    }
    await cdpClickRect(client, button.rect);
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { ok: true, selected: button };
  } finally {
    client.close();
  }
}

function uniqueTextList(items = []) {
  return [...new Set(items.map(item => String(item || '').trim()).filter(Boolean))];
}

async function cdpMouseMoveToRect(client, rect = {}) {
  const x = Math.round(Number(rect.x || 0) + Number(rect.w || rect.width || 0) / 2);
  const y = Math.round(Number(rect.y || 0) + Number(rect.h || rect.height || 0) / 2);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
}

async function assertSafeCdpClickTarget(client, x, y) {
  const hit = await cdpEvaluate(client, `(() => {
    const textOf = el => !el ? '' : [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const node = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const row = node && typeof node.closest === 'function'
      ? node.closest('button,[role="button"],[role="menuitem"],[role="option"],[cmdk-item],[data-radix-collection-item]')
      : node;
    return {
      text: textOf(row || node),
      tag: row && row.tagName || node && node.tagName || '',
      role: row && row.getAttribute && row.getAttribute('role') || '',
      testid: row && row.getAttribute && row.getAttribute('data-testid') || '',
    };
  })()`);
  const text = String(hit && [hit.text, hit.testid].filter(Boolean).join(' ') || '');
  const dangerousWords = [
    '\u505c\u6b62',
    '\u7ec8\u6b62',
    '\u53d6\u6d88',
    '\u53d1\u9001',
    '\u63d0\u4ea4',
    'Stop',
    'Cancel',
    'Interrupt',
    'Abort',
    'Send',
    'Submit',
  ];
  const dangerousPattern = new RegExp(dangerousWords.join('|'), 'i');
  if (dangerousPattern.test(text) || isCodexStopControlText(text)) {
    const error = new Error(`refusing to click dangerous Codex control: ${text}`);
    error.code = 'CODEX_DANGEROUS_CLICK_BLOCKED';
    error.status = 409;
    error.detail = JSON.stringify(hit || {});
    throw error;
  }
}

async function cdpClickRect(client, rect = {}) {
  const x = Math.round(Number(rect.x || 0) + Number(rect.w || rect.width || 0) / 2);
  const y = Math.round(Number(rect.y || 0) + Number(rect.h || rect.height || 0) / 2);
  await assertSafeCdpClickTarget(client, x, y);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await delay(80);
  await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await delay(40);
  await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function closeCodexCdpMenus(client) {
  await assertCodexCdpIdleForControlAction(client, 'close-menus');
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await delay(120);
}

async function cdpPressKey(client, key, code = key, vk = 0) {
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await delay(70);
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await delay(120);
}

async function assertCodexCdpIdleForControlAction(client, actionName = 'Codex control action') {
  const snapshot = await readCodexModeMenuSnapshot(client).catch(() => null);
  if (!snapshot || !hasCodexRunningStopControl(snapshot)) return;
  const controls = codexRunningStopControls(snapshot).slice(0, 5);
  const error = new Error('Codex 当前正在回复，控制操作暂不可用，请等待回复结束后再试。');
  error.status = 409;
  error.code = 'CODEX_CONTROL_UNAVAILABLE_WHILE_RUNNING';
  error.detail = JSON.stringify({ action: actionName, controls });
  throw error;
}

function codexModeMenuBlockedWords() {
  return ['发送', '提交', '停止', '取消', '听写', '添加', '附件', '审查', '完全访问', 'Send', 'Submit', 'Stop', 'Cancel', 'Dictate', 'Attach', 'Add', 'Review', 'Full access'];
}

function isBlockedCodexModeText(text = '') {
  return codexModeMenuBlockedWords().some(word => String(text || '').includes(word));
}

function codexModeMenuItems(snapshot = {}) {
  return (snapshot.items || []).filter(item => {
    if (!item || !item.text || item.disabled || isBlockedCodexModeText(item.text)) return false;
    return item.role === 'menuitem' || item.role === 'option' || item.listNavigationItem === true || item.cmdkItem === true || item.radixItem === true;
  });
}

function findCodexModeControlButton(snapshot = {}) {
  const reasoningLabels = ['低', '中', '高', '超高'];
  return (snapshot.items || [])
    .filter(item => {
      if (!item.text || item.disabled || isBlockedCodexModeText(item.text)) return false;
      if (item.intelligenceTrigger) return true;
      if (item.rect.w < 40 || item.rect.w > 220 || item.rect.h < 20 || item.rect.h > 48) return false;
      const text = item.text.replace(/\s+/g, '');
      return /[0-9]/.test(text) && reasoningLabels.some(label => text.includes(label));
    })
    .sort((a, b) => (b.intelligenceTrigger ? 1 : 0) - (a.intelligenceTrigger ? 1 : 0) || b.rect.x - a.rect.x)[0];
}

function findCodexSubmenuTriggerByText(snapshot = {}, expectedText = '') {
  return codexModeMenuItems(snapshot)
    .filter(item => item.text.includes(expectedText) && (item.hasPopup || item.state === 'closed' || item.state === 'open'))
    .sort((a, b) => (b.hasPopup ? 1 : 0) - (a.hasPopup ? 1 : 0) || a.rect.y - b.rect.y)[0];
}

async function openCodexModeMenuInClient(client) {
  await closeCodexCdpMenus(client);
  let snapshot = await readCodexModeMenuSnapshot(client);
  const modeButton = findCodexModeControlButton(snapshot);
  if (!modeButton) {
    const error = new Error('mode menu button not found while reading Codex client options.');
    error.detail = JSON.stringify(codexModeMenuItems(snapshot).slice(-80));
    throw error;
  }
  await cdpClickRect(client, modeButton.rect);
  await delay(320);
  snapshot = await readCodexModeMenuSnapshot(client);
  return snapshot;
}

function uniqueModelOptions(options = []) {
  return modelOptionUtils.uniqueModelOptions(options);
}

function modelOptionFromMenuText(text = '') {
  return modelOptionUtils.modelOptionFromMenuText(text, readModelCatalogOptions());
}

function speedModeFromMenuText(text = '') {
  const compact = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!compact || compact === '速度' || compact === 'speed') return null;
  if (compact.includes('高速') || compact.includes('快速') || compact.includes('priority') || compact.includes('fast') || compact.includes('1.5x')) {
    return speedModeFromValue('fast', new Date().toISOString());
  }
  if (compact.includes('标准') || compact.includes('默认') || compact.includes('default') || compact.includes('standard')) {
    return speedModeFromValue('standard', new Date().toISOString());
  }
  return null;
}

function uniqueModeOptions(options = []) {
  const out = [];
  const seen = new Set();
  for (const option of options) {
    const key = String(option && option.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(option);
  }
  return out;
}

function resolveLiveSpeedOptions(speedSupported, currentSpeed = null, liveModeOptions = null) {
  if (!speedSupported) return [];
  const liveOptions = liveModeOptions && Array.isArray(liveModeOptions.speedOptions) ? liveModeOptions.speedOptions : [];
  const current = currentSpeed && currentSpeed.available ? currentSpeed : null;
  const merged = uniqueModeOptions([current, ...liveOptions, ...Object.values(SPEED_MODE_TARGETS)].filter(Boolean));
  return merged.length ? merged : Object.values(SPEED_MODE_TARGETS);
}

async function readCodexModeOptionsViaCdp() {
  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    let snapshot = await openCodexModeMenuInClient(client);

    const reasoningOptions = uniqueModeOptions(codexModeMenuItems(snapshot)
      .map(item => item.text.trim())
      .filter(text => ['低', '中', '高', '超高'].includes(text))
      .map(text => reasoningModeFromValue(text, new Date().toISOString())));

    let modelOptions = [];
    const modelTrigger = findCodexSubmenuTriggerByText(snapshot, '模型') || codexModeMenuItems(snapshot)
      .filter(item => (item.hasPopup || item.state === 'closed' || item.state === 'open') && !item.text.includes('速度'))
      .find(item => /[0-9]/.test(item.text) || /gpt|codex|model/i.test(item.text));
    if (modelTrigger) {
      await cdpMouseMoveToRect(client, modelTrigger.rect);
      await delay(360);
      snapshot = await readCodexModeMenuSnapshot(client);
      let modelItems = codexModeMenuItems(snapshot);
      if (!modelItems.some(item => modelOptionFromMenuText(item.text))) {
        await cdpClickRect(client, modelTrigger.rect);
        await delay(360);
        snapshot = await readCodexModeMenuSnapshot(client);
        modelItems = codexModeMenuItems(snapshot);
      }
      modelOptions = uniqueModelOptions(modelItems
        .filter(item => !item.text.includes('模型') && !item.text.includes('速度') && !['低', '中', '高', '超高'].includes(item.text.trim()))
        .map(item => modelOptionFromMenuText(item.text))
        .filter(Boolean));
    }

    snapshot = await openCodexModeMenuInClient(client);
    let speedOptions = [];
    const speedTrigger = findCodexSubmenuTriggerByText(snapshot, '速度');
    if (speedTrigger) {
      await cdpMouseMoveToRect(client, speedTrigger.rect);
      await delay(420);
      snapshot = await readCodexModeMenuSnapshot(client);
      let speedItems = codexModeMenuItems(snapshot);
      if (!speedItems.some(item => speedModeFromMenuText(item.text))) {
        await cdpClickRect(client, speedTrigger.rect);
        await delay(420);
        snapshot = await readCodexModeMenuSnapshot(client);
        speedItems = codexModeMenuItems(snapshot);
      }
      speedOptions = uniqueModeOptions(speedItems
        .map(item => speedModeFromMenuText(item.text))
        .filter(Boolean));
    }

    await closeCodexCdpMenus(client);
    return {
      modelOptions: modelOptionsForClient({ modelOptions }),
      reasoningOptions: reasoningOptions.length ? reasoningOptions : Object.values(REASONING_MODE_TARGETS),
      speedOptions,
      updatedAt: new Date().toISOString(),
      source: 'codex-cdp-menu',
    };
  } finally {
    client.close();
  }
}

async function readLiveCodexModeOptions(options = {}) {
  const now = Date.now();
  if (!options.force && liveModeOptionsCache.value && now - liveModeOptionsCache.at < CODEX_MODE_OPTIONS_CACHE_MS) {
    return liveModeOptionsCache.value;
  }
  try {
    const value = await readCodexModeOptionsViaCdp();
    liveModeOptionsCache = { at: Date.now(), value };
    return value;
  } catch {
    return liveModeOptionsCache.value || null;
  }
}

async function readLiveCodexModeOptionsBounded(options = {}) {
  const timeoutMs = Number(options.timeoutMs || CODEX_MODE_OPTIONS_REFRESH_TIMEOUT_MS);
  return Promise.race([
    readLiveCodexModeOptions(options),
    timeoutFallback(timeoutMs, liveModeOptionsCache.value || null),
  ]);
}

function cachedLiveModeOptions() {
  return liveModeOptionsCache.value || null;
}

async function readCodexModeMenuSnapshot(client) {
  return await cdpEvaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 &&
        rect.bottom >= 0 && rect.y <= innerHeight &&
        rect.right >= 0 && rect.x <= innerWidth &&
        style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => [
      el.innerText || el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const linesOf = el => String(el.innerText || el.textContent || '')
      .split(/\\n+/)
      .map(line => line.replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      };
    };
    const composerEditor = [...document.querySelectorAll('.ProseMirror,[contenteditable="true"],textarea,input')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0] || null;
    const items = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[cmdk-item],[data-radix-collection-item]')]
      .filter(visible)
      .map(el => {
        return {
          text: textOf(el),
          role: el.getAttribute('role') || '',
          state: el.getAttribute('data-state') || '',
          checked: el.getAttribute('aria-checked') || '',
          hasPopup: el.getAttribute('aria-haspopup') || '',
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          intelligenceTrigger: el.getAttribute('data-codex-intelligence-trigger') === 'true',
          reasoningSelected: el.getAttribute('data-reasoning-selected') || '',
          speedSelected: el.getAttribute('data-speed-selected') || '',
          modelSelected: el.getAttribute('data-model-selected') || '',
          listNavigationItem: el.getAttribute('data-list-navigation-item') === 'true',
          cmdkItem: el.hasAttribute('cmdk-item'),
          radixItem: el.hasAttribute('data-radix-collection-item'),
          highlighted: el.hasAttribute('data-highlighted'),
          lines: linesOf(el),
          html: (el.outerHTML || '').slice(0, 900),
          rect: rectOf(el),
        };
      });
    return {
      innerWidth,
      innerHeight,
      composerEditor: composerEditor ? {
        text: textOf(composerEditor),
        rect: rectOf(composerEditor),
      } : null,
      items,
    };
  })()`);
}

async function selectCodexComposerModeMenuItemViaCdp(targetLabels = [], options = {}) {
  const labels = uniqueTextList(targetLabels);
  if (!labels.length) {
    throw new Error('没有可选择的 Codex 菜单目标。');
  }

  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    await delay(250);
    const kind = String(options.kind || '');
    const reasoningLabels = ['低', '中', '高', '超高'];
    const reasoningTargetLabel = labels.includes('xhigh') || labels.includes('超高') ? '超高'
      : labels.includes('high') || labels.includes('高') ? '高'
        : labels.includes('medium') || labels.includes('中') ? '中'
          : labels.includes('low') || labels.includes('低') ? '低'
            : '';
    const compact = value => String(value || '').replace(/\s+/g, '').toLowerCase();
    const modelKey = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9.]+/g, '');
    const normalizedLabels = labels.map(label => ({ raw: label, compact: compact(label), model: modelKey(label) })).filter(label => label.compact || label.model);
    const speedTargetKeys = kind === 'speed'
      ? uniqueTextList(labels.map(label => speedModeFromValue(label).key).filter(Boolean))
      : [];
    const isBlocked = isBlockedCodexModeText;
    const menuItems = codexModeMenuItems;
    const matchesTarget = text => {
      if (kind === 'speed' && speedTargetKeys.length) {
        const mode = speedModeFromMenuText(text);
        return Boolean(mode && speedTargetKeys.includes(mode.key));
      }
      const compactText = compact(text);
      const modelText = modelKey(text);
      return normalizedLabels.some(label => {
        if (label.compact && (compactText === label.compact || compactText.includes(label.compact) || label.compact.includes(compactText))) return true;
        return Boolean(label.model && (modelText === label.model || modelText.includes(label.model) || label.model.includes(modelText)));
      });
    };
    const findTargetItem = snapshot => menuItems(snapshot)
      .filter(item => matchesTarget(item.text))
      .sort((a, b) => {
        const aExact = normalizedLabels.some(label => compact(a.text) === label.compact || modelKey(a.text) === label.model) ? 1 : 0;
        const bExact = normalizedLabels.some(label => compact(b.text) === label.compact || modelKey(b.text) === label.model) ? 1 : 0;
        return bExact - aExact || b.rect.x - a.rect.x || a.rect.y - b.rect.y;
      })[0];
    const findReasoningTargetItem = snapshot => menuItems(snapshot)
      .filter(item => item.role === 'menuitem' && item.text.trim() === reasoningTargetLabel)
      .sort((a, b) => a.rect.y - b.rect.y)[0];
    const findModeControlButton = findCodexModeControlButton;
    const findSubmenuTriggerByText = findCodexSubmenuTriggerByText;
    const findModelSubmenuTrigger = snapshot => menuItems(snapshot)
      .filter(item => {
        if (!item.hasPopup && item.state !== 'closed' && item.state !== 'open') return false;
        const text = item.text.trim();
        const isReasoningOnly = reasoningLabels.includes(text);
        return !isReasoningOnly && (/[0-9]/.test(text) || /gpt|codex|model/i.test(text) || text.includes('模型'));
      })
      .sort((a, b) => (b.hasPopup ? 1 : 0) - (a.hasPopup ? 1 : 0) || a.rect.y - b.rect.y)[0];
    const highlightedItem = snapshot => menuItems(snapshot).find(item => item.highlighted);
    const isModelTrigger = item => Boolean(item && (item.hasPopup || item.state === 'closed' || item.state === 'open')
      && !item.text.includes('速度')
      && !reasoningLabels.includes(item.text.trim())
      && (/[0-9]/.test(item.text) || /gpt|codex|model/i.test(item.text) || item.text.includes('模型')));
    const isSpeedTrigger = item => Boolean(item && item.text.includes('速度') && (item.hasPopup || item.state === 'closed' || item.state === 'open'));
    const focusSubmenuTrigger = async expectedKind => {
      for (let index = 0; index < 8; index += 1) {
        snapshot = await readCodexModeMenuSnapshot(client);
        const current = highlightedItem(snapshot);
        if ((expectedKind === 'model' && isModelTrigger(current)) || (expectedKind === 'speed' && isSpeedTrigger(current))) {
          await cdpPressKey(client, 'ArrowRight', 'ArrowRight', 39);
          await delay(220);
          snapshot = await readCodexModeMenuSnapshot(client);
          return current;
        }
        await cdpPressKey(client, 'ArrowDown', 'ArrowDown', 40);
      }
      return null;
    };
    const summaryItems = snapshot => menuItems(snapshot).map(item => ({
      text: item.text,
      role: item.role,
      state: item.state,
      checked: item.checked,
      hasPopup: item.hasPopup,
      highlighted: item.highlighted,
      rect: item.rect,
    })).slice(-80);

    await closeCodexCdpMenus(client);
    let snapshot = await readCodexModeMenuSnapshot(client);
    const modeButton = findModeControlButton(snapshot);
    if (!modeButton) {
      const error = new Error(`mode menu button not found: ${labels.join(' / ')}`);
      error.detail = JSON.stringify(summaryItems(snapshot));
      throw error;
    }
    await cdpClickRect(client, modeButton.rect);
    await delay(320);
    snapshot = await readCodexModeMenuSnapshot(client);

    let targetItem = kind === 'reasoning' ? findReasoningTargetItem(snapshot) : null;
    if (!targetItem && kind === 'model') {
      await focusSubmenuTrigger('model');
      targetItem = findTargetItem(snapshot);
      if (!targetItem) {
        const trigger = findSubmenuTriggerByText(snapshot, '模型') || findModelSubmenuTrigger(snapshot);
        if (trigger) {
          await cdpClickRect(client, trigger.rect);
          await delay(360);
          snapshot = await readCodexModeMenuSnapshot(client);
          targetItem = findTargetItem(snapshot);
        }
      }
    }
    if (!targetItem && kind === 'speed') {
      await focusSubmenuTrigger('speed');
      targetItem = findTargetItem(snapshot);
    }
    if (!targetItem && kind === 'speed') {
      const trigger = findSubmenuTriggerByText(snapshot, '速度');
      if (trigger) {
        await cdpMouseMoveToRect(client, trigger.rect);
        await delay(420);
        snapshot = await readCodexModeMenuSnapshot(client);
        targetItem = findTargetItem(snapshot);
        if (!targetItem) {
          await cdpClickRect(client, trigger.rect);
          await delay(420);
          snapshot = await readCodexModeMenuSnapshot(client);
          targetItem = findTargetItem(snapshot);
        }
      }
    }
    if (!targetItem && !kind) targetItem = findTargetItem(snapshot);
    if (!targetItem) {
      const error = new Error(`target menu item not found: ${labels.join(' / ')}`);
      error.detail = JSON.stringify(summaryItems(snapshot));
      throw error;
    }
    await cdpClickRect(client, targetItem.rect);
    await delay(480);
    const result = {
      ok: true,
      selected: {
        text: targetItem.text,
        role: targetItem.role,
        state: targetItem.state,
        rect: targetItem.rect,
      },
    };
    if (!result || result.ok !== true) {
      const detail = result && result.items ? ` 可见菜单项: ${JSON.stringify(result.items)}` : '';
      throw new Error(`${result && result.reason || 'Codex menu selection failed'}: ${labels.join(' / ')}${detail}`);
    }
    return result;
  } finally {
    client.close();
  }
}

async function selectCodexModelViaCdp(target = {}) {
  const labels = uniqueTextList(modelTextCandidates(target));
  return selectCodexComposerModeMenuItemViaCdp(labels, { kind: 'model' });
}

async function selectCodexReasoningModeViaCdp(target = {}) {
  const labels = uniqueTextList([target.displayName, target.label, target.value, target.key]);
  return selectCodexComposerModeMenuItemViaCdp(labels, { kind: 'reasoning' });
}

async function selectCodexSpeedModeViaCdp(target = {}) {
  const labels = uniqueTextList([
    target.displayName,
    target.label,
    target.value,
    target.serviceTier,
    target.key,
    target.key === 'fast' ? '1.5x' : '',
    target.key === 'fast' ? '\u9ad8\u901f' : '',
    target.key === 'fast' ? '\u5feb\u901f' : '',
    target.key === 'fast' ? 'fast' : '',
    target.key === 'fast' ? 'priority' : '',
    target.key === 'standard' ? '\u6807\u51c6' : '',
    target.key === 'standard' ? '\u9ed8\u8ba4' : '',
    target.key === 'standard' ? 'default' : '',
  ]);
  return selectCodexComposerModeMenuItemViaCdp(labels, { kind: 'speed' });
}

async function readCodexComposerModeButtonTextViaCdp() {
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    return await cdpEvaluate(client, `(() => {
      const reasoningLabels = ['低', '中', '高', '超高'];
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const items = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          const intelligenceTrigger = el.getAttribute('data-codex-intelligence-trigger') === 'true';
          let score = 0;
          const compact = text.replace(/\\s+/g, '');
          const hasReasoning = reasoningLabels.some(label => compact.includes(label));
          const isCompactModeButton = rect.x > innerWidth * 0.35
            && rect.width >= 40 && rect.width <= 220
            && rect.height >= 20 && rect.height <= 48
            && compact.length <= 32
            && /[0-9]/.test(compact)
            && hasReasoning;
          if (intelligenceTrigger) score += 1000;
          if (isCompactModeButton) score += 120;
          if (/[0-9]/.test(text)) score += 50;
          if (/gpt|codex|model/i.test(text)) score += 30;
          if (hasReasoning) score += 45;
          return { text, score, intelligenceTrigger };
        })
        .filter(item => item.text && (item.intelligenceTrigger || item.score >= 120))
        .sort((a, b) => b.score - a.score);
      return items[0] ? items[0].text : '';
    })()`);
  } finally {
    client.close();
  }
}

async function readCodexComposerModeStateViaCdp(options = {}) {
  const target = await findCodexCdpTarget({
    autoOpen: options.autoOpen,
    probeTimeoutMs: options.probeTimeoutMs,
  });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl, options.timeoutMs || CODEX_CDP_SEND_TIMEOUT_MS);
  try {
    await client.call('Runtime.enable').catch(() => {});
    return await cdpEvaluate(client, `(() => {
      const reasoningLabels = ['低', '中', '高', '超高'];
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textOf = el => [
        el.textContent || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
      ].join(' ').replace(/\\s+/g, ' ').trim();
      const items = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);
          const compact = text.replace(/\\s+/g, '');
          const hasReasoning = reasoningLabels.some(label => compact.includes(label));
          const intelligenceTrigger = el.getAttribute('data-codex-intelligence-trigger') === 'true';
          const modelSelected = el.getAttribute('data-model-selected') || '';
          const reasoningSelected = el.getAttribute('data-reasoning-selected') || '';
          const speedSelected = el.getAttribute('data-speed-selected') || '';
          let score = 0;
          if (intelligenceTrigger) score += 1000;
          if (modelSelected || reasoningSelected || speedSelected) score += 900;
          if (/[0-9]/.test(text)) score += 50;
          if (/gpt|codex|model/i.test(text)) score += 30;
          if (hasReasoning) score += 45;
          return {
            text,
            score,
            intelligenceTrigger,
            modelSelected,
            reasoningSelected,
            speedSelected,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          };
        })
        .filter(item => item.text || item.modelSelected || item.reasoningSelected || item.speedSelected)
        .sort((a, b) => b.score - a.score);
      const item = items[0];
      return item ? {
        text: item.text || '',
        modelSelected: item.modelSelected || '',
        reasoningSelected: item.reasoningSelected || '',
        speedSelected: item.speedSelected || '',
      } : null;
    })()`);
  } finally {
    client.close();
  }
}

function modelInfoFromComposerModeText(text = '') {
  const compact = modelCompareKey(text);
  if (!compact) return modelInfoFromId('');
  const match = modelOptionUtils.bestModelOptionMatch(text, readModelCatalogOptions());
  return match ? modelInfoFromId(match.id || match.key || match.displayName || '', new Date().toISOString()) : modelInfoFromId('');
}

function speedModeFromComposerModeText(text = '') {
  const compact = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (compact.includes('高速') || compact.includes('快速') || compact.includes('priority') || compact.includes('fast') || compact.includes('1.5x')) {
    return speedModeFromValue('fast', new Date().toISOString());
  }
  if (compact.includes('标准') || compact.includes('默认') || compact.includes('default') || compact.includes('standard')) {
    return speedModeFromValue('standard', new Date().toISOString());
  }
  return speedModeFromValue('');
}

async function readLiveCodexComposerModeState() {
  try {
    const state = await readCodexComposerModeStateViaCdp({
      autoOpen: false,
      probeTimeoutMs: CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS,
      timeoutMs: CODEX_CDP_PASSIVE_SEND_TIMEOUT_MS,
    });
    const text = state && state.text ? state.text : '';
    const modelSelected = state && state.modelSelected ? state.modelSelected : '';
    const reasoningSelected = state && state.reasoningSelected ? state.reasoningSelected : '';
    const speedSelected = state && state.speedSelected ? state.speedSelected : '';
    if (!text && !modelSelected && !reasoningSelected && !speedSelected) return null;
    const model = modelSelected ? modelInfoFromId(modelSelected, new Date().toISOString()) : modelInfoFromComposerModeText(text);
    const reasoningMode = reasoningModeFromValue(reasoningSelected || reasoningKeyFromComposerModeText(text), new Date().toISOString());
    const speedMode = speedModeFromValue(speedSelected, new Date().toISOString());
    const parsedSpeedMode = speedMode.key ? speedMode : speedModeFromComposerModeText(text);
    return { text, model, reasoningMode, speedMode: parsedSpeedMode };
  } catch {
    return null;
  }
}

function hasFreshCodexThreadActivation(threadId) {
  return Boolean(
    isCodexThreadId(threadId) &&
    lastCodexThreadActivation.threadId === threadId &&
    Date.now() - lastCodexThreadActivation.at <= CODEX_THREAD_SYNC_FRESH_MS
  );
}

async function focusTarget(target, threadId = '', options = {}) {
  if (target !== 'codex') return;

  if (threadId && isCodexThreadId(threadId)) {
    await activateCodexThread(threadId, { allowCached: Boolean(options.assumeThreadSynced) });
  }
  await restoreCodexDesktopWindow();
  if (options.skipComposerClick) return;
  if (threadId && isCodexThreadId(threadId)) {
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
  }
  if (options.requireComposerFocus) {
    await focusCodexComposerViaCdp();
    return;
  }
  await focusCodexComposerViaCdp().catch(() => {});
}

async function activateCodexThreadViaExistingCdp(threadId = '') {
  if (!isCodexThreadId(threadId)) {
    return { ok: false, skipped: true, reason: 'empty-thread' };
  }

  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget({ autoOpen: false });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    const row = await cdpEvaluate(client, `(() => {
      const threadId = ${JSON.stringify(threadId)};
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 &&
          rect.bottom >= 0 && rect.y <= innerHeight &&
          rect.right >= 0 && rect.x <= innerWidth &&
          style.display !== 'none' && style.visibility !== 'hidden';
      };
      const rectOf = el => {
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        };
      };
      const normalizeThreadId = value => {
        const match = String(value || '').trim().match(/(?:^|:)([a-f0-9]{8}-[a-f0-9-]{27,})$/i);
        return match ? match[1] : '';
      };
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .filter(visible)
        .find(el => normalizeThreadId(el.getAttribute('data-app-action-sidebar-thread-id')) === threadId);
      if (!row) return null;
      return {
        text: (row.textContent || '').replace(/\\s+/g, ' ').trim(),
        active: row.getAttribute('data-app-action-sidebar-thread-active') === 'true',
        rect: rectOf(row),
      };
    })()`);
    if (!row || !row.rect) {
      return { ok: false, code: 'CODEX_THREAD_ROW_NOT_FOUND', threadId };
    }
    if (row.active !== true) {
      await cdpClickRect(client, row.rect);
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    }
    await focusCodexComposerInCdpClient(client).catch(() => {});
    lastCodexThreadActivation = { threadId, at: Date.now() };
    return { ok: true, threadId, selected: row };
  } finally {
    client.close();
  }
}

async function activateCodexThreadForComposerAction(threadId = '') {
  if (!isCodexThreadId(threadId)) {
    return { ok: false, skipped: true };
  }
  let result = null;
  try {
    result = await activateCodexThreadViaExistingCdp(threadId);
  } catch (error) {
    result = {
      ok: false,
      code: error && error.code || 'CODEX_THREAD_ACTIVATE_FAILED',
      message: error && error.message || String(error),
    };
  }
  if (result && result.ok) return result;
  return await focusCurrentCodexComposerForComposerAction(threadId, result);
}

async function focusCurrentCodexComposerForComposerAction(threadId = '', activationResult = null) {
  await restoreCodexDesktopWindow();
  const target = await findCodexCdpTarget({ autoOpen: false });
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.bringToFront').catch(() => {});
    await client.call('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
    const focused = await focusCodexComposerInCdpClient(client);
    return {
      ok: true,
      fallback: true,
      threadId,
      selected: null,
      focused,
      activationResult,
    };
  } finally {
    client.close();
  }
}

async function activateCodexThread(threadId = '', options = {}) {
  if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
    await openWindowsUri('codex://');
    await restoreCodexDesktopWindow();
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    return;
  }

  const deepLink = codexThreadDeepLink(threadId);
  if (deepLink) {
    await openWindowsUri(deepLink);
    await delay(CODEX_DEEPLINK_SETTLE_MS);
  }
  await openWindowsUri('codex://');
  await restoreCodexDesktopWindow();
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
}

async function activateNewCodexThread(cwd = '') {
  const deepLink = codexNewThreadDeepLink(cwd);
  await openWindowsUri(deepLink);
  await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
  await openWindowsUri('codex://');
  await restoreCodexDesktopWindow();
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  lastCodexThreadActivation = { threadId: '', at: 0 };
}

async function activateNewProjectlessCodexThread(anchorThreadId = '') {
  // `codex://threads/new` without a path can inherit Codex Desktop's last
  // active project. To create a real “Chats/对话” thread, first navigate to an
  // existing projectless thread and then invoke Codex's own New Chat command;
  // Codex checks the current thread's project kind and starts with
  // `activeProject: null` for projectless chats.
  if (isCodexThreadId(anchorThreadId)) {
    await activateCodexThread(anchorThreadId);
    await pressCodexShortcut('n', ['command']);
    await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
  } else {
    await activateNewCodexThread('');
  }
  await openWindowsUri('codex://');
  await restoreCodexDesktopWindow();
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  lastCodexThreadActivation = { threadId: '', at: 0 };
}

async function dispatchCodexShortcutInCdpClient(client, key, modifiers = []) {
  const normalized = new Set(modifiers.map(item => String(item || '').toLowerCase() === 'command' ? 'control' : String(item || '').toLowerCase()));
  const keyText = String(key || '').toLowerCase();
  const upper = keyText.length === 1 ? keyText.toUpperCase() : keyText;
  const code = keyText.length === 1 ? `Key${upper}` : upper;
  const virtualKeyCode = keyText.length === 1 ? upper.charCodeAt(0) : 0;
  let modifierMask = 0;
  if (normalized.has('alt') || normalized.has('option')) modifierMask |= 1;
  if (normalized.has('control') || normalized.has('ctrl')) modifierMask |= 2;
  if (normalized.has('shift')) modifierMask |= 8;
  if (normalized.has('meta')) modifierMask |= 4;

  if (normalized.has('control') || normalized.has('ctrl')) {
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: modifierMask,
    });
  }
  if (normalized.has('shift')) {
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers: modifierMask,
    });
  }
  if (normalized.has('alt') || normalized.has('option')) {
    await client.call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Alt',
      code: 'AltLeft',
      windowsVirtualKeyCode: 18,
      nativeVirtualKeyCode: 18,
      modifiers: modifierMask,
    });
  }

  await client.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: keyText,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers: modifierMask,
  });
  await client.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: keyText,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers: modifierMask,
  });

  if (normalized.has('alt') || normalized.has('option')) {
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 });
  }
  if (normalized.has('shift')) {
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
  }
  if (normalized.has('control') || normalized.has('ctrl')) {
    await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
  }
}

async function createNewCodexThreadViaExistingCdp(target = {}) {
  const cdpTarget = await findCodexCdpTarget({
    autoOpen: false,
    probeTimeoutMs: CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS,
  }).catch(error => {
    const wrapped = new Error('Codex control is not ready. Enable Codex control from the backend panel before creating a new thread from the App.');
    wrapped.status = 409;
    wrapped.code = 'CODEX_CDP_REQUIRED_FOR_NEW_THREAD';
    wrapped.detail = error && error.message || String(error);
    throw wrapped;
  });
  const client = await connectCdpWebSocket(cdpTarget.webSocketDebuggerUrl);
  try {
    await client.call('Page.bringToFront').catch(() => {});
    await dispatchCodexShortcutInCdpClient(client, 'n', ['command']);
    await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
    lastCodexThreadActivation = { threadId: '', at: 0 };
    return {
      method: 'cdp-shortcut',
      scope: target.scope || '',
      cwd: target.cwd || '',
    };
  } finally {
    client.close();
  }
}

function validLocalDirectory(value) {
  const normalized = value ? path.normalize(value) : '';
  if (!normalized || !path.isAbsolute(normalized)) return '';
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : '';
  } catch {
    return '';
  }
}

function normalizeNewThreadScope(payload = {}) {
  const raw = typeof payload.scope === 'string' ? payload.scope.trim().toLowerCase() : '';
  if (raw === 'conversation' || raw === 'project') return raw;
  if (payload.isProjectThread === false) return 'conversation';
  if (payload.isProjectThread === true) return 'project';
  return '';
}

function projectCwdOrEmpty(value) {
  const cwd = validLocalDirectory(value);
  if (!cwd) return '';
  return classifyThreadProject(cwd).isProjectThread ? cwd : '';
}

function resolveNewThreadTarget(payload = {}) {
  const scope = normalizeNewThreadScope(payload);
  const projectPath = projectCwdOrEmpty(typeof payload.projectPath === 'string' ? payload.projectPath : '');
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';

  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }

  if (scope === 'conversation') {
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (scope === 'project' && projectPath) {
    return { scope: 'project', cwd: projectPath, anchorThreadId: threadId };
  }

  if (threadId) {
    const file = findCodexSessionFileByThreadId(threadId);
    const metaCwd = file ? readSessionMeta(file).cwd || '' : '';
    const metaProject = classifyThreadProject(validLocalDirectory(metaCwd) || '');
    if (metaProject.isProjectThread) {
      return { scope: 'project', cwd: metaProject.projectPath, anchorThreadId: threadId };
    }
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (projectPath) return { scope: 'project', cwd: projectPath, anchorThreadId: '' };
  return { scope: 'conversation', cwd: '', anchorThreadId: '' };
}

async function handleNewCodexThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const target = resolveNewThreadTarget(payload);
    const project = classifyThreadProject(target.cwd);
    const creation = await createNewCodexThreadViaExistingCdp(target);
    return json(res, 200, {
      ok: true,
      pending: true,
      createdBy: creation.method,
      cwd: project.isProjectThread ? target.cwd : '',
      projectName: project.projectName,
      projectPath: project.projectPath,
      projectKey: project.projectKey,
      scope: project.isProjectThread ? 'project' : 'conversation',
      message: project.isProjectThread
        ? `已在 Codex 打开“${project.projectName}”的新线程。`
        : '已在 Codex 打开一个新的对话线程。',
    });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '新建线程失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

function sanitizeFileName(name, fallback = 'image') {
  const base = path.basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return base || fallback;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  return '.img';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function decodeAttachment(attachment, index) {
  const mime = String(attachment && attachment.type || '').toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('目前只支持图片附件。');
  const dataUrl = String(attachment.dataUrl || '');
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('图片数据格式不正确。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`单张图片太大，请控制在 ${formatBytes(MAX_ATTACHMENT_BYTES)} 以内。`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(attachment.name || '') || extensionForMime(mime);
  const fileName = `${Date.now()}-${index}-${sanitizeFileName(attachment.name || `image${ext}`)}`;
  const filePath = path.join(UPLOAD_DIR, fileName.endsWith(ext) ? fileName : `${fileName}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, mime, name: attachment.name || path.basename(filePath), size: buffer.length };
}

function decodeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error(`图片最多一次发送 ${MAX_ATTACHMENTS} 张。`);
  return input.map(decodeAttachment);
}

async function copyImageToClipboard(file) {
  await runPowerShell(`Set-Clipboard -LiteralPath ${psSingleQuote(file.filePath)}`);
}

async function pressPaste() {
  await sendWindowsKeys('^v');
}

async function pressPasteAndEnter() {
  await pressPaste();
  await delay(TEXT_PASTE_SETTLE_MS);
  await pressEnter();
}

async function pressPasteAndSubmit() {
  await pressPaste();
  await delay(TEXT_PASTE_SETTLE_MS);
  await pressEnter();
  await delay(120);
  await sendWindowsKeys('^{ENTER}');
}

async function pressEnter() {
  await sendWindowsKeys('{ENTER}');
}

async function pressCodexShortcut(key, modifiers = []) {
  await sendWindowsKeys(windowsShortcutExpression(key, modifiers));
}

async function pressCancelCodexResponse() {
  await restoreCodexDesktopWindow();
  await sendWindowsKeys('{ESC}');
  await delay(80);
  await sendWindowsKeys(windowsShortcutExpression('.', ['control']));
}


async function pasteAndEnter(text, target = 'frontmost', attachments = [], threadId = '', options = {}) {
  await focusTarget(target, threadId, options);

  for (const attachment of attachments) {
    await copyImageToClipboard(attachment);
    await pressPaste();
    await delay(ATTACHMENT_PASTE_SETTLE_MS);
  }

  if (text) {
    if (target === 'codex' && attachments.length === 0 && process.env.CODEX2FRP_DISABLE_CDP_SEND !== '1') {
      try {
        await sendTextViaCodexCdp(text);
        return;
      } catch (error) {
        console.warn('Codex CDP send unavailable, falling back to Windows paste:', error && error.message || error);
      }
    }
    await copyTextToClipboard(text);
    await pressPasteAndSubmit();
    return;
  }

  await pressEnter();
}

function modelSwitchTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const catalogTarget = findModelOption(explicit);
  if (catalogTarget) return catalogTarget;
  if (!explicit) {
    const options = availableModelOptionsForSwitch();
    if (options.length) return options[0];
  }
  const error = new Error(explicit ? '未找到这个模型。' : '没有读取到可切换的模型。');
  error.status = 400;
  error.code = 'MODEL_TARGET_NOT_FOUND';
  throw error;
}

function modelCompareKey(value = '') {
  return modelOptionUtils.modelCompareKey(value);
}

function modelTextCandidates(model = {}) {
  return modelOptionUtils.modelTextCandidates(model);
}

function modelCandidateMatches(actual = {}, expected = {}) {
  return modelOptionUtils.modelCandidateMatches(actual, expected);
}

async function readCodexVisibleModelTextsViaCdp() {
  const target = await findCodexCdpTarget();
  const client = await connectCdpWebSocket(target.webSocketDebuggerUrl);
  try {
    await client.call('Runtime.enable').catch(() => {});
    return await cdpEvaluate(client, `(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const nodes = [...document.querySelectorAll('button,[role="button"],[aria-label],[data-testid]')]
        .filter(visible)
        .map(el => [
          el.textContent || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-testid') || '',
        ].join(' ').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      return [...new Set(nodes)].slice(0, 120);
    })()`);
  } finally {
    client.close();
  }
}

async function verifyCodexModelSwitch(threadId = '', target = {}, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 12000);
  let lastEvidence = '';
  while (Date.now() < deadline) {
    if (options.domOnly !== true) {
      const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
      if (file) {
        const current = currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES));
        if (modelCandidateMatches(current, target)) {
          return { ...current, available: true, verifiedBy: 'session' };
        }
      }
    }

    try {
      const visibleTexts = [await readCodexComposerModeButtonTextViaCdp()].filter(Boolean);
      const expectedKeys = modelTextCandidates(target).map(modelCompareKey).filter(Boolean);
      const evidence = Array.isArray(visibleTexts)
        ? visibleTexts.find(text => {
          const textKey = modelCompareKey(text);
          return expectedKeys.some(expectedKey => textKey === expectedKey || textKey.includes(expectedKey) || expectedKey.includes(textKey));
        })
        : '';
      if (evidence) {
        return { ...target, available: true, verifiedBy: 'dom', evidence };
      }
      if (Array.isArray(visibleTexts) && visibleTexts.length) {
        lastEvidence = visibleTexts.slice(0, 8).join(' | ');
      }
    } catch (error) {
      lastEvidence = error && error.message || String(error);
    }

    await delay(250);
  }

  const error = new Error('模型切换未能在 Codex 桌面端确认，请先确认 Codex 窗口可用后重试。');
  error.status = 502;
  error.code = 'MODEL_SWITCH_UNVERIFIED';
  error.detail = lastEvidence;
  throw error;
}

function modeCompareKey(value = '') {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function modeTextMatchesTarget(text = '', target = {}) {
  const textKey = modeCompareKey(text);
  if (!textKey) return false;
  return [target.key, target.value, target.label, target.displayName, target.serviceTier]
    .map(modeCompareKey)
    .filter(Boolean)
    .some(key => textKey === key || textKey.includes(key) || key.includes(textKey));
}

function reasoningKeyFromComposerModeText(text = '') {
  const compact = String(text || '').replace(/\s+/g, '');
  if (!compact) return '';
  if (compact.includes('超高')) return 'xhigh';
  if (compact.includes('高')) return 'high';
  if (compact.includes('中')) return 'medium';
  if (compact.includes('低')) return 'low';
  return '';
}

function composerModeTextMatchesReasoning(text = '', target = {}) {
  const actualKey = reasoningKeyFromComposerModeText(text);
  const targetMode = reasoningModeFromValue(target.key || target.value || target.label || target.displayName || '');
  return Boolean(actualKey && targetMode.key && actualKey === targetMode.key);
}

function reasoningModeMatches(actual = {}, target = {}) {
  const actualMode = reasoningModeFromValue(actual.key || actual.value || actual.label || actual.displayName || '');
  const targetMode = reasoningModeFromValue(target.key || target.value || target.label || target.displayName || '');
  return Boolean(actualMode.key && targetMode.key && actualMode.key === targetMode.key);
}

function speedModeMatches(actual = {}, target = {}) {
  const actualMode = speedModeFromValue(actual.key || actual.value || actual.serviceTier || actual.label || actual.displayName || '');
  const targetMode = speedModeFromValue(target.key || target.value || target.serviceTier || target.label || target.displayName || '');
  return Boolean(actualMode.key && targetMode.key && actualMode.key === targetMode.key);
}

async function verifyCodexReasoningModeSwitch(threadId = '', target = {}, selection = {}, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 12000);
  let lastEvidence = selection?.selected?.text || '';
  while (Date.now() < deadline) {
    try {
      const buttonText = await readCodexComposerModeButtonTextViaCdp();
      if (composerModeTextMatchesReasoning(buttonText, target)) {
        return { ...target, available: true, verifiedBy: 'dom', evidence: buttonText };
      }
      lastEvidence = buttonText || lastEvidence;
    } catch (error) {
      lastEvidence = error && error.message || String(error);
    }

    await delay(250);
  }

  const error = new Error('推理模式切换未能在 Codex 桌面端确认，请确认 Codex 窗口可用后重试。');
  error.status = 502;
  error.code = 'REASONING_SWITCH_UNVERIFIED';
  error.detail = lastEvidence;
  throw error;
}

async function verifyCodexSpeedModeSwitch(target = {}, selection = {}, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 12000);
  let lastEvidence = selection?.selected?.text || '';
  while (Date.now() < deadline) {
    if (options.domOnly === true) {
      try {
        const state = await readCodexComposerModeStateViaCdp({
          autoOpen: false,
          probeTimeoutMs: CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS,
          timeoutMs: CODEX_CDP_PASSIVE_SEND_TIMEOUT_MS,
        });
        const speed = speedModeFromValue(state && state.speedSelected ? state.speedSelected : '');
        const parsedSpeed = speed.key ? speed : speedModeFromComposerModeText(state && state.text ? state.text : '');
        if (speedModeMatches(parsedSpeed, target)) {
          return { ...target, available: true, verifiedBy: 'dom', evidence: parsedSpeed.value || state.text || lastEvidence };
        }
        lastEvidence = parsedSpeed.value || state?.text || lastEvidence;
      } catch (error) {
        lastEvidence = error && error.message || String(error);
      }
      await delay(250);
      continue;
    }

    const configMode = speedModeFromValue(tomlStringValue(readCodexConfigText(), 'service_tier'));
    if (speedModeMatches(configMode, target)) {
      return { ...target, available: true, verifiedBy: 'config', evidence: configMode.value };
    }
    lastEvidence = configMode.value || lastEvidence;
    await delay(250);
  }

  const error = new Error('速度模式切换未能在 Codex 桌面端确认，请确认 Codex 窗口可用后重试。');
  error.status = 502;
  error.code = 'SPEED_SWITCH_UNVERIFIED';
  error.detail = lastEvidence;
  throw error;
}

async function switchCodexGuiModel(threadId = '', targetKey = '') {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
  const target = modelSwitchTargetForCurrent(current, targetKey);

  let liveTargetModel = null;
  let liveSyncError = null;
  try {
    liveTargetModel = await trySyncCodexModelViaExistingCdp(target);
  } catch (error) {
    liveSyncError = error;
  }
  const configTargetModel = await trySwitchCodexModelViaConfig(liveTargetModel || target);
  const finalTargetModel = liveTargetModel || configTargetModel;
  writeControlOverride('model', finalTargetModel.id || target.id || target.key || target.displayName || targetKey);

  return {
    ok: true,
    threadId,
    currentModel: current,
    targetModel: {
      ...finalTargetModel,
      updatedAt: new Date().toISOString(),
      fallback: !liveTargetModel,
      liveSynced: Boolean(liveTargetModel),
      liveSyncErrorCode: liveSyncError && liveSyncError.code || '',
    },
    message: liveTargetModel
      ? `已切换到 ${finalTargetModel.displayName || finalTargetModel.id || target.displayName}`
      : `已保存模型为 ${finalTargetModel.displayName || finalTargetModel.id || target.displayName}，当前运行中的回复不受影响，后续任务生效。`,
  };
}

async function trySwitchCodexModelViaConfig(target = {}) {
  const configValue = target.id || target.key || target.model || target.slug || target.displayName || '';
  if (!configValue) {
    const error = new Error('没有可写入 Codex 配置的模型值。');
    error.code = 'MODEL_CONFIG_VALUE_MISSING';
    throw error;
  }
  writeCodexConfigStringValue('model', configValue);
  return {
    ...target,
    id: target.id || configValue,
    key: target.key || configValue,
    available: true,
    verifiedBy: 'config-write',
    evidence: configValue,
  };
}

async function requireExistingCodexCdpTargetForSwitch(kind = 'control') {
  try {
    return await findCodexCdpTarget({ probeTimeoutMs: CODEX_CDP_PASSIVE_PROBE_TIMEOUT_MS });
  } catch (error) {
    const wrapped = new Error('Codex control is not ready. Enable Codex control from the backend panel first, then retry this switch.');
    wrapped.status = 409;
    wrapped.code = 'CODEX_CDP_REQUIRED_FOR_SWITCH';
    wrapped.detail = `${kind}: ${error && error.message || String(error)}`;
    throw wrapped;
  }
}

async function trySyncCodexModelViaExistingCdp(target = {}) {
  await requireExistingCodexCdpTargetForSwitch('model');
  const selection = await selectCodexModelViaCdp(target);
  await delay(CODEX_COMMAND_SETTLE_MS);
  const verified = await verifyCodexModelSwitch('', target, {
    timeoutMs: CODEX_CONFIG_SWITCH_VERIFY_MS,
    domOnly: true,
    selection,
  });
  return { ...verified, verifiedBy: verified.verifiedBy || 'dom', selected: selection.selected || null };
}

function reasoningModeTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  if (REASONING_MODE_TARGETS[explicit]) return REASONING_MODE_TARGETS[explicit];
  const order = ['low', 'medium', 'high', 'xhigh'];
  const currentIndex = order.indexOf(current.key);
  const nextKey = order[(currentIndex + 1 + order.length) % order.length] || 'medium';
  return REASONING_MODE_TARGETS[nextKey] || REASONING_MODE_TARGETS.medium;
}

function speedModeTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const explicitMode = speedModeFromValue(explicit);
  if (explicitMode.key && SPEED_MODE_TARGETS[explicitMode.key]) return SPEED_MODE_TARGETS[explicitMode.key];
  const order = ['standard', 'fast'];
  const currentIndex = order.indexOf(current.key);
  const nextKey = order[(currentIndex + 1 + order.length) % order.length] || 'standard';
  return SPEED_MODE_TARGETS[nextKey] || SPEED_MODE_TARGETS.standard;
}

async function switchCodexReasoningMode(threadId = '', targetKey = '') {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
  const target = reasoningModeTargetForCurrent(current, targetKey);

  let liveTargetReasoning = null;
  let liveSyncError = null;
  try {
    liveTargetReasoning = await trySyncCodexReasoningViaExistingCdp(target);
  } catch (error) {
    liveSyncError = error;
  }
  const configTargetReasoning = await trySwitchCodexReasoningViaConfig(liveTargetReasoning || target);
  const finalTargetReasoning = liveTargetReasoning || configTargetReasoning;
  writeControlOverride('reasoning', finalTargetReasoning.key || target.key || target.value);

  return {
    ok: true,
    threadId,
    currentReasoningMode: current,
    targetReasoningMode: {
      ...finalTargetReasoning,
      updatedAt: new Date().toISOString(),
      fallback: !liveTargetReasoning,
      liveSynced: Boolean(liveTargetReasoning),
      liveSyncErrorCode: liveSyncError && liveSyncError.code || '',
    },
    message: liveTargetReasoning
      ? `已切换推理模式为 ${finalTargetReasoning.displayName || target.displayName}`
      : `已保存推理强度为 ${finalTargetReasoning.displayName || target.displayName}，当前运行中的回复不受影响，后续任务生效。`,
  };
}

async function trySwitchCodexReasoningViaConfig(target = {}) {
  const configValue = target.value || target.key || '';
  if (!configValue) {
    const error = new Error('没有可写入 Codex 配置的推理强度值。');
    error.code = 'REASONING_CONFIG_VALUE_MISSING';
    throw error;
  }
  writeCodexConfigStringValue('model_reasoning_effort', configValue);
  return {
    ...target,
    available: true,
    verifiedBy: 'config-write',
    evidence: configValue,
  };
}

async function trySyncCodexReasoningViaExistingCdp(target = {}) {
  await requireExistingCodexCdpTargetForSwitch('reasoning');
  const selection = await selectCodexReasoningModeViaCdp(target);
  await delay(CODEX_COMMAND_SETTLE_MS);
  const verified = await verifyCodexReasoningModeSwitch('', target, selection, {
    timeoutMs: CODEX_CONFIG_SWITCH_VERIFY_MS,
  });
  return { ...verified, verifiedBy: verified.verifiedBy || 'dom', selected: selection.selected || null };
}

async function switchCodexSpeedMode(threadId = '', targetKey = '') {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const configSpeed = speedModeFromValue(tomlStringValue(readCodexConfigText(), 'service_tier'));
  const current = file ? currentSpeedModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : configSpeed;
  const configModel = modelInfoFromId(tomlStringValue(readCodexConfigText(), 'model'));
  const parsedModel = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : configModel;
  const controlOverrides = readAppState().controlOverrides || {};
  const currentMode = controlOverrideSpeed(controlOverrides, current) || configSpeed || (current.key ? current : configSpeed);
  const liveModeState = await readLiveCodexComposerModeState();
  const liveModel = liveModeState && liveModeState.model && liveModeState.model.available ? liveModeState.model : null;
  const currentModel = controlOverrideModel(controlOverrides, parsedModel) || configModel || liveModel ||
    (parsedModel && parsedModel.available ? parsedModel : configModel);
  if (!codexModelSupportsSpeed(currentModel)) {
    const error = new Error('当前模型不支持速度调节；只有 GPT-5.5 和 GPT-5.4 支持速度选项。');
    error.status = 400;
    error.code = 'SPEED_UNSUPPORTED_MODEL';
    throw error;
  }
  const target = speedModeTargetForCurrent(currentMode, targetKey);

  let liveTargetSpeed = null;
  let liveSyncError = null;
  try {
    liveTargetSpeed = await trySyncCodexSpeedViaExistingCdp(target);
  } catch (error) {
    liveSyncError = error;
  }
  const configTargetSpeed = await trySwitchCodexSpeedViaConfig(liveTargetSpeed || target);
  const finalTargetSpeed = liveTargetSpeed || configTargetSpeed;
  writeControlOverride('speed', finalTargetSpeed.key || target.key || target.value);

  return {
    ok: true,
    threadId,
    currentSpeedMode: currentMode,
    speedMode: {
      ...finalTargetSpeed,
      updatedAt: new Date().toISOString(),
      fallback: !liveTargetSpeed,
      liveSynced: Boolean(liveTargetSpeed),
      liveSyncErrorCode: liveSyncError && liveSyncError.code || '',
    },
    targetSpeedMode: {
      ...finalTargetSpeed,
      updatedAt: new Date().toISOString(),
      fallback: !liveTargetSpeed,
      liveSynced: Boolean(liveTargetSpeed),
      liveSyncErrorCode: liveSyncError && liveSyncError.code || '',
    },
    message: liveTargetSpeed
      ? `已切换速度为 ${finalTargetSpeed.displayName || target.displayName}`
      : `已保存速度为 ${finalTargetSpeed.displayName || target.displayName}，当前运行中的回复不受影响，后续任务生效。`,
  };
}

async function trySwitchCodexSpeedViaConfig(target = {}) {
  writeCodexConfigStringValue('service_tier', target.serviceTier || target.value || '');
  await delay(CODEX_COMMAND_SETTLE_MS);
  const verifiedTargetSpeed = await verifyCodexSpeedModeSwitch(target, { selected: { text: 'config-write' } }, { timeoutMs: CODEX_CONFIG_SWITCH_VERIFY_MS });
  verifiedTargetSpeed.verifiedBy = 'config-write';
  return verifiedTargetSpeed;
}

async function trySyncCodexSpeedViaExistingCdp(target = {}) {
  await requireExistingCodexCdpTargetForSwitch('speed');
  const selection = await selectCodexSpeedModeViaCdp(target);
  await delay(CODEX_COMMAND_SETTLE_MS);
  return {
    ...target,
    available: true,
    verifiedBy: 'menu-selection',
    evidence: selection?.selected?.text || '',
    selected: selection.selected || null,
  };
}

async function stopCodexResponse(threadId = '') {
  await focusTarget('codex', threadId);
  await pressCancelCodexResponse();
}

function assertCodexComposerActionThreadIdle(threadId = '') {
  if (!isCodexThreadId(threadId)) {
    return;
  }
  const status = parseCodexStatus({ threadId });
  const running = status && (
    status.active === true ||
    status.running === true ||
    status.status === 'running' ||
    status.status === 'waiting'
  );
  if (!running) {
    return;
  }
  const error = new Error('Codex 当前正在回复，插件、模式和 + 菜单引用暂不可插入，请等待回复结束后再试。');
  error.status = 409;
  error.code = 'CODEX_COMPOSER_ACTION_UNAVAILABLE_WHILE_RUNNING';
  error.detail = JSON.stringify({
    threadId,
    status: status.status || '',
    active: status.active === true,
    preview: status.preview || '',
    sessionFile: status.sessionFile || '',
  });
  throw error;
}

async function runCodexComposerAction(threadId = '', action = '', target = '', selectionHint = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('Bad thread id.');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  assertCodexComposerActionThreadIdle(threadId);
  await activateCodexThreadForComposerAction(threadId);
  const normalizedAction = String(action || '').trim().toLowerCase();

  switch (normalizedAction) {
    case 'compact': {
      const result = await selectCodexSlashCommandViaCdp(['压缩', 'Compact', 'compact', 'Compress', 'Summarize'], '/');
      return { ok: true, action: normalizedAction, threadId, target, message: '已打开 Codex 压缩上下文。', selected: result.selected };
    }
    case 'goal': {
      const result = await selectCodexPlusMenuItemViaCdp(['目标设置', '目标', 'Goal']);
      return { ok: true, action: normalizedAction, threadId, target, message: '目标模式已插入 Codex 输入框。', selected: result.selected, selection: result.selection };
    }
    case 'plan': {
      const result = await selectCodexPlusMenuItemViaCdp(['计划模式', '计划', 'Plan']);
      return { ok: true, action: normalizedAction, threadId, target, message: '计划模式已插入 Codex 输入框。', selected: result.selected, selection: result.selection };
    }
    case 'plus-menu-item': {
      if (!target.trim()) {
        const error = new Error('No Codex plus menu target was provided.');
        error.status = 400;
        error.code = 'BAD_PLUS_MENU_TARGET';
        throw error;
      }
      const result = await selectCodexPlusMenuItemViaCdp([target]);
      return {
        ok: true,
        action: normalizedAction,
        threadId,
        target,
        message: result.selection ? `${target} 已插入 Codex 输入框。` : `${target} 已在 Codex 中打开。`,
        selected: result.selected,
        selection: result.selection,
      };
    }
    case 'remove-plus-menu-item': {
      if (!target.trim()) {
        const error = new Error('No Codex plus menu target was provided.');
        error.status = 400;
        error.code = 'BAD_PLUS_MENU_TARGET';
        throw error;
      }
      const result = await removeCodexPlusMenuItemViaCdp([target], selectionHint);
      return { ok: true, action: normalizedAction, threadId, target, message: result.removed ? `${target} 已从 Codex 输入框移除。` : `${target} 未在 Codex 输入框中。`, removed: result.removed, selection: result.selection };
    }
    case 'plugin': {
      if (!target.trim()) {
        const error = new Error('No Codex plus menu plugin target was provided.');
        error.status = 400;
        error.code = 'BAD_PLUS_MENU_TARGET';
        throw error;
      }
      const result = await selectCodexPlusMenuItemViaCdp([target]);
      return { ok: true, action: normalizedAction, threadId, target, message: `${target} 已插入 Codex 输入框。`, selected: result.selected, selection: result.selection };
    }
    default: {
      const error = new Error('Unsupported composer action.');
      error.status = 400;
      error.code = 'BAD_COMPOSER_ACTION';
      throw error;
    }
  }
}

async function handleComposerPlusMenu(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized.' });
  }

  try {
    const result = await readCodexPlusMenuItemsViaCdp();
    return json(res, 200, result);
  } catch (error) {
    return json(res, 200, fallbackCodexPlusMenuItems(error));
  }
}

async function handleComposerAction(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized.' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || 'Bad request.' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const action = typeof payload.action === 'string' ? payload.action : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const selection = payload.selection && typeof payload.selection === 'object' ? payload.selection : {};
  try {
    invalidateCodexThreadListCache();
    const result = await runCodexComposerAction(threadId, action, target, selection);
    invalidateCodexThreadListCache();
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, {
        ok: false,
        code: error.code || 'BAD_REQUEST',
        message: error.message || 'Composer action failed.',
        detail: error.detail || '',
      });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function runCodexThreadCommand(threadId, command, options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  await activateCodexThread(threadId);

  if (command === 'archive') {
    await pressCodexShortcut('a', ['command', 'shift']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: '已归档当前 Codex 线程。' };
  }

  if (command === 'pin') {
    await pressCodexShortcut('p', ['command', 'option']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: options.pinned ? '已置顶当前 Codex 线程。' : '已取消置顶当前 Codex 线程。' };
  }

  if (command === 'rename') {
    const name = String(options.name || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      const error = new Error('新名称不能为空。');
      error.status = 400;
      error.code = 'EMPTY_THREAD_NAME';
      throw error;
    }
    if (name.length > 120) {
      const error = new Error('新名称太长，请控制在 120 个字符以内。');
      error.status = 400;
      error.code = 'THREAD_NAME_TOO_LONG';
      throw error;
    }
    await pressCodexShortcut('r', ['command', 'option']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    await copyTextToClipboard(name);
    await pressPaste();
    await delay(80);
    await pressEnter();
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: '已重命名当前 Codex 线程。', name };
  }

  const error = new Error('不支持的线程操作。');
  error.status = 400;
  error.code = 'BAD_THREAD_ACTION';
  throw error;
}

async function handleThreadAction(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const action = String(payload.action || '').trim();
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    invalidateCodexThreadListCache();
    const state = readAppState();
    let result;
    if (action === 'archive') {
      result = await runCodexThreadCommand(threadId, 'archive');
      state.archivedThreadIds = setThreadSetMembership(state.archivedThreadIds, threadId, true);
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, false);
    } else if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      result = await runCodexThreadCommand(threadId, 'pin', { pinned });
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, pinned);
    } else if (action === 'rename') {
      result = await runCodexThreadCommand(threadId, 'rename', { name: payload.name });
      state.titleOverrides = state.titleOverrides || {};
      state.titleOverrides[threadId] = { name: result.name, renamedAt: new Date().toISOString() };
    } else {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ACTION', message: '不支持的线程操作。' });
    }
    writeAppState(state);
    invalidateCodexThreadListCache();
    const nextThreadId = action === 'archive' ? (listCodexThreads(120)[0]?.id || '') : threadId;
    return json(res, 200, { ok: true, action, threadId, nextThreadId, ...result });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '线程操作失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleStopCodex(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    invalidateCodexThreadListCache();
    await stopCodexResponse(threadId);
    invalidateCodexThreadListCache();
    return json(res, 200, { ok: true, threadId, message: '已向 Codex 发送终止指令。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleModelSwitch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  try {
    const result = await switchCodexGuiModel(threadId, target);
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换模型失败。', detail: error.detail || '' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换模型。请确认 Codex 正在运行，且辅助功能权限正常。' });
  }
}

async function handleReasoningMode(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  try {
    const result = await switchCodexReasoningMode(threadId, target);
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换推理模式失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换推理模式。请确认 Codex 正在运行，且辅助功能权限正常。' });
  }
}

async function handleSpeedMode(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  try {
    const result = await switchCodexSpeedMode(threadId, target);
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换速度模式失败。', detail: error.detail || '' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换速度模式。请确认 Codex 正在运行，且辅助功能权限正常。' });
  }
}

async function handleControlPort(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  if (req.method === 'POST') {
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (error) {
      return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
    }
  }

  try {
    const result = await ensureCodexCdpReady({
      forceRestart: payload.forceRestart === true,
      autoOpen: payload.autoOpen !== false,
    });
    const modeOptions = await readLiveCodexModeOptionsBounded({ force: true }).catch(() => null);
    return json(res, 200, {
      ok: true,
      ready: true,
      launched: result.launched,
      port: result.port,
      host: result.host,
      targetUrl: result.target && result.target.url || '',
      lastLaunch: result.lastLaunch,
      modeOptions,
      permissions: [
        '读取 Codex 当前模型、思考强度、速度按钮状态',
        '读取模型、思考强度、速度菜单候选项',
        '点击 Codex 菜单项完成模型、思考强度、速度切换',
        '向 Codex 输入框插入文字并点击发送按钮',
      ],
    });
  } catch (error) {
    return json(res, error.status || 502, {
      ok: false,
      ready: false,
      code: error.code || 'CODEX_CDP_REQUIRED',
      message: error.message || 'Codex control port is not available.',
      detail: error.detail || '',
      port: codexCdpPort,
      host: CODEX_CDP_HOST,
      autoOpen: shouldAutoOpenCodexCdp({ autoOpen: payload.autoOpen !== false }),
    });
  }
}

async function handleSend(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。请使用启动服务时打印出来的完整手机链接。' });
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (error) {
    return json(res, error.status || 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  const target = payload.target === 'codex' ? 'codex' : 'frontmost';
  const selectedThreadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  const expectNewThread = payload.expectNewThread === true && target === 'codex' && !selectedThreadId;
  const directPasteWithoutClick = payload.directPasteWithoutClick === true && expectNewThread;
  const previousThreadId = isCodexThreadId(payload.previousThreadId) ? payload.previousThreadId : '';
  const expectedNewThreadCwd = validLocalDirectory(typeof payload.expectedCwd === 'string' ? payload.expectedCwd : '');
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
  cleanupRecentSendRequests();
  if (clientRequestId) {
    const existing = recentSendRequests.get(clientRequestId);
    if (existing?.result) return json(res, 200, { ...existing.result, duplicate: true });
    if (existing?.watch) {
      return json(res, 200, {
        ok: true,
        duplicate: true,
        message: '这条发送请求已经被接收，正在继续等待 Codex 回复。',
        target,
        delivery: 'accepted',
        sentAt: existing.sentAt,
        watch: existing.watch,
      });
    }
  }
  let attachments = [];
  try {
    attachments = decodeAttachments(payload.attachments);
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_ATTACHMENT', message: error.message || '图片附件不正确。' });
  }
  if (!text.trim() && !attachments.length) {
    return json(res, 400, { ok: false, code: 'EMPTY_TEXT', message: '请输入文字或添加图片。' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json(res, 413, { ok: false, code: 'TEXT_TOO_LONG', message: `文字太长了，请控制在 ${MAX_TEXT_LENGTH} 字以内。` });
  }

  const mobileCommand = mobileComposerCommandForText(text);
  if (target === 'codex' && !attachments.length && mobileCommand) {
    try {
      invalidateCodexThreadListCache();
      const actionResult = await runCodexComposerAction(selectedThreadId, mobileCommand.action, mobileCommand.target);
      const result = {
        ok: true,
        ...actionResult,
        target,
        delivery: 'accepted',
        sentAt: new Date().toISOString(),
        attachments: [],
        watch: null,
      };
      if (clientRequestId) {
        recentSendRequests.set(clientRequestId, {
          createdAt: Date.now(),
          sentAt: result.sentAt,
          watch: null,
          result,
        });
      }
      invalidateCodexThreadListCache();
      return json(res, 200, result);
    } catch (error) {
      if (clientRequestId) recentSendRequests.delete(clientRequestId);
      if (error && error.status) {
        return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || 'Composer action failed.', detail: error.detail || '' });
      }
      const explained = explainTargetError(error, target);
      return json(res, 500, { ok: false, ...explained });
    }
  }

  try {
    invalidateCodexThreadListCache();
    const watchSince = new Date(Date.now() - 750).toISOString();
    const watchSinceMs = Date.parse(watchSince) || Date.now();
    const watchFile = expectNewThread ? null : selectedThreadId ? findCodexSessionFileByThreadId(selectedThreadId) : findLatestCodexSessionFile();
    let watch = target === 'codex' ? {
      since: watchSince,
      threadId: selectedThreadId,
      sessionFile: watchFile ? path.basename(watchFile) : '',
      expectNewThread,
      excludeThreadId: expectNewThread ? previousThreadId : '',
      cwd: expectNewThread ? expectedNewThreadCwd : '',
    } : null;
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: new Date().toISOString(),
        watch,
      });
    }
    await pasteAndEnter(text, target, attachments, selectedThreadId, { assumeThreadSynced, skipComposerClick: directPasteWithoutClick });
    if (expectNewThread && watch) {
      const newSessionFile = findCodexSessionFileForNewSend({
        sinceMs: watchSinceMs,
        text,
        cwd: expectedNewThreadCwd,
        excludeThreadId: previousThreadId,
      });
      if (newSessionFile) {
        watch = {
          ...watch,
          threadId: threadIdFromSessionFile(newSessionFile),
          sessionFile: path.basename(newSessionFile),
          expectNewThread: false,
          excludeThreadId: '',
        };
      }
    }
    const result = {
      ok: true,
      message: target === 'codex' ? '已切到 Codex，粘贴并按下回车。' : '已粘贴并按下回车。',
      target,
      delivery: 'accepted',
      sentAt: new Date().toISOString(),
      attachments: attachments.map(item => ({ name: item.name, size: item.size, type: item.mime })),
      watch,
    };
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: result.sentAt,
        watch,
        result,
      });
    }
    invalidateCodexThreadListCache();
    return json(res, 200, result);
  } catch (error) {
    if (clientRequestId) recentSendRequests.delete(clientRequestId);
    const explained = explainTargetError(error, target);
    return json(res, 500, { ok: false, ...explained });
  }
}

const staticAssetResponse = createStaticAssetResponder({ publicDir: PUBLIC_DIR, token: TOKEN });

function serveStatic(req, res) {
  const result = staticAssetResponse(req);
  res.writeHead(result.status, result.headers);
  res.end(req.method === 'HEAD' ? undefined : result.body);
}

function getLanApiBases() {
  return getLanApiBasesFromInterfaces(os.networkInterfaces(), PORT);
}

function sanitizeRouteBaseUrl(value, apiToken = '') {
  const text = redactToken(value || '', apiToken).trim();
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {}
  return '';
}

function sanitizeSakuraRoute(route, apiToken = '') {
  if (!route || typeof route !== 'object') return null;
  const baseUrl = sanitizeRouteBaseUrl(route.baseUrl, apiToken);
  if (!baseUrl) return null;
  return {
    id: String(route.id || ''),
    kind: String(route.kind || ''),
    label: String(route.label || ''),
    baseUrl,
    priority: Number.isFinite(Number(route.priority)) ? Number(route.priority) : 100,
    tunnelId: String(route.tunnelId || ''),
  };
}

function sanitizeSakuraTunnel(tunnel) {
  if (!tunnel || typeof tunnel !== 'object') return null;
  return {
    id: String(tunnel.id || ''),
    name: String(tunnel.name || ''),
    type: String(tunnel.type || ''),
    remote: String(tunnel.remote || ''),
    localIp: String(tunnel.localIp || ''),
    localPort: Number(tunnel.localPort) || 0,
    online: tunnel.online === true,
  };
}

function sanitizeSakuraRouteStatus(status, apiToken = '') {
  if (!status || typeof status !== 'object') return null;
  const route = sanitizeSakuraRoute(status.route, apiToken);
  const routes = (Array.isArray(status.routes) ? status.routes : [])
    .map(route => sanitizeSakuraRoute(route, apiToken))
    .filter(Boolean);
  const checkedAt = typeof status.checkedAt === 'string' ? status.checkedAt : '';
  return {
    ok: status.ok === true,
    configured: status.configured === true,
    routes,
    ...(route ? { route } : {}),
    ...(status.tunnel ? { tunnel: sanitizeSakuraTunnel(status.tunnel) } : {}),
    ...(status.code ? { code: String(status.code) } : {}),
    message: redactToken(status.message || '', apiToken),
    ...(checkedAt ? { checkedAt } : {}),
  };
}

function manualSakuraRouteFromConfig(config = {}) {
  const normalizedHost = normalizeSakuraRemoteHost(config.preferredDomain || '');
  const remotePort = Number(config.remotePort || 0);
  if (!normalizedHost || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    return null;
  }
  const raw = String(config.preferredDomain || '').trim();
  const scheme = /^http:\/\//i.test(raw) ? 'http' : 'https';
  const host = normalizedHost.replace(/:\d+$/, '');
  const baseUrl = `${scheme}://${host}:${remotePort}`;
  return {
    id: 'sakura-manual',
    kind: 'sakura',
    label: '远程链接',
    baseUrl,
    priority: 20,
    tunnelId: '',
  };
}

function checkRemoteRouteHealth(route, token = TOKEN, timeoutMs = SAKURA_HEALTH_TIMEOUT_MS) {
  return new Promise(resolve => {
    const baseUrl = sanitizeRouteBaseUrl(route && route.baseUrl);
    if (!baseUrl) return resolve({ ok: false, detail: '远程链接为空。' });
    let healthUrl;
    try {
      healthUrl = new URL('/codex/health', baseUrl);
      healthUrl.searchParams.set('token', token);
      healthUrl.searchParams.set('t', String(Date.now()));
    } catch (error) {
      return resolve({ ok: false, detail: error.message || '远程链接格式不正确。' });
    }
    const client = healthUrl.protocol === 'https:' ? https : http;
    const request = client.get(healthUrl, { timeout: timeoutMs }, response => {
      response.resume();
      response.on('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          detail: `HTTP ${response.statusCode}`,
        });
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, detail: '远程链接检查超时。' });
    });
    request.on('error', error => {
      resolve({ ok: false, detail: error && error.message || '远程链接不可访问。' });
    });
  });
}

async function getSakuraRouteResult(options = {}) {
  const now = Date.now();
  if (!options.force && sakuraRouteCache.result && now - sakuraRouteCache.at < SAKURA_ROUTE_CACHE_MS) {
    return sakuraRouteCache.result;
  }
  const state = readAppState();
  const route = state.sakura && state.sakura.enabled ? manualSakuraRouteFromConfig(state.sakura) : null;
  if (!route) {
    const result = sanitizeSakuraRouteStatus({
      ok: false,
      configured: false,
      routes: [],
      message: '远程链接未配置。',
    });
    sakuraRouteCache = { at: now, result };
    return result;
  }
  const health = await checkRemoteRouteHealth(route);
  if (!health.ok) {
    const result = sanitizeSakuraRouteStatus({
      ok: false,
      configured: true,
      route,
      routes: [],
      code: 'REMOTE_NETWORK_UNAVAILABLE',
      message: `${REMOTE_NETWORK_UNAVAILABLE_MESSAGE}${health.detail ? ` ${health.detail}` : ''}`,
      checkedAt: new Date().toISOString(),
    });
    sakuraRouteCache = { at: now, result };
    const nextState = readAppState();
    nextState.sakura = { ...nextState.sakura, lastStatus: result };
    writeAppState(nextState);
    return result;
  }
  const status = sanitizeSakuraRouteStatus({
    ok: true,
    configured: true,
    route,
    routes: [route],
    message: '远程链接可用。',
    checkedAt: new Date().toISOString(),
  });
  sakuraRouteCache = { at: now, result: status };
  const nextState = readAppState();
  nextState.sakura = { ...nextState.sakura, lastStatus: status };
  writeAppState(nextState);
  return status;
}

async function handleClientConfig(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const state = readAppState();
  const sakura = await getSakuraRouteResult();
  const configText = readCodexConfigText();
  const controlOverrides = state.controlOverrides || {};
  const configModel = modelInfoFromId(tomlStringValue(configText, 'model'));
  const configReasoning = reasoningModeFromValue(tomlStringValue(configText, 'model_reasoning_effort'));
  const configSpeed = speedModeFromValue(tomlStringValue(configText, 'service_tier'));
  const liveModeState = await readLiveCodexComposerModeState();
  const liveModel = liveModeState && liveModeState.model && liveModeState.model.available ? liveModeState.model : null;
  const liveReasoning = liveModeState && liveModeState.reasoningMode && liveModeState.reasoningMode.available ? liveModeState.reasoningMode : null;
  const liveSpeed = liveModeState && liveModeState.speedMode && liveModeState.speedMode.available ? liveModeState.speedMode : null;
  const currentModel = liveModel || controlOverrideModel(controlOverrides, configModel) || configModel;
  const currentReasoning = liveReasoning || controlOverrideReasoning(controlOverrides, configReasoning) || configReasoning;
  const currentSpeed = liveSpeed || controlOverrideSpeed(controlOverrides, configSpeed) || configSpeed;
  const speedSupported = codexModelSupportsSpeed(currentModel);
  const refreshModes = url.searchParams.get('refreshModes') === '1' || url.searchParams.get('modeOptions') === 'refresh';
  const liveModeOptions = refreshModes ? await readLiveCodexModeOptionsBounded({ force: true }) : cachedLiveModeOptions();
  const modelOptions = modelOptionsForClient(liveModeOptions);
  const reasoningOptions = liveModeOptions && Array.isArray(liveModeOptions.reasoningOptions) && liveModeOptions.reasoningOptions.length
    ? liveModeOptions.reasoningOptions
    : Object.values(REASONING_MODE_TARGETS);
  const speedOptions = resolveLiveSpeedOptions(speedSupported, currentSpeed, liveModeOptions);
  const localRoutes = [
    { id: 'desktop-local', kind: 'desktop-local', label: '本机', baseUrl: getDesktopLocalBase(PORT), priority: 0 },
    ...getLanApiBases().map((baseUrl, index) => ({ id: `lan-${index}`, kind: 'lan', label: '局域网', baseUrl, priority: 10 + index })),
  ];
  return json(res, 200, {
    ok: true,
    service: 'codex2frp',
    appName: APP_NAME,
    localOnly: false,
    routeProvider: sakura && sakura.ok ? 'sakura' : '',
    localApiBases: getLanApiBases(),
    apiRoutes: mergeRouteCandidates([...localRoutes, ...(sakura.routes || [])]),
    sakura: {
      configured: Boolean(sakura && sakura.configured),
      status: sakura,
    },
    controlPort: {
      host: CODEX_CDP_HOST,
      port: codexCdpPort,
      ready: Boolean(liveModeState),
      autoOpen: false,
      permissions: [
        '读取 Codex 当前模型、思考强度、速度按钮状态',
        '读取模型、思考强度、速度菜单候选项',
        '点击 Codex 菜单项完成模型、思考强度、速度切换',
        '向 Codex 输入框插入文字并点击发送按钮',
      ],
    },
    modelOptions,
    currentModel,
    currentReasoning,
    currentSpeed,
    speedSupported,
    reasoningOptions,
    speedOptions,
  });
}

function isLocalAddress(value) {
  const text = String(value || '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (text === '127.0.0.1' || text === '::1') return true;
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d*)$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function headerValues(value) {
  return Array.isArray(value) ? value : [value].filter(value => value !== undefined);
}

function splitHeaderList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeHostValue(value) {
  let text = String(value || '').trim().replace(/^"|"$/g, '');
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      text = new URL(text).host;
    } catch {
      return '';
    }
  }
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end >= 0 ? text.slice(1, end).toLowerCase() : '';
  }
  const colon = text.lastIndexOf(':');
  if (colon > -1 && text.indexOf(':') === colon && /^\d+$/.test(text.slice(colon + 1))) {
    text = text.slice(0, colon);
  }
  return text.toLowerCase().replace(/\.$/, '');
}

function isLocalHostValue(value) {
  const host = normalizeHostValue(value);
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || isLocalAddress(host)) return true;
  if (host.endsWith('.local')) return true;
  return /^[a-z0-9-]+$/i.test(host);
}

function forwardedHostValues(value) {
  const values = [];
  for (const item of headerValues(value)) {
    const text = String(item || '');
    const pattern = /(?:^|[;,])\s*host=(?:"([^"]+)"|([^;,]+))/gi;
    let match;
    while ((match = pattern.exec(text))) values.push((match[1] || match[2] || '').trim());
  }
  return values;
}

function forwardedForValues(value) {
  const values = [];
  for (const item of headerValues(value)) {
    const text = String(item || '');
    const pattern = /(?:^|[;,])\s*for=(?:"([^"]+)"|([^;,]+))/gi;
    let match;
    while ((match = pattern.exec(text))) values.push((match[1] || match[2] || '').trim());
  }
  return values;
}

function isLocalForwardedAddress(value) {
  const text = String(value || '').trim().replace(/^"|"$/g, '').replace(/^::ffff:/, '');
  if (!text || /^unknown$/i.test(text)) return true;
  return isLocalAddress(text);
}

function isLocalRequest(req) {
  if (!isLocalAddress(req.socket && req.socket.remoteAddress)) return false;
  const headers = req.headers || {};
  const hostValues = [
    ...headerValues(headers.host),
    ...headerValues(headers['x-forwarded-host']).flatMap(splitHeaderList),
    ...forwardedHostValues(headers.forwarded),
  ].filter(Boolean);
  if (!hostValues.length || hostValues.some(value => !isLocalHostValue(value))) return false;

  const forwardedAddresses = [
    ...headerValues(headers['x-forwarded-for']).flatMap(splitHeaderList),
    ...headerValues(headers['x-real-ip']).flatMap(splitHeaderList),
    ...forwardedForValues(headers.forwarded),
  ].filter(Boolean);
  return forwardedAddresses.every(isLocalForwardedAddress);
}

function sanitizeSakuraStatus(state) {
  const config = sanitizeSakuraConfig(state.sakura);
  return {
    configured: Boolean(config.enabled && config.configured),
    config,
    status: sanitizeSakuraRouteStatus(state.sakura && state.sakura.lastStatus),
  };
}

function normalizeSakuraRemoteHost(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let urlText = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlText)) urlText = `http://${urlText}`;
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  const host = String(parsed.hostname || '').trim().toLowerCase();
  if (!host || /\s/.test(host)) return '';
  if (parsed.pathname && parsed.pathname !== '/') return '';
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const domainPattern = new RegExp(`^${label}(?:\\.${label})*$`, 'i');
  const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (!domainPattern.test(host) && !ipv4Pattern.test(host) && host !== 'localhost') return '';
  return parsed.port ? `${host}:${parsed.port}` : host;
}

function normalizeSakuraRemoteAddressForStorage(value = '') {
  const raw = String(value || '').trim();
  const host = normalizeSakuraRemoteHost(raw);
  if (!host) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return host;
  try {
    const parsed = new URL(raw);
    const scheme = parsed.protocol === 'http:' ? 'http' : 'https';
    return `${scheme}://${host}`;
  } catch {
    return host;
  }
}

function validateSakuraFormPayload(payload = {}, previous = {}) {
  const errors = [];
  const preferredDomain = normalizeSakuraRemoteHost(payload.preferredDomain || '');
  const storedPreferredDomain = normalizeSakuraRemoteAddressForStorage(payload.preferredDomain || '');
  const remotePortText = String(payload.remotePort ?? '').trim();
  const managedTunnelIds = [];

  if (!preferredDomain) errors.push('远程地址不能为空；手动远程连接至少需要可访问的域名或节点地址。');
  if (payload.preferredDomain && !preferredDomain) errors.push('子域名或远程地址格式不正确；请填写域名、IP，或完整 http/https 地址，不要带路径。');
  if (!remotePortText) errors.push('远程端口不能为空；请填写远程服务分配的公网端口。');
  if (remotePortText && !/^[0-9]+$/.test(remotePortText)) errors.push('远程端口必须是 1-65535 的数字。');
  const remotePort = remotePortText ? Number(remotePortText) : 0;
  if (remotePortText && (remotePort < 1 || remotePort > 65535)) errors.push('远程端口必须在 1-65535 之间。');

  if (errors.length) {
    const error = new Error(`远程链接表单填写错误：${errors.join(' ')}`);
    error.status = 400;
    error.code = 'SAKURA_FORM_INVALID';
    error.details = errors;
    throw error;
  }

  return {
    apiToken: '',
    preferredDomain: storedPreferredDomain || preferredDomain,
    remotePort: remotePort || '',
    managedTunnelIds,
  };
}

function isSakuraStatusStale(status, maxAgeMs = SAKURA_STATUS_MAX_AGE_MS) {
  if (!status || typeof status !== 'object') return true;
  const checkedMs = Date.parse(status.checkedAt || '');
  if (!Number.isFinite(checkedMs)) return true;
  return Date.now() - checkedMs > maxAgeMs;
}

async function handleSakuraStatus(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let state = readAppState();
  const refreshMode = url.searchParams.get('refresh');
  const canRefresh = Boolean(state.sakura && state.sakura.enabled && manualSakuraRouteFromConfig(state.sakura));
  const shouldRefresh = canRefresh && (
    refreshMode === '1' ||
    (refreshMode !== '0' && isSakuraStatusStale(state.sakura.lastStatus))
  );
  if (shouldRefresh) {
    await getSakuraRouteResult({ force: true });
    state = readAppState();
  }
  return json(res, 200, { ok: true, ...sanitizeSakuraStatus(state) });
}

async function handleSakuraConfig(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (!isLocalRequest(req)) return json(res, 403, { ok: false, code: 'LOCAL_ONLY', message: '远程链接配置只能在本机或局域网内修改。' });
  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }
  const state = readAppState();
  let validated;
  try {
    validated = validateSakuraFormPayload(payload, state.sakura || {});
  } catch (error) {
    return json(res, error.status || 400, {
      ok: false,
      code: error.code || 'SAKURA_FORM_INVALID',
      message: error.message || '远程链接表单填写错误。',
      details: error.details || [],
    });
  }
  state.sakura = {
    ...state.sakura,
    enabled: payload.enabled !== false,
    apiBase: payload.apiBase || state.sakura.apiBase,
    apiToken: '',
    preferredDomain: validated.preferredDomain,
    remotePort: validated.remotePort,
    preferredTypes: Array.isArray(payload.preferredTypes) ? payload.preferredTypes : state.sakura.preferredTypes,
    preferredNodeId: payload.preferredNodeId || state.sakura.preferredNodeId,
    managedTunnelIds: validated.managedTunnelIds,
  };
  const saved = writeAppState(state);
  sakuraRouteCache = { at: 0, result: null };
  return json(res, 200, { ok: true, sakura: sanitizeSakuraConfig(saved.sakura) });
}

async function handleSakuraReconcile(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (!isLocalRequest(req)) return json(res, 403, { ok: false, code: 'LOCAL_ONLY', message: '远程链接配置只能在本机或局域网内刷新。' });
  const result = await getSakuraRouteResult({ force: true });
  return json(res, 200, { ok: true, result });
}

function handleHealth(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  return json(res, 200, {
    ok: true,
    service: 'codex2frp',
    host: os.hostname(),
    now: new Date().toISOString(),
  });
}

async function handleKeepAwake(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, ...keepAwakeStatus() });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const enabled = payload.enabled === true;
    const status = enabled ? startKeepAwake() : stopKeepAwake();
    return json(res, 200, {
      ok: true,
      ...status,
      message: status.enabled ? '已开启保持亮屏，Windows 不会自动休眠' : '已关闭保持亮屏',
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: error.code || 'KEEP_AWAKE_FAILED',
      message: error.message || '切换保持亮屏失败。',
    });
  }
}

function getLanUrls() {
  const urls = new Set([`${getDesktopLocalBase(PORT)}/?token=${TOKEN}`]);
  for (const base of getLanApiBases()) urls.add(`${base}/?token=${TOKEN}`);
  return [...urls];
}

async function warmCodexModeOptionsAfterStart() {
  const value = await readLiveCodexModeOptionsBounded({ force: true });
  const count = value && Array.isArray(value.modelOptions) ? value.modelOptions.length : 0;
  if (count > 0) {
    console.log(`Loaded ${count} Codex model option(s) from the client menu.`);
  } else {
    console.warn('Codex client model options were not available at startup; cached/local options will be used until the next refresh.');
  }
}

function handleRequestError(error, req, res) {
  console.error('Request handler failed:', error && error.stack || error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  json(res, 500, {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
  });
}

async function dispatchRequest(req, res) {
  if (req.method === 'OPTIONS') return options(res);
  if (req.method === 'GET' && req.url.startsWith('/codex/health')) return handleHealth(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/config')) return handleClientConfig(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/sakura/status')) return handleSakuraStatus(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/sakura/config')) return handleSakuraConfig(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/sakura/reconcile')) return handleSakuraReconcile(req, res);
  if (req.url.startsWith('/codex/sakura/discover')) return json(res, 404, { ok: false, code: 'NOT_FOUND', message: '远程链接自动检测已移除，请手动填写链接和端口。' });
  if (req.method === 'POST' && req.url.startsWith('/send')) return handleSend(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/threads')) return handleThreads(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/foreground-notices')) return handleForegroundNotices(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/history')) return handleThreadHistory(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/attachment')) return handleAttachment(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/status')) return handleCodexStatus(req, res);
  if ((req.method === 'GET' || req.method === 'POST') && req.url.startsWith('/codex/keep-awake')) return handleKeepAwake(req, res);
  if ((req.method === 'GET' || req.method === 'POST') && req.url.startsWith('/codex/control-port')) return handleControlPort(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/select')) return handleSelectThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/new-thread')) return handleNewCodexThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/thread-action')) return handleThreadAction(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/composer-plus-menu')) return handleComposerPlusMenu(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/composer-action')) return handleComposerAction(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/model-switch')) return handleModelSwitch(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/reasoning-mode')) return handleReasoningMode(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/speed-mode')) return handleSpeedMode(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/stop')) return handleStopCodex(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(dispatchRequest(req, res)).catch(error => handleRequestError(error, req, res));
});

server.listen(PORT, HOST, () => {
  const urls = getLanUrls();
  console.log('\nCodex2Frp is running.');
  console.log('Keep Codex2Frp running, then open one of these URLs in a phone or browser:');
  for (const url of urls) console.log(`  ${url}`);
  console.log('\nTip: use the same LAN for local access; use the remote URL for off-LAN access.\n');
  warmCodexModeOptionsAfterStart().catch(error => {
    console.warn('Codex client model option warm-up failed:', error && error.message || error);
  });
});

process.on('exit', cleanupKeepAwake);
process.on('SIGINT', () => {
  cleanupKeepAwake();
  stopPushWatchTimer();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupKeepAwake();
  stopPushWatchTimer();
  process.exit(143);
});
