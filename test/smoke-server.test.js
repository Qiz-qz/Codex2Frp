'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticAssetResponder } = require('../lib/static-assets');
const { getLanApiBasesFromInterfaces } = require('../lib/route-utils');

test('static responder can serve compressed index and reject traversal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>' + 'x'.repeat(2048), 'utf8');
  const responder = createStaticAssetResponder({ publicDir: dir, token: 'abc' });
  const ok = responder({ method: 'GET', url: '/?token=abc', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-encoding'], 'gzip');
  assert.equal(ok.headers['set-cookie'].includes('codex2frpToken=abc'), true);
  const blocked = responder({ method: 'GET', url: '/../server.js', headers: {} });
  assert.equal(blocked.status, 403);
});

test('route filter removes known bad Windows tunnel addresses', () => {
  const bases = getLanApiBasesFromInterfaces({
    ASUS: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '192.168.4.3', internal: false }],
    LinkLocal: [{ family: 'IPv4', address: '169.254.1.1', internal: false }],
  }, 8988);
  assert.deepEqual(bases, ['http://192.168.4.3:8988']);
});
