'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  detectCodexCliVersion,
  discoverCodexExecutable,
  profileFileForCliVersion,
} = require('../../lib/app-server/discovery');
const { AppServerProcessManager } = require('../../lib/app-server/process-manager');
const { AppServerRuntime } = require('../../lib/app-server/runtime');
const { loadSchemaProfile } = require('../../lib/app-server/schema-profile');
const { createProtectedThreadGuard } = require('../../lib/control/protected-thread-guard');
const { classifyCodexServiceError } = require('../../lib/codex/codex-service');

const live = process.env.CODEX2FRP_LIVE_APP_SERVER === '1';

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, route, token = '', options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: options.method || 'GET',
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function waitForLine(stream, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${text}`)), timeoutMs);
    stream.on('data', chunk => {
      text += chunk.toString('utf8');
      if (pattern.test(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

function waitForManagerExit(manager, timeoutMs = 10000) {
  if (!manager.ownedPid) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    manager.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    manager.once('processError', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = target => {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(target); } catch {}
      for (const name of names) makeWritable(path.join(target, name));
    }
    try { fs.chmodSync(target, 0o700); } catch {}
  };
  makeWritable(root);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const resolved = path.resolve(root);
    const safePrefix = path.resolve(os.tmpdir(), 'codex2frp-live-write-');
    if (process.platform !== 'win32' || !resolved.startsWith(safePrefix)) throw error;
    for (let attempt = 0; attempt < 8 && fs.existsSync(resolved); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {}
    }
    if (!fs.existsSync(resolved)) return;
    const cleanup = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Remove-Item -LiteralPath $env:CODEX2FRP_CLEANUP_TARGET -Recurse -Force',
    ], {
      env: { ...process.env, CODEX2FRP_CLEANUP_TARGET: resolved },
      windowsHide: true,
      stdio: 'ignore',
    });
    if (cleanup.status !== 0 || fs.existsSync(resolved)) throw error;
  }
}

function treeContains(root, needle) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.name.includes(needle)) return true;
    if (entry.isDirectory() && treeContains(path.join(root, entry.name), needle)) return true;
  }
  return false;
}

async function waitForCondition(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return condition();
}

test('current Codex app-server initializes and lists only an isolated CODEX_HOME', { skip: !live }, async () => {
  const executable = discoverCodexExecutable();
  const cliVersion = detectCodexCliVersion(executable);
  const profileFile = profileFileForCliVersion(cliVersion);
  assert.ok(executable, 'a runnable bundled Codex CLI was discovered');
  assert.ok(cliVersion, 'the current CLI version was detected');
  assert.ok(profileFile, `a schema profile exists for ${cliVersion}`);

  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-live-app-server-'));
  const manager = new AppServerProcessManager({
    command: executable,
    requestTimeoutMs: 15000,
  });
  const runtime = new AppServerRuntime({
    processManager: manager,
    schemaProfile: loadSchemaProfile(profileFile),
    codexHome,
    protectedThreadGuard: createProtectedThreadGuard(),
    initializeParams: {
      clientInfo: { name: 'codex2frp-live-smoke', title: 'Codex2Frp live smoke', version: 'test' },
      capabilities: { experimentalApi: true },
    },
    backendVersion: 'test',
    cliVersion,
  });

  try {
    const result = await runtime.withService(service => service.listThreads({ limit: 5 }));
    assert.ok(result && typeof result === 'object', 'thread/list returned an object');
    const rows = Array.isArray(result.data) ? result.data : (Array.isArray(result.threads) ? result.threads : []);
    assert.deepEqual(rows, [], 'the isolated CODEX_HOME contains no user tasks');
    assert.equal(runtime.getMeta().appServer.state, 'ready');
  } finally {
    runtime.stop('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('current Codex app-server mutates only a disposable isolated task', { skip: !live }, async () => {
  const executable = discoverCodexExecutable();
  const cliVersion = detectCodexCliVersion(executable);
  const profileFile = profileFileForCliVersion(cliVersion);
  assert.ok(executable && cliVersion && profileFile);

  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-live-write-'));
  const codexHome = path.join(isolatedRoot, 'codex-home');
  const workspace = path.join(isolatedRoot, 'workspace');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const liveAuthSource = String(process.env.CODEX2FRP_LIVE_AUTH_SOURCE || '').trim();
  if (liveAuthSource) {
    const resolvedAuthSource = path.resolve(liveAuthSource);
    assert.equal(fs.statSync(resolvedAuthSource).isFile(), true, 'live auth source is a file');
    fs.copyFileSync(resolvedAuthSource, path.join(codexHome, 'auth.json'));
  }
  const manager = new AppServerProcessManager({ command: executable, requestTimeoutMs: 20000 });
  const notificationMethods = [];
  const runtime = new AppServerRuntime({
    processManager: manager,
    schemaProfile: loadSchemaProfile(profileFile),
    codexHome,
    protectedThreadGuard: createProtectedThreadGuard(),
    initializeParams: {
      clientInfo: { name: 'codex2frp-live-write', title: 'Codex2Frp isolated write', version: 'test' },
      capabilities: { experimentalApi: true },
    },
    backendVersion: 'test',
    cliVersion,
    notificationSink(notification) {
      notificationMethods.push(String(notification && notification.method || ''));
    },
  });

  try {
    await runtime.withService(async service => {
      const started = await service.startThread({
        cwd: workspace,
        ephemeral: false,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sessionStartSource: 'startup',
      });
      const thread = started && started.thread || started;
      const threadId = String(thread && (thread.id || thread.threadId) || '');
      assert.match(threadId, /^[a-f0-9-]{32,}$/i, 'isolated thread/start returns an id');

      // This must remain the first RPC after thread/start. A read or rename here masks
      // the materialization race exercised by the mobile new-thread send path.
      const turnStarted = await service.startTurn({
        threadId,
        input: [{
          type: 'text',
          text: 'Isolated acceptance task. Output exactly 500 numbered lines, one line at a time, and do not inspect or modify files.',
        }],
        clientUserMessageId: 'isolated-start-1',
      });
      const turn = turnStarted && turnStarted.turn || turnStarted;
      const turnId = String(turn && (turn.id || turn.turnId) || '');
      assert.ok(turnId, 'isolated turn/start returns an active turn id');
      assert.equal(await waitForCondition(
        () => notificationMethods.includes('turn/started'),
        5000,
      ), true, 'isolated turn/start becomes active before steering');
      await service.steerTurn({
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: 'Reply exactly ISOLATED_STEER_OK.' }],
        clientUserMessageId: 'isolated-steer-1',
      });
      await service.interruptTurn({ threadId, turnId });

      await service.setThreadName({ threadId, name: 'Codex2Frp isolated acceptance' });
      const renamed = await service.readThread({ threadId, includeTurns: true });
      assert.equal(String(renamed.thread && renamed.thread.id || ''), threadId);
      assert.equal(String(renamed.thread && (renamed.thread.name || renamed.thread.title) || ''), 'Codex2Frp isolated acceptance');

      await service.archiveThread({ threadId });
      assert.equal(await waitForCondition(() => treeContains(
        path.join(codexHome, 'archived_sessions'),
        threadId,
      )), true, 'archive moves only the isolated task into isolated archived_sessions');
      await new Promise(resolve => setTimeout(resolve, 600));
      try {
        await service.unarchiveThread({ threadId });
      } catch (error) {
        const classified = classifyCodexServiceError(error, { mutation: true });
        assert.equal(classified.uncertain, true, 'current post-mutation readback failure is classified uncertain');
      }
      assert.equal(await waitForCondition(() => treeContains(
        path.join(codexHome, 'sessions'),
        threadId,
      )), true, 'unarchive restores only the isolated task');
    });
  } finally {
    runtime.stop('SIGTERM');
    await waitForManagerExit(manager);
    await new Promise(resolve => setTimeout(resolve, 1500));
    removeWritableTree(isolatedRoot);
  }
});

test('authenticated v3 HTTP surface stays lazy and reads only an isolated CODEX_HOME', { skip: !live }, async (t) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-live-http-'));
  const codexHome = path.join(isolatedRoot, 'codex-home');
  const stateDir = path.join(isolatedRoot, 'state');
  fs.mkdirSync(codexHome, { recursive: true });
  const port = await freePort();
  const token = 'isolated-live-smoke-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_HOME: codexHome,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_PROTECTED_THREAD_IDS: '11111111-2222-4333-8444-555555555555',
      MOBILE_TYPER_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });
  await waitForLine(child.stdout, /Codex2Frp is running/);

  const unauthorized = await requestJson(port, '/codex/v3/meta');
  assert.equal(unauthorized.statusCode, 401);

  const metaBefore = await requestJson(port, '/codex/v3/meta', token);
  assert.equal(metaBefore.statusCode, 200, stderr);
  assert.equal(metaBefore.body.appServer.state, 'stopped', 'metadata does not start app-server');

  const diagnostics = await requestJson(port, '/codex/v3/diagnostics', token);
  assert.equal(diagnostics.statusCode, 200, stderr);
  assert.equal(diagnostics.body.appServer.state, 'stopped', 'diagnostics remains lazy');
  assert.equal(JSON.stringify(diagnostics.body).includes(token), false, 'diagnostics never echo credentials');

  const threads = await requestJson(port, '/codex/v3/threads?limit=5', token);
  assert.equal(threads.statusCode, 200, stderr);
  const rows = Array.isArray(threads.body.data)
    ? threads.body.data
    : (Array.isArray(threads.body.threads) ? threads.body.threads : []);
  assert.deepEqual(rows, [], 'HTTP thread list sees only the isolated empty CODEX_HOME');

  const metaAfter = await requestJson(port, '/codex/v3/meta', token);
  assert.equal(metaAfter.body.appServer.state, 'ready');
});

test('authenticated v3 HTTP creates, queues, and immediately starts an isolated first turn', { skip: !live }, async (t) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-live-http-write-'));
  const codexHome = path.join(isolatedRoot, 'codex-home');
  const workspace = path.join(isolatedRoot, 'workspace');
  const stateDir = path.join(isolatedRoot, 'state');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const authSource = path.resolve(String(process.env.CODEX2FRP_LIVE_AUTH_SOURCE || ''));
  assert.equal(fs.statSync(authSource).isFile(), true, 'live auth source is a file');
  fs.copyFileSync(authSource, path.join(codexHome, 'auth.json'));
  const port = await freePort();
  const token = 'isolated-live-http-write-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_HOME: codexHome,
      CODEX2FRP_STATE_DIR: stateDir,
      CODEX2FRP_APP_SERVER_REQUEST_TIMEOUT_MS: '10000',
      MOBILE_TYPER_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });
  await waitForLine(child.stdout, /Codex2Frp is running/);

  const created = await requestJson(port, '/codex/v3/threads', token, {
    method: 'POST',
    body: { params: { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' } },
  });
  assert.equal(created.statusCode, 201, stderr);
  const thread = created.body && created.body.thread || created.body;
  const threadId = String(thread && (thread.id || thread.threadId) || '');
  assert.ok(threadId, 'HTTP thread/start returns an id');

  const queued = await requestJson(port, `/codex/v3/threads/${threadId}/queue`, token, {
    method: 'POST',
    body: { clientRequestId: 'isolated-http-first', text: 'Reply exactly ISOLATED_HTTP_OK.' },
  });
  assert.equal(queued.statusCode, 202, stderr);
  assert.equal(queued.body.item.state, 'queued', JSON.stringify(queued.body));
  const listedBeforeFlush = await requestJson(port, `/codex/v3/threads/${threadId}/queue`, token);
  assert.equal(listedBeforeFlush.body.items[0].state, 'queued', JSON.stringify(listedBeforeFlush.body));
  const flushed = await requestJson(port, `/codex/v3/threads/${threadId}/queue/flush`, token, {
    method: 'POST',
    body: {},
  });

  assert.equal(flushed.statusCode, 200, stderr);
  assert.ok(flushed.body.item, `${JSON.stringify(flushed.body)}\n${stderr}`);
  assert.equal(flushed.body.item.state, 'accepted');
  assert.ok(flushed.body.item.turnId);
});
