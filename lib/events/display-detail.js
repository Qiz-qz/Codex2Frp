'use strict';

const MAX_DISPLAY_DETAIL_CHARS = 1024;
const MAX_DISPLAY_DETAIL_INPUT_CHARS = 4096;
const MAX_DISPLAY_DETAILS = 32;
const MAX_DISPLAY_DETAILS_TOTAL_CHARS = 8192;
const SENSITIVE_KEY_FRAGMENTS = [
  'token', 'password', 'passwd', 'secret', 'credential',
  'apikey', 'api-key', 'api_key', 'privatekey', 'private-key', 'private_key',
  'accesskey', 'access-key', 'access_key', 'oauth2bearer', 'oauth2-bearer', 'oauth2_bearer',
];

function hasSensitiveAssignment(value) {
  const assignment = /\b([A-Za-z0-9_-]{1,128})\b\s*["']?\s*[:=]/g;
  let match = assignment.exec(value);
  while (match) {
    const key = String(match[1] || '').toLowerCase();
    if (key === 'authorization' || key === 'proxy-authorization' || key === 'cookie' ||
      key === 'pat' || key.endsWith('_pat') || key.endsWith('-pat') || key === 'sshpass' ||
      SENSITIVE_KEY_FRAGMENTS.some(fragment => key.includes(fragment))) return true;
    match = assignment.exec(value);
  }
  return false;
}

function hasUrlCredentials(value) {
  let marker = value.indexOf('://');
  while (marker >= 0) {
    const authorityStart = marker + 3;
    let authorityEnd = authorityStart;
    while (authorityEnd < value.length && !/[\s/\\;]/.test(value[authorityEnd])) authorityEnd += 1;
    const authority = value.slice(authorityStart, authorityEnd);
    const at = authority.indexOf('@');
    const colon = authority.indexOf(':');
    if (at > 0 && colon >= 0 && colon < at) return true;
    marker = value.indexOf('://', authorityEnd);
  }
  return false;
}

function safeDisplayDetail(value) {
  const compact = String(value || '').slice(0, MAX_DISPLAY_DETAIL_INPUT_CHARS)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Shell and PowerShell quoting permit spaces, nested maps and repeated
  // cookie fields. Trying to preserve part of a credential-bearing header is
  // unsafe, so publish only a neutral placeholder for the whole command.
  if (hasSensitiveAssignment(compact) || hasUrlCredentials(compact) ||
    /\bsshpass(?:\.exe)?\b[^;]{0,2048}\s-p(?:\s+|[^\s;]+)/i.test(compact)) return '<redacted command>';
  return compact
    .replace(/((?:--?)authorization(?:=|\s+))(?:(?:Bearer|Basic)\s+)?(?:(?:"[^"]*")|(?:'[^']*')|[^\s;]+)/gi, '$1<redacted>')
    .replace(/((?:^|\s)(?:-u|--user|--proxy-user)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s;]+)/gi, '$1<redacted>')
    .replace(/((?:^|\s)-u)(?:(?:"[^"]*")|(?:'[^']*')|[^\s;]+)/gi, '$1<redacted>')
    .replace(/((?:--?)(?:token|password|passwd|secret|credential|private[-_]?key|access[-_]?key|oauth2[-_]?bearer|api[-_]?key|pat)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s;]+)/gi, '$1<redacted>')
    .slice(0, MAX_DISPLAY_DETAIL_CHARS);
}

function safeDisplayDetails(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_DISPLAY_DETAILS) return [];
  if (values.some(value => typeof value !== 'string')) return [];
  const details = values.map(safeDisplayDetail);
  if (details.some(detail => !detail)) return [];
  const totalChars = details.reduce((total, detail) => total + detail.length, 0);
  return totalChars <= MAX_DISPLAY_DETAILS_TOTAL_CHARS ? details : [];
}

module.exports = {
  MAX_DISPLAY_DETAIL_CHARS,
  MAX_DISPLAY_DETAILS,
  MAX_DISPLAY_DETAILS_TOTAL_CHARS,
  safeDisplayDetail,
  safeDisplayDetails,
};
