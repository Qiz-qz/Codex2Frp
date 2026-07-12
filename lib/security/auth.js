'use strict';

const crypto = require('node:crypto');

function extractBearerToken(headers = {}) {
  const value = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const match = String(value || '').match(/^Bearer[ \t]+([^ \t]+)$/i);
  return match ? match[1] : '';
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ''), 'utf8');
  const rightBytes = Buffer.from(String(right || ''), 'utf8');
  if (leftBytes.length !== rightBytes.length || leftBytes.length === 0) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

function queryToken(req) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function isAuthorizedRequest(req = {}, expectedToken, options = {}) {
  const headers = req.headers || {};
  const candidates = [extractBearerToken(headers)];
  if (options.allowLegacyHeader === true) candidates.push(headers['x-mobile-typer-token']);
  if (options.allowLegacyQuery === true) candidates.push(queryToken(req));
  if (options.allowLegacyCookie === true) candidates.push(cookieValue(headers.cookie, 'codex2frpToken'));
  return candidates.some(candidate => constantTimeEqual(candidate, expectedToken));
}

module.exports = {
  constantTimeEqual,
  cookieValue,
  extractBearerToken,
  isAuthorizedRequest,
};
