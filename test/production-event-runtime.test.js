'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ProductionEventRuntime,
  createSessionResolver,
} = require('../lib/events/production-event-runtime');

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHILD_THREAD = '99999999-8888-4777-8666-555555555555';

class FakeFileSource {
  constructor() {
    this.files = new Map();
  }

  set(filePath, identity, items) {
    const text = items.map(item => `${JSON.stringify(item)}\n`).join('');
    this.files.set(filePath, { identity, bytes: Buffer.from(text, 'utf8') });
  }

  append(filePath, item) {
    const file = this.files.get(filePath);
    file.bytes = Buffer.concat([file.bytes, Buffer.from(`${JSON.stringify(item)}\n`, 'utf8')]);
  }

  stat(filePath) {
    const file = this.files.get(filePath);
    if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { identity: file.identity, size: file.bytes.length };
  }

  read(filePath, start, end) {
    return this.files.get(filePath).bytes.subarray(start, end);
  }
}

function eventItem(kind, turnId, timestamp) {
  return {
    type: 'event_msg',
    timestamp,
    payload: { type: kind, turn_id: turnId },
  };
}

function finalItem(text, turnId, timestamp) {
  return {
    type: 'response_item',
    timestamp,
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function subagentItem() {
  return {
    type: 'event_msg',
    timestamp: '2026-07-10T00:00:01.500Z',
    payload: {
      type: 'sub_agent_activity',
      kind: 'started',
      agent_thread_id: 'raw-child-identity',
      task_name: 'worker_1',
      prompt: 'SECRET_CHILD_PROMPT',
      body: 'SECRET_CHILD_BODY',
    },
  };
}

function createHarness() {
  const source = new FakeFileSource();
  const paths = new Map([
    [THREAD, 'E:\\isolated\\sessions\\thread.jsonl'],
    [OTHER_THREAD, 'E:\\isolated\\sessions\\other.jsonl'],
    [CHILD_THREAD, 'E:\\isolated\\sessions\\child.jsonl'],
  ]);
  source.set(paths.get(THREAD), 'thread-file-a', [
    eventItem('task_started', 'turn-main', '2026-07-10T00:00:00.000Z'),
    subagentItem(),
    { type: 'future_unknown', payload: { body: 'SECRET_UNKNOWN_BODY' } },
  ]);
  source.set(paths.get(OTHER_THREAD), 'other-file-a', [
    finalItem('OTHER_THREAD_SECRET', 'turn-other', '2026-07-10T00:00:01.000Z'),
  ]);
  source.set(paths.get(CHILD_THREAD), 'child-file-a', [
    finalItem('SECRET_CHILD_SESSION_FINAL', 'turn-child', '2026-07-10T00:00:01.000Z'),
  ]);
  const runtime = new ProductionEventRuntime({
    serverInstanceId: 'server-production-a',
    fileSource: source,
    resolveSession(threadId) {
      const filePath = paths.get(threadId);
      return filePath ? {
        filePath,
        session: { isSubagent: threadId === CHILD_THREAD },
      } : null;
    },
  });
  return { runtime, source, paths };
}

test('production resolver stays inside the configured CODEX_HOME sessions tree and classifies subagents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-event-resolver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const nested = path.join(sessionsDir, '2026', '07', '10');
  fs.mkdirSync(nested, { recursive: true });
  const exact = path.join(nested, `rollout-safe-${CHILD_THREAD}.jsonl`);
  fs.writeFileSync(exact, `${JSON.stringify({
    type: 'session_meta',
    payload: { thread_source: 'subagent' },
  })}\n`, 'utf8');
  fs.writeFileSync(
    path.join(nested, `decoy-${CHILD_THREAD}-extra.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: {} })}\n`,
    'utf8',
  );

  const resolveSession = createSessionResolver({ sessionsDir });
  assert.deepEqual(resolveSession(CHILD_THREAD), {
    filePath: exact,
    session: { isSubagent: true },
  });
  assert.equal(resolveSession('not-a-thread-id'), null);
  assert.throws(() => createSessionResolver({}), /requires sessionsDir/);
});

test('missing, corrupt, and oversized session metadata stays private with zero event body output', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-untrusted-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const cases = [
    {
      threadId: '10000000-0000-4000-8000-000000000001',
      prefix: '',
      secret: 'MISSING_META_SECRET',
    },
    {
      threadId: '10000000-0000-4000-8000-000000000002',
      prefix: '{"type":"session_meta",broken}\n',
      secret: 'CORRUPT_META_SECRET',
    },
    {
      threadId: '10000000-0000-4000-8000-000000000003',
      prefix: `${JSON.stringify({
        type: 'session_meta',
        payload: { thread_source: 'cli', padding: 'x'.repeat(70 * 1024) },
      })}\n`,
      secret: 'OVERSIZED_META_SECRET',
    },
    {
      threadId: '10000000-0000-4000-8000-000000000004',
      prefix: `${JSON.stringify({ type: 'session_meta', payload: {} })}\n`,
      secret: 'EMPTY_META_SECRET',
    },
    {
      threadId: '10000000-0000-4000-8000-000000000005',
      prefix: `${JSON.stringify({
        type: 'session_meta',
        payload: { source: 'future-unknown-source' },
      })}\n`,
      secret: 'UNKNOWN_SOURCE_SECRET',
    },
  ];
  for (const item of cases) {
    fs.writeFileSync(
      path.join(sessionsDir, `rollout-${item.threadId}.jsonl`),
      `${item.prefix}${JSON.stringify(finalItem(
        item.secret,
        `turn-${item.threadId}`,
        '2026-07-10T00:00:01.000Z',
      ))}\n`,
      'utf8',
    );
  }

  const resolveSession = createSessionResolver({ sessionsDir });
  for (const item of cases) {
    const descriptor = resolveSession(item.threadId);
    assert.equal(descriptor.session.isSubagent, true);
    const runtime = new ProductionEventRuntime({
      serverInstanceId: `private-${item.threadId}`,
      resolveSession,
    });
    const snapshot = await runtime.snapshot(item.threadId);
    assert.deepEqual(snapshot.events, []);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(item.secret));
  }
});

test('only explicit trusted main-session metadata opens event bodies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-trusted-main-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-${THREAD}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } })}\n`,
    'utf8',
  );
  assert.equal(createSessionResolver({ sessionsDir })(THREAD).session.isSubagent, false);
});

test('production runtime tails one requested thread incrementally and keeps privacy fail-closed', async () => {
  const { runtime, source, paths } = createHarness();
  const initial = await runtime.read(THREAD, {});

  assert.equal(initial.mode, 'snapshot');
  assert.equal(initial.serverInstanceId, 'server-production-a');
  assert.equal(initial.snapshotVersion, 1);
  assert.deepEqual(initial.events.map(event => event.type), ['turn', 'summary']);
  const serialized = JSON.stringify(initial);
  assert.match(serialized, /worker_1/);
  assert.doesNotMatch(serialized, /OTHER_THREAD_SECRET|SECRET_CHILD_PROMPT|SECRET_CHILD_BODY|raw-child-identity|SECRET_UNKNOWN_BODY/);
  assert.doesNotMatch(serialized, /isolated|jsonl|filePath/);

  source.append(paths.get(THREAD), finalItem(
    'MAIN_FINAL',
    'turn-main',
    '2026-07-10T00:00:02.000Z',
  ));
  const delta = await runtime.read(THREAD, {
    serverInstanceId: initial.serverInstanceId,
    snapshotVersion: initial.snapshotVersion,
    cursor: initial.cursor,
  });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.events.map(event => event.text), ['MAIN_FINAL']);

  const child = await runtime.snapshot(CHILD_THREAD);
  assert.deepEqual(child.events, []);
  assert.doesNotMatch(JSON.stringify(child), /SECRET_CHILD_SESSION_FINAL/);
});

test('file rotation forces a full rehydrate, advances snapshotVersion, and drops stale events', async () => {
  const { runtime, source, paths } = createHarness();
  const initial = await runtime.read(THREAD, {});

  source.set(paths.get(THREAD), 'thread-file-b', [
    eventItem('task_started', 'turn-rotated', '2026-07-10T00:01:00.000Z'),
    finalItem('ROTATED_FINAL', 'turn-rotated', '2026-07-10T00:01:01.000Z'),
  ]);
  const rotated = await runtime.read(THREAD, {
    serverInstanceId: initial.serverInstanceId,
    snapshotVersion: initial.snapshotVersion,
    cursor: initial.cursor,
  });

  assert.equal(rotated.mode, 'snapshot');
  assert.equal(rotated.snapshotVersion, initial.snapshotVersion + 1);
  assert.match(JSON.stringify(rotated), /ROTATED_FINAL/);
  assert.doesNotMatch(JSON.stringify(rotated), /worker_1|turn-main/);
});

test('RPC sequence gaps and connection rotation rehydrate registered threads from files', async () => {
  const { runtime, source, paths } = createHarness();
  await runtime.read(THREAD, {});
  await runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 1,
    method: 'turn/started',
    params: { threadId: THREAD, turn: { id: 'turn-rpc-stale' } },
  });
  const withRpc = await runtime.snapshot(THREAD);
  assert.match(JSON.stringify(withRpc), /turn-rpc-stale/);

  source.set(paths.get(THREAD), 'thread-file-a', [
    eventItem('task_started', 'turn-file-current', '2026-07-10T00:02:00.000Z'),
    eventItem('task_complete', 'turn-file-current', '2026-07-10T00:02:01.000Z'),
  ]);
  await runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 3,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'idle' } },
  });
  const rehydrated = await runtime.snapshot(THREAD);
  assert.equal(rehydrated.snapshotVersion, withRpc.snapshotVersion + 1);
  assert.match(JSON.stringify(rehydrated), /turn-file-current/);
  assert.doesNotMatch(JSON.stringify(rehydrated), /turn-rpc-stale/);

  await runtime.ingestRpcNotification({
    connectionEpoch: 2,
    sequence: 1,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'idle' } },
  });
  assert.equal((await runtime.snapshot(THREAD)).snapshotVersion, rehydrated.snapshotVersion + 1);
});

test('RPC notifications serialize by epoch, keep sequence monotonic, and drop an older epoch', async () => {
  const { runtime } = createHarness();
  await runtime.read(THREAD, {});
  await runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 1,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'idle' } },
  });

  let rehydrateCalls = 0;
  runtime.rehydrateAll = async () => {
    rehydrateCalls += 1;
    const delayMs = rehydrateCalls === 1 ? 25 : 0;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  };
  await Promise.all([
    runtime.ingestRpcNotification({
      connectionEpoch: 1,
      sequence: 3,
      method: 'thread/status/changed',
      params: { threadId: THREAD, status: { type: 'working' } },
    }),
    runtime.ingestRpcNotification({
      connectionEpoch: 1,
      sequence: 4,
      method: 'thread/status/changed',
      params: { threadId: THREAD, status: { type: 'idle' } },
    }),
  ]);
  assert.equal(rehydrateCalls, 1);
  assert.equal(runtime.lastConnectionEpoch, 1);
  assert.equal(runtime.lastNotificationSequence, 4);

  await runtime.ingestRpcNotification({
    connectionEpoch: 2,
    sequence: 1,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'idle' } },
  });
  const callsBeforeStale = rehydrateCalls;
  const stale = await runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 100,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'working' } },
  });
  assert.deepEqual(stale, {
    accepted: [],
    ignored: true,
    staleEpoch: true,
  });
  assert.equal(rehydrateCalls, callsBeforeStale);
  assert.equal(runtime.lastConnectionEpoch, 2);
  assert.equal(runtime.lastNotificationSequence, 1);
});

test('the first packet in an epoch rehydrates when its sequence starts after one', async () => {
  const { runtime } = createHarness();
  await runtime.read(THREAD, {});
  let rehydrateCalls = 0;
  runtime.rehydrateAll = async () => { rehydrateCalls += 1; };

  await runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 3,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'idle' } },
  });
  assert.equal(rehydrateCalls, 1);
  assert.equal(runtime.lastNotificationSequence, 3);
});

test('stop invalidates an in-flight notification before descriptor resolution can recreate state', async () => {
  const source = new FakeFileSource();
  const filePath = 'E:\\isolated\\sessions\\deferred.jsonl';
  source.set(filePath, 'deferred-file-a', [
    eventItem('task_started', 'turn-deferred', '2026-07-10T00:00:00.000Z'),
  ]);
  let releaseDescriptor;
  const descriptorGate = new Promise(resolve => { releaseDescriptor = resolve; });
  const runtime = new ProductionEventRuntime({
    serverInstanceId: 'server-deferred-stop',
    fileSource: source,
    async resolveSession() {
      await descriptorGate;
      return { filePath, session: { isSubagent: false } };
    },
  });
  runtime.start();
  const notification = runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 1,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'working' } },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(runtime.stop(), true);
  releaseDescriptor();
  assert.deepEqual(await notification, { accepted: [], ignored: true });
  assert.equal(runtime.threads.size, 0);
  assert.equal(runtime.lastConnectionEpoch, 0);
  assert.equal(runtime.lastNotificationSequence, 0);
});

test('a notification queued before stop cannot run in a restarted lifecycle', async () => {
  const { runtime } = createHarness();
  runtime.start();
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  runtime.notificationTail = firstGate;
  const staleNotification = runtime.ingestRpcNotification({
    connectionEpoch: 1,
    sequence: 1,
    method: 'thread/status/changed',
    params: { threadId: THREAD, status: { type: 'working' } },
  });

  runtime.stop();
  runtime.start();
  releaseFirst();
  assert.deepEqual(await staleNotification, { accepted: [], ignored: true });
  assert.equal(runtime.threads.size, 0);
  assert.equal(runtime.lastConnectionEpoch, 0);
  assert.equal(runtime.lastNotificationSequence, 0);
  runtime.stop();
});

test('cursor and diagnostics expose only protocol/sync metadata, and stop clears only the owned timer', async () => {
  const { runtime } = createHarness();
  const ownTimer = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  const cleared = [];
  runtime.setIntervalImpl = (callback, intervalMs) => {
    assert.equal(typeof callback, 'function');
    assert.equal(intervalMs > 0, true);
    return ownTimer;
  };
  runtime.clearIntervalImpl = timer => cleared.push(timer);

  runtime.start();
  const cursor = await runtime.cursor(THREAD);
  const diagnostics = runtime.diagnostics();
  assert.deepEqual(Object.keys(cursor).sort(), [
    'cursor',
    'serverInstanceId',
    'snapshotVersion',
  ]);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['lastSyncedAt', 'snapshotVersion', 'stale']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /11111111|isolated|jsonl|server-production-a/);

  assert.equal(runtime.stop(), true);
  assert.deepEqual(cleared, [ownTimer]);
  assert.equal(ownTimer.unrefCalls, 1);
  assert.equal(runtime.stop(), false);
});
