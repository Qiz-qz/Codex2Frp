'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const COMPRESS_THRESHOLD_BYTES = 1024;
const MAX_COMPRESSED_CACHE_ENTRIES = 32;
const MAX_COMPRESSED_CACHE_BYTES = 4 * 1024 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

const textExtensions = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.svg', '.txt']);
const longCacheExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg', '.webmanifest']);
const emptyBody = Buffer.alloc(0);
const compressedCache = new Map();
let compressedCacheBytes = 0;

function rawPathname(value) {
  const text = String(value || '/');
  const queryIndex = text.indexOf('?');
  const hashIndex = text.indexOf('#');
  let end = text.length;
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  if (hashIndex >= 0) end = Math.min(end, hashIndex);
  return text.slice(0, end) || '/';
}

function resolveStaticPath(publicDir, requestUrl) {
  const root = path.resolve(publicDir);
  let pathname = rawPathname(requestUrl);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  pathname = pathname.replace(/\\/g, '/');
  if (pathname === '/') pathname = '/index.html';

  const inputPath = pathname.replace(/^\/+/, '');
  const normalized = path.normalize(inputPath);
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    path.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return null;
  }

  const filePath = path.resolve(root, normalized);
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;

  return {
    filePath,
    relativePath: relativePath.split(path.sep).join('/'),
  };
}

function weakEtag(stat) {
  return `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
}

function shouldCompress(ext, size) {
  return textExtensions.has(String(ext || '').toLowerCase()) && Number(size) >= COMPRESS_THRESHOLD_BYTES;
}

function parseEncodingPreference(part) {
  const [name, ...params] = String(part || '').trim().toLowerCase().split(';');
  if (!name) return null;
  const qParam = params.map(value => value.trim()).find(value => value.startsWith('q='));
  const q = qParam ? Number(qParam.slice(2)) : 1;
  if (!Number.isFinite(q) || q < 0) return null;
  return { name, q: Math.min(q, 1) };
}

function chooseEncoding(acceptEncoding, ext, size) {
  if (ext !== undefined && size !== undefined && !shouldCompress(ext, size)) return '';
  const preferences = String(acceptEncoding || '')
    .split(',')
    .map(parseEncodingPreference)
    .filter(Boolean);
  const wildcard = preferences.find(item => item.name === '*');
  const candidates = ['br', 'gzip'].map(encoding => {
    const explicit = preferences.find(item => item.name === encoding);
    const preference = explicit || wildcard;
    return preference && preference.q > 0 ? { encoding, q: preference.q } : null;
  }).filter(Boolean);
  candidates.sort((a, b) => b.q - a.q || (a.encoding === 'br' ? -1 : 1));
  return candidates[0] ? candidates[0].encoding : '';
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const lowerName = name.toLowerCase();
  if (headers[lowerName] !== undefined) return headers[lowerName];
  if (headers[name] !== undefined) return headers[name];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return '';
}

function getSearchParam(requestUrl, name) {
  const text = String(requestUrl || '');
  const queryIndex = text.indexOf('?');
  if (queryIndex < 0) return '';
  const hashIndex = text.indexOf('#', queryIndex + 1);
  const query = text.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined);
  try {
    return new URLSearchParams(query).get(name) || '';
  } catch {
    return '';
  }
}

function hasMatchingIfNoneMatch(headerValue, etag) {
  return String(headerValue || '')
    .split(',')
    .some(value => {
      const candidate = value.trim();
      return candidate === etag || candidate === '*';
    });
}

function cacheControlFor(ext, isSettingTokenCookie) {
  if (isSettingTokenCookie) return 'no-store';
  if (ext === '.html') return 'no-cache';
  if (longCacheExtensions.has(ext)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

function textResponse(status, text, method) {
  const body = Buffer.from(text);
  return {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    },
    body: method === 'HEAD' ? emptyBody : body,
  };
}

function getCompressedCache(key) {
  const entry = compressedCache.get(key);
  if (!entry) return null;
  compressedCache.delete(key);
  compressedCache.set(key, entry);
  return entry;
}

function setCompressedCache(key, body) {
  if (body.length > MAX_COMPRESSED_CACHE_BYTES) return body;
  const existing = compressedCache.get(key);
  if (existing) {
    compressedCacheBytes -= existing.length;
    compressedCache.delete(key);
  }
  while (
    compressedCache.size >= MAX_COMPRESSED_CACHE_ENTRIES ||
    compressedCacheBytes + body.length > MAX_COMPRESSED_CACHE_BYTES
  ) {
    const firstKey = compressedCache.keys().next().value;
    if (firstKey === undefined) break;
    const firstBody = compressedCache.get(firstKey);
    compressedCacheBytes -= firstBody ? firstBody.length : 0;
    compressedCache.delete(firstKey);
  }
  compressedCache.set(key, body);
  compressedCacheBytes += body.length;
  return body;
}

function compressBody(filePath, etag, encoding, body) {
  const key = `${encoding}:${etag}:${filePath}`;
  const cached = getCompressedCache(key);
  if (cached) return cached;
  const compressed = encoding === 'br'
    ? zlib.brotliCompressSync(body)
    : zlib.gzipSync(body);
  return setCompressedCache(key, compressed);
}

function createStaticAssetResponder({ publicDir, token }) {
  const root = path.resolve(publicDir);
  const expectedToken = String(token || '');

  return function staticAssetResponder(req = {}) {
    const resolved = resolveStaticPath(root, req.url || '/');
    if (!resolved) return textResponse(403, 'Forbidden', req.method);

    let stat;
    try {
      stat = fs.statSync(resolved.filePath);
    } catch {
      return textResponse(404, 'Not found', req.method);
    }
    if (!stat.isFile()) return textResponse(404, 'Not found', req.method);

    const ext = path.extname(resolved.filePath).toLowerCase();
    const etag = weakEtag(stat);
    const isSettingTokenCookie = (
      ext === '.html' &&
      expectedToken &&
      getSearchParam(req.url, 'token') === expectedToken
    );
    const canCompress = shouldCompress(ext, stat.size);
    const encoding = canCompress ? chooseEncoding(getHeader(req.headers, 'accept-encoding')) : '';
    const headers = {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': cacheControlFor(ext, isSettingTokenCookie),
    };
    if (canCompress) headers.vary = 'Accept-Encoding';

    if (isSettingTokenCookie) {
      headers['set-cookie'] = `codex2frpToken=${encodeURIComponent(expectedToken)}; Path=/; SameSite=Lax; Max-Age=31536000`;
    } else {
      headers.etag = etag;
    }

    if (!isSettingTokenCookie && hasMatchingIfNoneMatch(getHeader(req.headers, 'if-none-match'), etag)) {
      return {
        status: 304,
        headers: {
          'cache-control': headers['cache-control'],
          etag,
          ...(headers.vary ? { vary: headers.vary } : {}),
        },
        body: emptyBody,
      };
    }

    let body;
    try {
      body = fs.readFileSync(resolved.filePath);
    } catch {
      return textResponse(404, 'Not found', req.method);
    }

    if (encoding) {
      body = compressBody(resolved.filePath, etag, encoding, body);
      headers['content-encoding'] = encoding;
    }

    headers['content-length'] = body.length;
    return {
      status: 200,
      headers,
      body: req.method === 'HEAD' ? emptyBody : body,
    };
  };
}

module.exports = {
  mimeTypes,
  resolveStaticPath,
  weakEtag,
  shouldCompress,
  chooseEncoding,
  createStaticAssetResponder,
};
