'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  resolveStaticPath,
  createStaticAssetResponder,
  shouldCompress,
  chooseEncoding,
} = require('../lib/static-assets');

function tempPublic() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-public-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Codex2Frp</title>', 'utf8');
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([137, 80, 78, 71]));
  return dir;
}

test('resolveStaticPath blocks traversal outside public dir', () => {
  const dir = tempPublic();
  assert.equal(resolveStaticPath(dir, '/').relativePath, 'index.html');
  assert.equal(resolveStaticPath(dir, '/../server.js'), null);
});

test('resolveStaticPath blocks encoded traversal and malformed escapes', () => {
  const dir = tempPublic();
  assert.equal(resolveStaticPath(dir, '/%2e%2e/server.js'), null);
  assert.equal(resolveStaticPath(dir, '/..%5cserver.js'), null);
  assert.equal(resolveStaticPath(dir, '/%E0%A4%A'), null);
  assert.equal(resolveStaticPath(dir, '/C:/Windows/win.ini'), null);
});

test('compression applies only to text assets', () => {
  assert.equal(shouldCompress('.html', 2048), true);
  assert.equal(shouldCompress('.js', 2048), true);
  assert.equal(shouldCompress('.png', 2048), false);
  assert.equal(shouldCompress('.html', 20), false);
});

test('static responder returns etag and 304 for matching if-none-match', () => {
  const dir = tempPublic();
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const first = responder({
    method: 'GET',
    url: '/',
    headers: {},
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(first.headers.etag, /^W\//);

  const second = responder({
    method: 'GET',
    url: '/',
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(second.status, 304);
  assert.equal(second.body.length, 0);
});

test('static responder returns gzip body when negotiated', () => {
  const dir = tempPublic();
  const largeHtml = '<!doctype html>' + '<p>Hello</p>'.repeat(500);
  fs.writeFileSync(path.join(dir, 'index.html'), largeHtml, 'utf8');
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const result = responder({
    method: 'GET',
    url: '/',
    headers: { 'accept-encoding': 'gzip' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(result.body).toString('utf8'), largeHtml);
});

test('compressed revalidation preserves vary and omits content length', () => {
  const dir = tempPublic();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>' + '<p>Hello</p>'.repeat(500), 'utf8');
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const first = responder({
    method: 'GET',
    url: '/',
    headers: { 'accept-encoding': 'gzip' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], 'gzip');
  assert.equal(first.headers.vary, 'Accept-Encoding');

  const second = responder({
    method: 'GET',
    url: '/',
    headers: {
      'accept-encoding': 'gzip',
      'if-none-match': first.headers.etag,
    },
  });
  assert.equal(second.status, 304);
  assert.equal(second.headers.vary, 'Accept-Encoding');
  assert.equal(second.headers['content-length'], undefined);
  assert.equal(second.body.length, 0);
});

test('identity response for compressible asset preserves vary and content length', () => {
  const dir = tempPublic();
  const largeHtml = '<!doctype html>' + '<p>Hello</p>'.repeat(500);
  fs.writeFileSync(path.join(dir, 'index.html'), largeHtml, 'utf8');
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const first = responder({
    method: 'GET',
    url: '/',
    headers: { 'accept-encoding': 'identity' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], undefined);
  assert.equal(first.headers['content-length'], Buffer.byteLength(largeHtml));
  assert.equal(first.headers.vary, 'Accept-Encoding');

  const second = responder({
    method: 'GET',
    url: '/',
    headers: {
      'accept-encoding': 'identity',
      'if-none-match': first.headers.etag,
    },
  });
  assert.equal(second.status, 304);
  assert.equal(second.headers.vary, 'Accept-Encoding');
  assert.equal(second.headers['content-length'], undefined);
  assert.equal(second.body.length, 0);
});

test('token html response sets cookie and bypasses matching revalidation', () => {
  const dir = tempPublic();
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const first = responder({
    method: 'GET',
    url: '/',
    headers: {},
  });
  const result = responder({
    method: 'GET',
    url: '/?token=abc',
    headers: { 'if-none-match': first.headers.etag },
  });
  assert.equal(result.status, 200);
  assert.match(result.headers['set-cookie'], /codex2frpToken=abc/);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('chooseEncoding respects accepted q-values', () => {
  assert.equal(chooseEncoding('gzip;q=1, br;q=0.1', '.html', 2048), 'gzip');
});

test('chooseEncoding keeps explicit br rejection when wildcard is accepted', () => {
  assert.equal(chooseEncoding('br;q=0, *;q=1', '.html', 2048), 'gzip');
});

test('chooseEncoding keeps explicit gzip rejection when wildcard is accepted', () => {
  assert.equal(chooseEncoding('gzip;q=0, *;q=1', '.html', 2048), 'br');
});

test('chooseEncoding rejects all explicit exclusions even with wildcard', () => {
  assert.equal(chooseEncoding('br;q=0, gzip;q=0, *;q=1', '.html', 2048), '');
});

test('static responder returns empty body for head while preserving content length', () => {
  const dir = tempPublic();
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const result = responder({
    method: 'HEAD',
    url: '/',
    headers: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-length'], Buffer.byteLength('<!doctype html><title>Codex2Frp</title>'));
  assert.equal(result.body.length, 0);
});

test('webmanifest receives immutable cache policy', () => {
  const dir = tempPublic();
  fs.writeFileSync(path.join(dir, 'site.webmanifest'), '{"name":"Codex2Frp"}', 'utf8');
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const result = responder({
    method: 'GET',
    url: '/site.webmanifest',
    headers: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('pdf receives normal one-hour cache policy', () => {
  const dir = tempPublic();
  fs.writeFileSync(path.join(dir, 'guide.pdf'), Buffer.from('%PDF-1.7\n'));
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const result = responder({
    method: 'GET',
    url: '/guide.pdf',
    headers: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'public, max-age=3600');
});
