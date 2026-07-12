'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  JsonlRpcClient,
} = require('../lib/app-server/jsonl-rpc-client');
const {
  AppServerProcessManager,
  DEFAULT_APP_SERVER_ARGS,
} = require('../lib/app-server/process-manager');

function createRpcHarness(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes = [];
  input.setEncoding('utf8');
  input.on('data', chunk => writes.push(chunk));
  const client = new JsonlRpcClient({
    input,
    output,
    connectionEpoch: options.connectionEpoch ?? 1,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
  });
  return { client, input, output, writes };
}

function parseWrite(writes, index = 0) {
  return JSON.parse(writes[index].trim());
}

function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('JSONL RPC accepts fragmented lines and emits notifications separately from responses', async () => {
  const { client, output, writes } = createRpcHarness({ connectionEpoch: 4 });
  const notificationPromise = once(client, 'notification');
  const responsePromise = client.request('thread/list', { limit: 10 });
  const request = parseWrite(writes);

  assert.deepEqual(request, {
    jsonrpc: '2.0',
    id: '4:1',
    method: 'thread/list',
    params: { limit: 10 },
  });

  output.write('{"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"t');
  output.write('1","status":{"type":"idle"}}}\r\n');
  output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { data: ['t1'] } })}\n`);

  const [notification] = await notificationPromise;
  assert.deepEqual(notification, {
    method: 'thread/status/changed',
    params: { threadId: 't1', status: { type: 'idle' } },
    connectionEpoch: 4,
    sequence: 1,
  });
  assert.deepEqual(await responsePromise, { data: ['t1'] });
  client.close();
});

test('method plus id is a server request and can be answered exactly once', async () => {
  const { client, output, writes } = createRpcHarness({ connectionEpoch: 4 });
  const lateResponses = [];
  client.on('lateResponse', response => lateResponses.push(response));
  const serverRequestPromise = once(client, 'serverRequest', { signal: AbortSignal.timeout(250) });
  output.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 17,
    method: 'item/tool/requestUserInput',
    params: { syntheticQuestion: 'fixture-only' },
  })}\n`);

  const [serverRequest] = await serverRequestPromise;
  assert.deepEqual(serverRequest, {
    id: 17,
    method: 'item/tool/requestUserInput',
    params: { syntheticQuestion: 'fixture-only' },
    connectionEpoch: 4,
  });
  assert.deepEqual(lateResponses, []);

  client.respondServerRequest(17, { answers: ['accepted'] }, { connectionEpoch: 4 });
  assert.deepEqual(parseWrite(writes), {
    jsonrpc: '2.0',
    id: 17,
    result: { answers: ['accepted'] },
  });
  assert.throws(
    () => client.respondServerRequest(17, { answers: ['duplicate'] }, { connectionEpoch: 4 }),
    error => error && error.code === 'APP_SERVER_PROTOCOL_ERROR'
      && JSON.stringify(error.details).includes('fixture-only') === false,
  );
  assert.equal(writes.length, 1);
  client.close();
});

test('server request responses reject unknown ids, stale epochs, and closed clients', async () => {
  const { client, output, writes } = createRpcHarness({ connectionEpoch: 9 });
  const serverRequestPromise = once(client, 'serverRequest', { signal: AbortSignal.timeout(250) });
  output.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'server-request-private',
    method: 'item/permissions/requestApproval',
    params: { syntheticPermission: 'fixture-only' },
  })}\n`);
  await serverRequestPromise;

  assert.throws(
    () => client.respondServerRequest(
      'server-request-private', { decision: 'accept' }, { connectionEpoch: 8 },
    ),
    error => error && error.code === 'APP_SERVER_CONNECTION_CLOSED'
      && JSON.stringify(error.details).includes('server-request-private') === false,
  );
  assert.throws(
    () => client.respondServerRequest('unknown-request', {}, { connectionEpoch: 9 }),
    error => error && error.code === 'APP_SERVER_PROTOCOL_ERROR'
      && JSON.stringify(error.details).includes('unknown-request') === false,
  );
  assert.equal(writes.length, 0);

  client.close();
  assert.throws(
    () => client.respondServerRequest(
      'server-request-private', { decision: 'accept' }, { connectionEpoch: 9 },
    ),
    error => error && error.code === 'APP_SERVER_CONNECTION_CLOSED',
  );
  assert.equal(writes.length, 0);
});

test('JSONL RPC correlates out-of-order responses and preserves remote errors', async () => {
  const { client, output, writes } = createRpcHarness();
  const first = client.request('thread/read', { threadId: 't1' });
  const second = client.request('turn/steer', { threadId: 't1', expectedTurnId: 'turn-1', input: [] });
  const firstRequest = parseWrite(writes, 0);
  const secondRequest = parseWrite(writes, 1);

  output.write(`${JSON.stringify({ jsonrpc: '2.0', id: secondRequest.id, result: { turnId: 'turn-1' } })}\n`);
  output.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: firstRequest.id,
    error: { code: -32001, message: 'read failed', data: { kind: 'temporary' } },
  })}\n`);

  assert.deepEqual(await second, { turnId: 'turn-1' });
  await assert.rejects(first, error => {
    assert.equal(error.code, 'APP_SERVER_RPC_ERROR');
    assert.equal(error.rpcCode, -32001);
    assert.deepEqual(error.rpcData, { kind: 'temporary' });
    return true;
  });
  client.close();
});

test('JSONL RPC sends initialized and other client notifications without request ids', () => {
  const { client, writes } = createRpcHarness({ connectionEpoch: 5 });
  client.notify('initialized');
  assert.deepEqual(parseWrite(writes), {
    jsonrpc: '2.0',
    method: 'initialized',
  });
  client.close();
});

test('timed-out requests are removed and late responses cannot settle a later request', async () => {
  const { client, output, writes } = createRpcHarness({ connectionEpoch: 8, requestTimeoutMs: 15 });
  const timedOut = client.request('thread/read', { threadId: 'slow' });
  const timedOutRequest = parseWrite(writes, 0);

  await assert.rejects(timedOut, error => {
    assert.equal(error.code, 'APP_SERVER_RPC_TIMEOUT');
    assert.equal(error.details.method, 'thread/read');
    assert.equal(error.details.connectionEpoch, 8);
    return true;
  });

  const lateResponsePromise = once(client, 'lateResponse');
  output.write(`${JSON.stringify({ jsonrpc: '2.0', id: timedOutRequest.id, result: { stale: true } })}\n`);
  const [late] = await lateResponsePromise;
  assert.equal(late.id, '8:1');
  assert.equal(late.connectionEpoch, 8);

  const current = client.request('thread/read', { threadId: 'current' });
  const currentRequest = parseWrite(writes, 1);
  assert.equal(currentRequest.id, '8:2');
  output.write(`${JSON.stringify({ jsonrpc: '2.0', id: currentRequest.id, result: { threadId: 'current' } })}\n`);
  assert.deepEqual(await current, { threadId: 'current' });
  client.close();
});

test('process exit rejects every in-flight request and closes the connection epoch', async () => {
  const { client } = createRpcHarness({ connectionEpoch: 12 });
  const pending = client.request('thread/list', {});
  client.handleExit({ code: 7, signal: null });

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'APP_SERVER_EXITED');
    assert.deepEqual(error.details, { code: 7, signal: null, connectionEpoch: 12 });
    return true;
  });
  await assert.rejects(client.request('thread/list', {}), error => {
    assert.equal(error.code, 'APP_SERVER_CONNECTION_CLOSED');
    return true;
  });
});

test('process manager increments connectionEpoch and only stops its currently owned child', () => {
  const firstChild = createFakeChild(4101);
  const secondChild = createFakeChild(4102);
  const children = [firstChild, secondChild];
  const spawnCalls = [];
  const manager = new AppServerProcessManager({
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return children.shift();
    },
  });
  const stderrEvents = [];
  manager.on('stderr', event => stderrEvents.push(event));

  const first = manager.start({ codexHome: 'E:\\isolated\\codex-home' });
  assert.equal(first.connectionEpoch, 1);
  assert.equal(first.pid, 4101);
  assert.equal(manager.ownedPid, 4101);
  assert.equal(spawnCalls[0].command, 'codex');
  assert.deepEqual(spawnCalls[0].args, DEFAULT_APP_SERVER_ARGS);
  assert.equal(spawnCalls[0].options.env.CODEX_HOME, 'E:\\isolated\\codex-home');
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.deepEqual(spawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  firstChild.stderr.write('app-server diagnostic line');
  assert.deepEqual(stderrEvents, [{
    pid: 4101,
    connectionEpoch: 1,
    text: 'app-server diagnostic line',
  }]);

  assert.equal(manager.stop(), true);
  assert.deepEqual(firstChild.killCalls, ['SIGTERM']);
  firstChild.emit('exit', 0, null);
  assert.equal(manager.ownedPid, null);

  const second = manager.start({ codexHome: 'E:\\isolated\\codex-home-2' });
  assert.equal(second.connectionEpoch, 2);
  assert.equal(manager.ownedPid, 4102);
  firstChild.emit('exit', 9, null);
  assert.equal(manager.ownedPid, 4102, 'a stale exit cannot clear ownership of a newer child');

  assert.equal(manager.stop('SIGINT'), true);
  assert.deepEqual(secondChild.killCalls, ['SIGINT']);
  secondChild.emit('exit', 0, null);
});
