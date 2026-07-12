'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventReconciler } = require('../lib/events/reconciler');
const {
  SECRET_ARGUMENT,
  SECRET_BODY,
  SECRET_OUTPUT,
  SECRET_PROMPT,
  SYNTHETIC_IMAGE_DIR,
  assertNoSecretCanaries,
  rpcItemNotification,
} = require('./fixtures/session-events');

function fileEntry(item, offset = 0) {
  return {
    source: 'file',
    filePath: 'E:\\sessions\\rollout.jsonl',
    fileIdentity: 'file-a',
    offset,
    nextOffset: offset + 100,
    item,
  };
}

function turnItem(kind, turnId, timestamp = '2026-07-10T00:00:00.000Z') {
  return {
    type: 'event_msg',
    timestamp,
    payload: { type: kind, turn_id: turnId },
  };
}

function assertNoRawNotificationCanaries(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [SECRET_PROMPT, SECRET_BODY, SECRET_ARGUMENT, SECRET_OUTPUT]) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  for (const key of ['rawPayload', 'rawContext', 'token', 'path']) {
    assert.equal(serialized.includes(`"${key}"`), false, `must not expose ${key}`);
  }
}

test('reconciler deduplicates matching RPC and file turn events into one unified state', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });

  const rpcStarted = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
  });
  assert.equal(rpcStarted.accepted.length, 1);
  assert.equal(rpcStarted.accepted[0].state, 'started');

  const duplicateFileStart = reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', 'turn-1'), 0),
  ]);
  assert.deepEqual(duplicateFileStart, []);

  const fileComplete = reconciler.ingestFileEntries([
    fileEntry(turnItem('task_complete', 'turn-1', '2026-07-10T00:00:01.000Z'), 100),
  ]);
  assert.equal(fileComplete.length, 1);
  assert.equal(fileComplete[0].state, 'completed');

  const duplicateRpcComplete = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  assert.deepEqual(duplicateRpcComplete.accepted, []);

  const conflictingTerminal = reconciler.ingestFileEntries([
    fileEntry(turnItem('task_failed', 'turn-1', '2026-07-10T00:00:02.000Z'), 200),
  ]);
  assert.deepEqual(conflictingTerminal, []);
  assert.deepEqual(reconciler.turnSnapshot(), [{ turnId: 'turn-1', state: 'completed' }]);
  assert.deepEqual(reconciler.snapshot().events.map(event => event.state), ['started', 'completed']);
});

test('paired user records keep one public event and merge safe attachments', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const accepted = reconciler.ingestFileEntries([
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T10:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [{
        type: 'input_text',
        text: '# Files mentioned by the user:\n## a.png: C:/private/a.png\n## My request for Codex:\n查看图片',
      }] },
    }, 0),
    fileEntry({
      type: 'event_msg', timestamp: '2026-07-10T10:00:00.001Z',
      payload: { type: 'user_message', message: '查看图片', local_images: ['C:/private/a.png'] },
    }, 100),
  ]);

  assert.equal(accepted.length, 2, 'the second source copy is an upsert update');
  assert.equal(accepted[0].eventId, accepted[1].eventId);
  const userEvents = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(userEvents.length, 1);
  assert.equal(userEvents[0].text, '查看图片');
  assert.deepEqual(userEvents[0].attachments.map(item => item.name), ['a.png']);
  assert.equal(JSON.stringify(userEvents).includes('base64'), false);
});

test('user attachment merge state stays bounded while recent paired upserts still merge', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const entries = Array.from({ length: 257 }, (_, index) => fileEntry({
    type: 'event_msg',
    timestamp: new Date(Date.parse('2026-07-10T10:00:00.000Z') + index * 2000).toISOString(),
    payload: { type: 'user_message', message: `message-${index}`, local_images: [`C:/private/${index}.png`] },
  }, index * 100));
  reconciler.ingestFileEntries(entries);
  const update = reconciler.ingestFileEntries([fileEntry({
    type: 'event_msg',
    timestamp: new Date(Date.parse('2026-07-10T10:00:00.000Z') + 256 * 2000 + 1).toISOString(),
    payload: { type: 'user_message', message: 'message-256', local_images: ['C:/private/recent.png'] },
  }, 30000)]);

  assert.equal(reconciler.userAttachmentsByEventId.size <= 256, true);
  assert.deepEqual(update[0].attachments.map(item => item.name), ['256.png', 'recent.png']);
});

test('duplicate and older RPC notification sequences are ignored without changing state', async () => {
  let rehydrateCalls = 0;
  const reconciler = new EventReconciler({
    serverInstanceId: 'server-a',
    async fullRehydrate() {
      rehydrateCalls += 1;
      return [];
    },
  });
  await reconciler.ingestRpcNotification({
    sequence: 5,
    method: 'turn/started',
    params: { turn: { id: 'turn-5' } },
  });

  const older = await reconciler.ingestRpcNotification({
    sequence: 4,
    method: 'turn/completed',
    params: { turn: { id: 'turn-5', status: 'completed' } },
  });
  const duplicate = await reconciler.ingestRpcNotification({
    sequence: 5,
    method: 'turn/completed',
    params: { turn: { id: 'turn-5', status: 'completed' } },
  });

  assert.equal(older.duplicate, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(rehydrateCalls, 0);
  assert.deepEqual(reconciler.turnSnapshot(), [{ turnId: 'turn-5', state: 'started' }]);
});

test('reasoning progress is one updatable event per active turn while tool history remains durable', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const accepted = reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', 'turn-progress'), 0),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T00:00:01.000Z',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'first status' }] },
    }, 100),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T00:00:02.000Z',
      payload: { type: 'function_call', name: 'shell_command', arguments: '{}' },
    }, 200),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T00:00:03.000Z',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'second status' }] },
    }, 300),
  ]);

  assert.equal(accepted.length, 4);
  const snapshot = reconciler.snapshot();
  assert.equal(snapshot.events.filter(event => event.summaryKind === 'reasoning').length, 1);
  assert.equal(snapshot.events.find(event => event.summaryKind === 'reasoning').body, 'second status');
  assert.equal(snapshot.events.filter(event => event.toolKind === 'command').length, 1);
  assert.equal(snapshot.events.find(event => event.summaryKind === 'reasoning').turnId, 'turn-progress');
});

test('notification gap triggers full rehydrate and forces clients onto a new snapshot version', async () => {
  const calls = [];
  const reconciler = new EventReconciler({
    serverInstanceId: 'server-a',
    async fullRehydrate(details) {
      calls.push(details);
      return [
        turnItem('task_started', 'turn-current', '2026-07-10T00:00:10.000Z'),
        turnItem('task_complete', 'turn-current', '2026-07-10T00:00:11.000Z'),
      ];
    },
  });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { turn: { id: 'turn-stale' } },
  });

  const result = await reconciler.ingestRpcNotification({
    sequence: 3,
    method: 'thread/status/changed',
    params: { threadId: 'thread-1', status: { type: 'idle' } },
  });

  assert.equal(result.rehydrated, true);
  assert.deepEqual(calls, [{
    serverInstanceId: 'server-a',
    expectedSequence: 2,
    receivedSequence: 3,
  }]);
  const snapshot = reconciler.snapshot();
  assert.equal(snapshot.snapshotVersion, 2);
  assert.deepEqual(snapshot.events.map(event => event.state), ['started', 'completed']);
  assert.deepEqual(reconciler.turnSnapshot(), [{ turnId: 'turn-current', state: 'completed' }]);
  assert.equal(reconciler.read({
    serverInstanceId: 'server-a',
    snapshotVersion: 1,
    cursor: 1,
  }).mode, 'snapshot');
});

test('subagent and unknown RPC bodies use privacy-safe stable fallback', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const subagent = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'item/completed',
    params: {
      item: {
        type: 'subAgentActivity',
        kind: 'started',
        agentThreadId: 'raw-child-identity',
        taskName: 'worker_1',
        body: 'SECRET_CHILD_BODY',
        prompt: 'SECRET_CHILD_PROMPT',
      },
    },
  });

  assert.equal(subagent.accepted.length, 1);
  assert.equal(subagent.accepted[0].summaryKind, 'subagent');
  const serialized = JSON.stringify(subagent.accepted[0]);
  assert.match(serialized, /worker_1/);
  assert.doesNotMatch(serialized, /SECRET_CHILD_BODY|SECRET_CHILD_PROMPT|raw-child-identity/);

  const unknown = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'future/raw-child-body',
    params: { body: 'SECRET_UNKNOWN_BODY' },
  });
  assert.equal(unknown.accepted.length, 1);
  assert.equal(unknown.accepted[0].toolKind, 'unknown');
  assert.equal(unknown.accepted[0].text, 'Unsupported activity');
  const repeated = await reconciler.ingestRpcNotification({
    sequence: 4, method: 'future/raw-child-body',
    params: { nested: { body: SECRET_BODY }, token: SECRET_ARGUMENT },
  });
  assert.deepEqual(repeated.accepted, []);
  assert.equal(reconciler.snapshot().events.filter(event => event.toolKind === 'unknown').length, 1);
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /SECRET_UNKNOWN_BODY/);
});

test('child-session file events remain entirely hidden by the existing session normalizer', () => {
  const reconciler = new EventReconciler({
    serverInstanceId: 'server-a',
    session: { isSubagent: true },
  });
  const accepted = reconciler.ingestFileEntries([
    fileEntry({
      type: 'response_item',
      timestamp: '2026-07-10T00:00:00.000Z',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'SECRET_CHILD_FINAL' }],
      },
    }),
  ]);

  assert.deepEqual(accepted, []);
  assert.deepEqual(reconciler.snapshot().events, []);
});

test('RPC imageView keeps the explicit turn and renderable attachment metadata', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { turn: { id: 'turn-active' } },
  });
  const filePath = `${SYNTHETIC_IMAGE_DIR}\\rpc-view.png`;
  const result = await reconciler.ingestRpcNotification(rpcItemNotification(
    'item/completed',
    'imageView',
    'turn-explicit-image',
    { id: 'rpc-image-view-1', path: filePath },
    2,
  ));

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].turnId, 'turn-explicit-image');
  assert.equal(result.accepted[0].toolKind, 'imageView');
  assert.equal(result.accepted[0].count, 1);
  assert.equal(result.accepted[0].attachments[0].filePath, filePath);
  assert.equal(Object.hasOwn(result.accepted[0], 'sourceKey'), false);
});

test('RPC item lifecycle upserts one generic command from running to succeeded', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const started = await reconciler.ingestRpcNotification(rpcItemNotification(
    'item/started',
    'commandExecution',
    'turn-command',
    { id: 'command-lifecycle-1', command: 'fixture command' },
    1,
  ));
  const completed = await reconciler.ingestRpcNotification(rpcItemNotification(
    'item/completed',
    'commandExecution',
    'turn-command',
    { id: 'command-lifecycle-1', command: 'fixture command', status: 'completed' },
    2,
  ));

  assert.equal(started.accepted.length, 1);
  assert.equal(started.accepted[0].state, 'running');
  assert.equal(completed.accepted.length, 1);
  assert.equal(completed.accepted[0].eventId, started.accepted[0].eventId);
  assert.equal(completed.accepted[0].state, 'succeeded');
  const commandEvents = reconciler.snapshot().events.filter(event => event.toolKind === 'command');
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0].state, 'succeeded');
});

test('RPC collabAgentToolCall drops prompt, arguments, output, and raw child identities', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const result = await reconciler.ingestRpcNotification(rpcItemNotification(
    'item/completed',
    'collabAgentToolCall',
    'turn-collab',
    {
      id: 'collab-private-1',
      prompt: SECRET_PROMPT,
      body: SECRET_BODY,
      arguments: SECRET_ARGUMENT,
      output: SECRET_OUTPUT,
      receiverThreadIds: ['raw-private-child'],
    },
  ));

  assert.deepEqual(result.accepted, []);
  assert.doesNotMatch(
    JSON.stringify(reconciler.snapshot()),
    /SECRET_SUBAGENT|SECRET_TOOL|raw-private-child/,
  );
});

test('completed closeAgent becomes only a privacy-safe closed lifecycle update', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-close-agent' });
  await reconciler.ingestRpcNotification({
    method: 'item/started', sequence: 1,
    params: { turnId: 'turn-close', item: {
      type: 'subAgentActivity', id: 'sub-start', kind: 'started',
      agentPath: '/root/private-worker', agentThreadId: 'private-child-id'
    } }
  });
  const result = await reconciler.ingestRpcNotification({
    method: 'item/completed', sequence: 2,
    params: { turnId: 'turn-close', item: {
      type: 'collabAgentToolCall', id: 'close-call', tool: 'closeAgent', status: 'completed',
      receiverThreadIds: ['private-child-id'], senderThreadId: 'private-parent-id',
      prompt: SECRET_PROMPT, arguments: SECRET_ARGUMENT, output: SECRET_OUTPUT
    } }
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].summaryKind, 'subagent');
  assert.equal(result.accepted[0].subagent.status, 'closed');
  assertNoSecretCanaries(assert, reconciler.snapshot());
  assert.equal(JSON.stringify(reconciler.snapshot()).includes('private-child-id'), false);
  assert.equal(JSON.stringify(reconciler.snapshot()).includes('private-parent-id'), false);
});

test('reasoning summary deltas accumulate in place by item and keep the explicit turn', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-reasoning-delta' });
  const first = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-reasoning',
      turnId: 'turn-reasoning',
      itemId: 'reasoning-item-1',
      delta: 'Checking the new ',
      rawPayload: SECRET_BODY,
      path: 'E:\\private\\reasoning.txt',
      token: SECRET_ARGUMENT,
    },
  });
  const second = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-reasoning',
      turnId: 'turn-reasoning',
      itemId: 'reasoning-item-1',
      delta: 'output types',
      rawPayload: SECRET_OUTPUT,
    },
  });

  assert.equal(first.accepted.length, 1);
  assert.equal(second.accepted.length, 1);
  assert.equal(second.accepted[0].eventId, first.accepted[0].eventId);
  assert.equal(second.accepted[0].turnId, 'turn-reasoning');
  assert.equal(second.accepted[0].body, 'Checking the new output types');
  const reasoningEvents = reconciler.snapshot().events
    .filter(event => event.summaryKind === 'reasoning');
  assert.equal(reasoningEvents.length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /private\\reasoning\.txt/);
});

test('plan and public agent-message deltas each accumulate into one stable event', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-public-deltas' });
  const planFirst = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'item/plan/delta',
    params: { turnId: 'turn-plan', itemId: 'plan-item-1', delta: 'Inspect schema. ' },
  });
  const planSecond = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'item/plan/delta',
    params: { turnId: 'turn-plan', itemId: 'plan-item-1', delta: 'Run tests.' },
  });
  const messageFirst = await reconciler.ingestRpcNotification({
    sequence: 3,
    method: 'item/agentMessage/delta',
    params: {
      turnId: 'turn-message', itemId: 'message-item-1', phase: 'commentary',
      delta: 'Working on ', rawPayload: SECRET_PROMPT,
    },
  });
  const messageSecond = await reconciler.ingestRpcNotification({
    sequence: 4,
    method: 'item/agentMessage/delta',
    params: {
      turnId: 'turn-message', itemId: 'message-item-1', phase: 'commentary',
      delta: 'compatibility.', rawPayload: SECRET_OUTPUT,
    },
  });

  assert.equal(planSecond.accepted[0].eventId, planFirst.accepted[0].eventId);
  assert.equal(planSecond.accepted[0].body, 'Inspect schema. Run tests.');
  assert.equal(messageSecond.accepted[0].eventId, messageFirst.accepted[0].eventId);
  assert.equal(messageSecond.accepted[0].body, 'Working on compatibility.');
  assert.equal(messageSecond.accepted[0].turnId, 'turn-message');
  assert.equal(reconciler.snapshot().events.filter(event => event.summaryKind === 'plan').length, 1);
  assert.equal(reconciler.snapshot().events.filter(event => event.summaryKind === 'commentary').length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('agent-message deltas fail closed unless their phase is explicitly public', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-private-deltas' });
  for (const [sequence, phase] of [[1, 'reasoning'], [2, 'analysis'], [3, 'subagent'], [4, '']]) {
    const result = await reconciler.ingestRpcNotification({
      sequence,
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-private', itemId: `private-${sequence}`, phase,
        delta: `${SECRET_BODY}-${phase || 'missing'}`,
      },
    });
    assert.deepEqual(result.accepted, []);
  }

  assert.deepEqual(reconciler.snapshot().events, []);
  assertNoSecretCanaries(assert, reconciler.snapshot());
});

test('item deltas never guess a turn when the notification omits turnId', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-exact-turn' });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { turn: { id: 'turn-active-but-not-explicit' } },
  });
  const result = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'item/reasoning/summaryTextDelta',
    params: { itemId: 'reasoning-without-turn', delta: SECRET_BODY },
  });

  assert.deepEqual(result.accepted, []);
  assert.equal(reconciler.snapshot().events.some(event => event.summaryKind === 'reasoning'), false);
  assertNoSecretCanaries(assert, reconciler.snapshot());
});

test('turn plan updates and context compaction expose only safe structured summaries', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-structured-updates' });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { threadId: 'thread-structured', turn: { id: 'turn-structured' } },
  });
  const plan = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-structured',
      turnId: 'turn-structured',
      explanation: 'Compatibility pass',
      plan: [
        { step: 'Inspect notifications', status: 'in_progress', raw: SECRET_BODY },
        { step: 'Run the suite', status: 'pending', path: 'E:\\private\\plan.txt' },
      ],
      rawPayload: SECRET_OUTPUT,
    },
  });
  const compacted = await reconciler.ingestRpcNotification({
    sequence: 3,
    method: 'thread/compacted',
    params: { threadId: 'thread-structured', rawContext: SECRET_PROMPT },
  });

  assert.equal(plan.accepted.length, 1);
  assert.equal(plan.accepted[0].turnId, 'turn-structured');
  assert.deepEqual(plan.accepted[0].stepCounts, { pending: 1, inProgress: 1, completed: 0 });
  assert.equal(plan.accepted[0].hasExplanation, true);
  assert.equal(plan.accepted[0].body, undefined);
  assert.equal(compacted.accepted.length, 1);
  assert.equal(compacted.accepted[0].turnId, 'turn-structured');
  assert.equal(compacted.accepted[0].toolKind, 'compaction');
  assertNoRawNotificationCanaries(reconciler.snapshot());
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /private\\plan\.txt/);
});

test('unknown ThreadItem lifecycle upserts one allowlisted fallback row', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-unknown-item' });
  const started = await reconciler.ingestRpcNotification({ sequence: 1, method: 'item/started', params: {
    turnId: 'turn-unknown', item: { type: 'futureThreadItem', id: 'future-public-id', status: 'inProgress', nested: { token: SECRET_ARGUMENT }, path: SECRET_OUTPUT },
  } });
  const completed = await reconciler.ingestRpcNotification({ sequence: 2, method: 'item/completed', params: {
    turnId: 'turn-unknown', item: { type: 'futureThreadItem', id: 'future-public-id', status: 'completed', nested: { body: SECRET_BODY }, path: SECRET_PROMPT },
  } });
  assert.equal(started.accepted[0].eventId, completed.accepted[0].eventId);
  assert.equal(reconciler.snapshot().events.filter(event => event.toolKind === 'unknown').length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('arbitrary vendor notification has stable sanitized fallback independent of body and sequence', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-vendor-unknown' });
  const first = await reconciler.ingestRpcNotification({ sequence: 1, method: 'vendor/newThing', params: { turnId: 'turn-vendor', itemId: 'item-vendor', nested: { token: SECRET_ARGUMENT } } });
  const second = await reconciler.ingestRpcNotification({ sequence: 2, method: 'vendor/newThing', params: { turnId: 'turn-vendor', itemId: 'item-vendor', nested: { body: SECRET_BODY } } });
  assert.equal(first.accepted.length, 1);
  assert.deepEqual(second.accepted, []);
  assert.equal(reconciler.snapshot().events.filter(event => event.publicType === 'vendor/newThing').length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('unknown installed-namespace method safely upserts while exact raw method remains ignored', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-known-namespace-unknown' });
  const first = await reconciler.ingestRpcNotification({ sequence: 1, method: 'item/newActivity', params: { turnId: 'turn-new', itemId: 'new-item', nested: { token: SECRET_ARGUMENT } } });
  const second = await reconciler.ingestRpcNotification({ sequence: 2, method: 'item/newActivity', params: { turnId: 'turn-new', itemId: 'new-item', nested: { body: SECRET_BODY } } });
  const ignored = await reconciler.ingestRpcNotification({ sequence: 3, method: 'item/reasoning/textDelta', params: { turnId: 'turn-new', itemId: 'reasoning', delta: SECRET_OUTPUT } });
  assert.equal(first.accepted.length, 1);
  assert.deepEqual(second.accepted, []);
  assert.deepEqual(ignored.accepted, []);
  assert.equal(reconciler.snapshot().events.filter(event => event.publicType === 'item/newActivity').length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('unsafe unknown ThreadItem type collapses to fixed unknown public type', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-unsafe-unknown' });
  const unsafeType = `bad\\path\u0000token-${'x'.repeat(300)}`;
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'item/started', params: { turnId: 'turn-unsafe', item: { type: unsafeType, id: 'safe-id', nested: { token: SECRET_ARGUMENT } } } });
  const event = reconciler.snapshot().events.find(value => value.toolKind === 'unknown');
  assert.equal(event.publicType, 'unknown');
  assert.doesNotMatch(JSON.stringify(event), /bad|path|token|xxx/);
});

test('context compaction item and deprecated notification yield one marker', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-compaction-dedupe' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'item/completed', params: {
    turnId: 'turn-compact', item: { type: 'contextCompaction', id: 'installed-item-id' },
  } });
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'thread/compacted', params: {
    threadId: 'thread-compact', turnId: 'turn-compact',
  } });
  assert.equal(reconciler.snapshot().events.filter(event => event.toolKind === 'compaction').length, 1);
});

test('error and warning notifications use fixed safe summaries instead of raw diagnostics', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-safe-errors' });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { turn: { id: 'turn-errors' } },
  });
  const error = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'error',
    params: { message: SECRET_BODY, path: 'E:\\private\\error.log', token: SECRET_ARGUMENT },
  });
  const warning = await reconciler.ingestRpcNotification({
    sequence: 3,
    method: 'warning',
    params: { message: SECRET_OUTPUT, data: { prompt: SECRET_PROMPT } },
  });

  assert.equal(error.accepted.length, 1);
  assert.equal(error.accepted[0].turnId, 'turn-errors');
  assert.equal(error.accepted[0].body, 'Codex reported an error.');
  assert.equal(warning.accepted.length, 1);
  assert.equal(warning.accepted[0].turnId, 'turn-errors');
  assert.equal(warning.accepted[0].text, 'Codex reported a warning.');
  assertNoRawNotificationCanaries(reconciler.snapshot());
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /private\\error\.log/);
});

test('warning taxonomy uses fixed labels and stable dedupe identities', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-warning-taxonomy' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/started', params: { turn: { id: 'turn-warn' } } });
  const methods = ['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'];
  for (const [index, method] of methods.entries()) {
    await reconciler.ingestRpcNotification({ sequence: index + 2, method, params: { turnId: 'turn-warn', message: SECRET_BODY, path: SECRET_OUTPUT, details: SECRET_PROMPT } });
  }
  await reconciler.ingestRpcNotification({ sequence: 6, method: 'guardianWarning', params: { turnId: 'turn-warn', message: SECRET_ARGUMENT } });
  const notices = reconciler.snapshot().events.filter(event => event.noticeKind);
  assert.deepEqual(notices.map(event => event.noticeKind), ['warning', 'guardianWarning', 'configWarning', 'deprecationNotice']);
  assert.equal(notices.filter(event => event.noticeKind === 'guardianWarning').length, 1);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('turn diff and structured plan updates replace safe metadata snapshots', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-replaceable-snapshots' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/plan/updated', params: {
    turnId: 'turn-meta', explanation: 'PUBLIC', plan: [{ step: SECRET_BODY, status: 'pending' }, { step: SECRET_OUTPUT, status: 'inProgress' }],
  } });
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'turn/plan/updated', params: {
    turnId: 'turn-meta', explanation: null, plan: [{ step: SECRET_BODY, status: 'completed' }],
  } });
  await reconciler.ingestRpcNotification({ sequence: 3, method: 'turn/diff/updated', params: {
    turnId: 'turn-meta', diff: `diff --git a/${SECRET_PROMPT} b/${SECRET_PROMPT}\nnew file mode 100644\n`,
  } });
  await reconciler.ingestRpcNotification({ sequence: 4, method: 'turn/diff/updated', params: {
    turnId: 'turn-meta', diff: `diff --git a/${SECRET_ARGUMENT} b/${SECRET_ARGUMENT}\ndeleted file mode 100644\n`,
  } });
  const events = reconciler.snapshot().events;
  const plans = events.filter(event => event.summaryKind === 'plan');
  const diffs = events.filter(event => event.toolKind === 'diff');
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].stepCounts, { pending: 0, inProgress: 0, completed: 1 });
  assert.equal(plans[0].hasExplanation, false);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0].fileCounts, { total: 1, added: 0, deleted: 1, modified: 0 });
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('raw reasoning, command output, and MCP progress or result notifications stay ignored', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-ignored-raw' });
  const methods = [
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'command/exec/outputDelta',
    'item/mcpToolCall/progress',
    'item/mcpToolCall/result',
  ];
  for (const [index, method] of methods.entries()) {
    const result = await reconciler.ingestRpcNotification({
      sequence: index + 1,
      method,
      params: {
        turnId: 'turn-ignored', itemId: `ignored-${index}`,
        delta: SECRET_OUTPUT, output: SECRET_BODY, result: SECRET_PROMPT,
      },
    });
    assert.deepEqual(result.accepted, []);
  }

  assert.deepEqual(reconciler.snapshot().events, []);
  assertNoSecretCanaries(assert, reconciler.snapshot());
});
