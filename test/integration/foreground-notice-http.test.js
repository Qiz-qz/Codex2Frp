'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { ForegroundNoticeStore } = require('../../lib/foreground-notice-store');

test('foreground notice HTTP cursors are independent and survive a backend restart', async (t) => {
  const root = path.resolve(__dirname, '..', '..');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-notice-http-'));
  const codexHome = path.join(stateDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const token = 'notice-test-token';
  const file = path.join(stateDir, 'foreground-notices.json');
  const seeded = new ForegroundNoticeStore({ file });
  seeded.commitObservation([], Array.from({ length: 12 }, (_value, index) => ({
    eventKey: `thread-a:running:turn-${index + 1}:SECRET_${index + 1}`,
    status: 'running',
    message: `SECRET_BODY_${index + 1}`,
    threadId: 'thread-a',
    threadTitle: '通知测试',
    at: `2026-07-18T01:00:${String(index + 1).padStart(2, '0')}.000Z`,
  })));

  let child;
  t.after(() => {
    if (child && !child.killed) child.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const start = async () => {
    const port = await getFreePort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        MOBILE_TYPER_TOKEN: token,
        CODEX2FRP_STATE_DIR: stateDir,
        CODEX_HOME: codexHome,
        CODEX2FRP_CDP_AUTO_OPEN: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child.stdout, /Codex2Frp is running/);
    return port;
  };

  let port = await start();
  const firstA = await requestJson(port, `/codex/foreground-notices?token=${token}&cursor=0&noticeLimit=5`);
  const firstB = await requestJson(port, `/codex/foreground-notices?token=${token}&cursor=0&noticeLimit=5`);
  assert.equal(firstA.statusCode, 200);
  assert.deepEqual(firstA.body.notices.map(row => row.cursor), [1, 2, 3, 4, 5]);
  assert.deepEqual(firstB.body.notices, firstA.body.notices);
  assert.equal(firstA.body.hasMore, true);
  assert.equal(firstA.body.nextCursor, 5);
  assert.doesNotMatch(JSON.stringify(firstA.body), /SECRET_BODY|SECRET_/);
  const invalid = await requestJson(port, `/codex/foreground-notices?token=${token}&cursor=not-a-cursor`);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, 'BAD_NOTICE_CURSOR');

  child.kill();
  await onceExit(child);
  child = null;
  port = await start();
  const recovered = await requestJson(port, `/codex/foreground-notices?token=${token}&cursor=10&noticeLimit=5`);
  assert.deepEqual(recovered.body.notices.map(row => row.cursor), [11, 12]);
  assert.equal(recovered.body.nextCursor, 12);
  assert.equal(recovered.body.hasMore, false);

  const legacy = await requestJson(port, `/codex/foreground-notices?token=${token}`);
  assert.equal(legacy.statusCode, 200);
  assert.equal(Array.isArray(legacy.body.notices), true);
  assert.equal(typeof legacy.body.count, 'number');
  assert.equal(typeof legacy.body.nextCursor, 'number');
  assert.equal(legacy.body.cursorMode, false);
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function waitForOutput(stream, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error(`server output timeout: ${text}`)), 10000);
    stream.on('data', chunk => {
      text += chunk.toString();
      if (pattern.test(text)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function onceExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}
