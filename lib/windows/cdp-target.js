'use strict';

const EXPLICIT_MAIN_HINT_FIELDS = Object.freeze([
  'isMainWindow',
  'mainWindow',
  'isMain',
  'main',
]);

const IDENTITY_PATTERN = /(?:^|[^a-z0-9])(codex|chatgpt)(?:$|[^a-z0-9])/i;
const REJECTED_SURFACE_PATTERN = /devtools|overlay|quick[\s_-]*chat/i;
const REJECTED_URL_SCHEME_PATTERN = /^(?:about|devtools|chrome|chrome-extension|edge-extension|moz-extension|extension):/i;

function decodedText(value) {
  const text = String(value || '').trim();
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function hasDebuggerWebSocket(target) {
  const endpoint = String(target && target.webSocketDebuggerUrl || '').trim();
  if (!endpoint) return false;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}

function isRejectedSurface(target) {
  const title = decodedText(target && target.title);
  const url = decodedText(target && target.url);
  return REJECTED_URL_SCHEME_PATTERN.test(url)
    || REJECTED_SURFACE_PATTERN.test(title)
    || REJECTED_SURFACE_PATTERN.test(url);
}

function explicitMainTargetIds(options) {
  if (!Object.hasOwn(options || {}, 'mainTargetIds')) return null;
  const values = options.mainTargetIds;
  if (!values || typeof values[Symbol.iterator] !== 'function') return new Set();
  return new Set([...values].map(value => String(value)));
}

function hasExplicitMainHint(target, options = {}) {
  const hintedIds = explicitMainTargetIds(options);
  if (hintedIds) return hintedIds.has(String(target && target.id || ''));
  if (typeof options.isMainTarget === 'function' && options.isMainTarget(target) === true) return true;
  return EXPLICIT_MAIN_HINT_FIELDS.some(field => target && target[field] === true)
    || Boolean(target && target.metadata && target.metadata.isMainWindow === true);
}

function isCanonicalMainUrl(value) {
  const normalized = decodedText(value).toLowerCase().split('#', 1)[0].split('?', 1)[0];
  return normalized === 'app://-/index.html';
}

function identityScore(target) {
  const title = decodedText(target && target.title);
  const url = decodedText(target && target.url);
  let score = 0;
  if (/^(?:codex|chatgpt)$/i.test(title)) score += 100;
  else if (IDENTITY_PATTERN.test(title)) score += 60;
  if (IDENTITY_PATTERN.test(url)) score += 30;
  return score;
}

function candidateScore(target, options) {
  const explicitMain = hasExplicitMainHint(target, options);
  const canonicalMain = isCanonicalMainUrl(target && target.url);
  const identity = identityScore(target);
  if (!explicitMain && !canonicalMain && identity === 0) return null;
  return (explicitMain ? 1000 : 0) + (canonicalMain ? 500 : 0) + identity;
}

function selectCodexCdpTarget(targets, options = {}) {
  if (!Array.isArray(targets)) return null;
  const candidates = [];
  for (const target of targets) {
    if (!target || target.type !== 'page' || !hasDebuggerWebSocket(target) || isRejectedSurface(target)) continue;
    const score = candidateScore(target, options);
    if (score == null) continue;
    candidates.push({ target, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  return candidates[0].target;
}

module.exports = {
  selectCodexCdpTarget,
};
