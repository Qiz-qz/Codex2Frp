'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readState } = require('../lib/state-store');

test('Sakura config endpoint ignores API tokens and user-facing tunnel ids', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-server-state-'));
  const port = await getFreePort();
  const token = 'test-token';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_SAKURA_CACHE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForOutput(server.stdout, /Codex2Frp is running/);

  const response = await requestJson({
    method: 'POST',
    port,
    path: `/codex/sakura/config?token=${encodeURIComponent(token)}`,
    body: {
      enabled: true,
      apiBase: 'https://api.natfrp.com/v4',
      apiToken: 'secret',
      preferredDomain: 'codexhm-demo.nyat.app',
      remotePort: 28815,
      managedTunnelIds: ['26632383'],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const state = readState(path.join(stateDir, 'state.json'));
  assert.equal(state.sakura.remotePort, 28815);
  assert.equal(state.sakura.apiToken, '');
  assert.deepEqual(state.sakura.managedTunnelIds, []);
});

test('Sakura config endpoint accepts manual host and port without API token', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-server-state-'));
  const port = await getFreePort();
  const remotePort = await getFreePort();
  const token = 'test-token';
  const remoteServer = http.createServer((req, res) => {
    if (req.url.startsWith('/codex/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(remoteServer, remotePort);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_SAKURA_CACHE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
    remoteServer.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForOutput(server.stdout, /Codex2Frp is running/);

  const response = await requestJson({
    method: 'POST',
    port,
    path: `/codex/sakura/config?token=${encodeURIComponent(token)}`,
    body: {
      enabled: true,
      apiBase: 'https://api.natfrp.com/v4',
      apiToken: '',
      preferredDomain: 'http://127.0.0.1',
      remotePort,
      managedTunnelIds: ['ignored-now'],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const state = readState(path.join(stateDir, 'state.json'));
  assert.equal(state.sakura.apiToken, '');
  assert.equal(state.sakura.preferredDomain, 'http://127.0.0.1');
  assert.equal(state.sakura.remotePort, remotePort);
  assert.deepEqual(state.sakura.managedTunnelIds, []);

  const config = await requestJson({
    method: 'GET',
    port,
    path: `/codex/config?token=${encodeURIComponent(token)}`,
  });
  assert.equal(config.statusCode, 200);
  assert.equal(config.body.sakura.configured, true);
  assert.equal(config.body.routeProvider, 'sakura');
  assert.ok(config.body.apiRoutes.some(route => route.kind === 'sakura' && route.baseUrl === `http://127.0.0.1:${remotePort}`));
});

test('remote route status reports unavailable when configured health endpoint is unreachable', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-server-state-'));
  const port = await getFreePort();
  const remotePort = await getFreePort();
  const token = 'test-token';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_SAKURA_CACHE_MS: '1',
      CODEX2FRP_SAKURA_HEALTH_TIMEOUT_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForOutput(server.stdout, /Codex2Frp is running/);

  const save = await requestJson({
    method: 'POST',
    port,
    path: `/codex/sakura/config?token=${encodeURIComponent(token)}`,
    body: {
      enabled: true,
      apiBase: 'https://api.natfrp.com/v4',
      preferredDomain: '127.0.0.1',
      remotePort,
      managedTunnelIds: [],
    },
  });
  assert.equal(save.statusCode, 200);

  const status = await requestJson({
    method: 'GET',
    port,
    path: `/codex/sakura/status?refresh=1&token=${encodeURIComponent(token)}`,
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.status.ok, false);
  assert.equal(status.body.status.code, 'REMOTE_NETWORK_UNAVAILABLE');
  assert.match(status.body.status.message, /远程连接网络未启动，当前仅支持局域网连接。/);
});

test('Sakura auto-detect endpoint is removed', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-server-state-'));
  const port = await getFreePort();
  const token = 'test-token';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_SAKURA_CACHE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForOutput(server.stdout, /Codex2Frp is running/);

  const response = await requestJson({
    method: 'POST',
    port,
    path: `/codex/sakura/discover?token=${encodeURIComponent(token)}`,
    body: { apiToken: 'secret' },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.code, 'NOT_FOUND');
});

test('Sakura config endpoint rejects malformed remote form fields', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-server-state-'));
  const port = await getFreePort();
  const token = 'test-token';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_SAKURA_CACHE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForOutput(server.stdout, /Codex2Frp is running/);

  const response = await requestJson({
    method: 'POST',
    port,
    path: `/codex/sakura/config?token=${encodeURIComponent(token)}`,
    body: {
      enabled: true,
      apiBase: 'https://api.natfrp.com/v4',
      apiToken: '',
      preferredDomain: 'https://bad host/path',
      remotePort: '99999',
      managedTunnelIds: ['26632383'],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'SAKURA_FORM_INVALID');
  assert.match(response.body.message, /远程链接/);

  const state = readState(path.join(stateDir, 'state.json'));
  assert.equal(state.sakura.apiToken, '');
  assert.equal(state.sakura.preferredDomain, '');
  assert.equal(state.sakura.remotePort, 0);
});

async function spawnTestServer(t, env = {}) {
  const repoRoot = path.resolve(__dirname, '..');
  const port = await getFreePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    server.kill();
  });
  return { server, port };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function waitForOutput(stream, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 8000);
    stream.on('data', chunk => {
      text += chunk.toString('utf8');
      if (pattern.test(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    stream.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function requestJson({ method, port, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
