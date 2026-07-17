'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventReconciler } = require('../lib/events/reconciler');
const { getPrivateAttachmentSource } = require('../lib/events/private-attachment-source');
const {
  SECRET_ARGUMENT,
  SECRET_BODY,
  SECRET_OUTPUT,
  SECRET_PROMPT,
  SYNTHETIC_IMAGE_DIR,
  assertNoSecretCanaries,
  rpcItemNotification,
} = require('./fixtures/session-events');

const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

function fallbackCommentary(text, order, timestamp = '2026-07-10T00:00:01.000Z') {
  return {
    type: 'event_msg', timestamp, _stableOrder: order,
    payload: { type: 'agent_message', phase: 'commentary', message: text },
  };
}

function canonicalCommentary(id, text, order, timestamp = '2026-07-10T00:00:01.000Z') {
  return {
    type: 'response_item', timestamp, _stableOrder: order,
    payload: {
      type: 'message', id, role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text }],
    },
  };
}

function canonicalUser(id, text, turnId, order, timestamp) {
  return {
    type: 'response_item', timestamp, _stableOrder: order,
    payload: {
      type: 'message', id, role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

function fallbackUser(text, order, timestamp, localImages = []) {
  return {
    type: 'event_msg', timestamp, _stableOrder: order,
    payload: { type: 'user_message', message: text, local_images: localImages },
  };
}

function commentaryEvents(reconciler) {
  return reconciler.snapshot().events.filter(event => event.summaryKind === 'commentary');
}

test('initial event snapshot exposes one canonical row for an adjacent fallback and canonical desktop narrative', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-snapshot' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', 'turn-narrative-snapshot'), _stableOrder: 1 }, 0),
    fileEntry(fallbackCommentary('One desktop-visible checkpoint', 2), 100),
    fileEntry(canonicalCommentary('msg-narrative-snapshot', 'One desktop-visible checkpoint', 2), 200),
  ]);

  const events = commentaryEvents(reconciler);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'msg-narrative-snapshot');
  assert.equal(events[0].source, 'file', 'canonical file provenance stays public');
  assert.match(events[0].eventId, /^[a-f0-9]{64}$/);
});

test('a canonical delta replaces an already published fallback through one stable event identity', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-delta' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', 'turn-narrative-delta'), _stableOrder: 1 }, 0),
    fileEntry(fallbackCommentary('One delayed canonical checkpoint', 2), 100),
  ]);
  const fallback = commentaryEvents(reconciler)[0];
  const cursorBeforeCanonical = reconciler.snapshot().cursor;

  const accepted = reconciler.ingestFileEntries([
    fileEntry(canonicalCommentary('msg-narrative-delta', 'One delayed canonical checkpoint', 2), 200),
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].eventId, fallback.eventId);
  assert.equal(accepted[0].id, 'msg-narrative-delta');
  assert.equal(accepted[0].cursor, cursorBeforeCanonical + 1);

  const delta = reconciler.read({
    serverInstanceId: 'server-narrative-delta',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: cursorBeforeCanonical,
  });
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].eventId, fallback.eventId);
  assert.equal(delta.events[0].id, 'msg-narrative-delta');
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id), ['msg-narrative-delta']);
});

test('rehydrate and reconnect snapshots do not revive a replaced narrative fallback', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-rehydrate' });
  const entries = [
    fileEntry({ ...turnItem('task_started', 'turn-narrative-rehydrate'), _stableOrder: 1 }, 0),
    fileEntry(fallbackCommentary('One reconnect checkpoint', 2), 100),
    fileEntry(canonicalCommentary('msg-narrative-rehydrate', 'One reconnect checkpoint', 2), 200),
  ];
  reconciler.ingestFileEntries(entries);
  const oldVersion = reconciler.snapshot().snapshotVersion;
  reconciler.rehydrate(entries);

  const reconnect = reconciler.read({
    serverInstanceId: 'server-narrative-rehydrate', snapshotVersion: oldVersion, cursor: 0,
  });
  assert.equal(reconnect.mode, 'snapshot');
  assert.equal(reconnect.snapshotVersion, oldVersion + 1);
  const commentary = reconnect.events.filter(event => event.summaryKind === 'commentary');
  assert.equal(commentary.length, 1);
  assert.equal(commentary[0].id, 'msg-narrative-rehydrate');
});

test('fallback-canonical pairs with repeated text keep distinct delta identities across snapshot and rehydrate', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-fcfc' });
  const entries = [
    fileEntry({ ...turnItem('task_started', 'turn-narrative-fcfc'), _stableOrder: 1 }, 0),
    fileEntry(fallbackCommentary('Repeated desktop checkpoint', 2), 100),
    fileEntry(canonicalCommentary('msg-narrative-fcfc-1', 'Repeated desktop checkpoint', 2), 200),
    fileEntry(fallbackCommentary('Repeated desktop checkpoint', 3, '2026-07-10T00:00:02.000Z'), 300),
    fileEntry(canonicalCommentary('msg-narrative-fcfc-2', 'Repeated desktop checkpoint', 3, '2026-07-10T00:00:02.000Z'), 400),
  ];

  reconciler.ingestFileEntries([entries[0]]);
  const firstFallback = reconciler.ingestFileEntries([entries[1]])[0];
  const firstCanonical = reconciler.ingestFileEntries([entries[2]])[0];
  assert.equal(firstCanonical.eventId, firstFallback.eventId, 'the real twin still replaces its fallback');
  const firstPairCursor = reconciler.snapshot().cursor;

  const secondFallback = reconciler.ingestFileEntries([entries[3]])[0];
  assert.ok(secondFallback, 'the first pair consumes only one fallback representation');
  assert.notEqual(secondFallback.eventId, firstCanonical.eventId);
  assert.equal(secondFallback.cursor, firstPairCursor + 1);
  const secondCanonical = reconciler.ingestFileEntries([entries[4]])[0];
  assert.equal(secondCanonical.eventId, secondFallback.eventId, 'the later canonical replaces the standalone fallback');
  assert.notEqual(secondCanonical.eventId, firstCanonical.eventId, 'the second legal pair owns a new event identity');
  assert.equal(secondCanonical.cursor, firstPairCursor + 2);

  const delta = reconciler.read({
    serverInstanceId: 'server-narrative-fcfc',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: secondFallback.cursor,
  });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.events.map(event => event.id), ['msg-narrative-fcfc-2']);
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id), [
    'msg-narrative-fcfc-1', 'msg-narrative-fcfc-2',
  ]);

  const oldVersion = reconciler.snapshot().snapshotVersion;
  reconciler.rehydrate(entries);
  const reconnect = reconciler.read({
    serverInstanceId: 'server-narrative-fcfc', snapshotVersion: oldVersion, cursor: 0,
  });
  assert.equal(reconnect.mode, 'snapshot');
  assert.deepEqual(
    reconnect.events.filter(event => event.summaryKind === 'commentary').map(event => event.id),
    ['msg-narrative-fcfc-1', 'msg-narrative-fcfc-2'],
  );
});

test('canonical-fallback-fallback consumes one twin and publishes the next fallback across delta and rehydrate', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-cff' });
  const entries = [
    fileEntry({ ...turnItem('task_started', 'turn-narrative-cff'), _stableOrder: 1 }, 0),
    fileEntry(canonicalCommentary('msg-narrative-cff-1', 'Repeated CFF checkpoint', 2), 100),
    fileEntry(fallbackCommentary('Repeated CFF checkpoint', 2), 200),
    fileEntry(fallbackCommentary('Repeated CFF checkpoint', 3, '2026-07-10T00:00:02.000Z'), 300),
    fileEntry(canonicalCommentary('msg-narrative-cff-2', 'Repeated CFF checkpoint', 3, '2026-07-10T00:00:02.000Z'), 400),
  ];

  reconciler.ingestFileEntries([entries[0]]);
  const firstCanonical = reconciler.ingestFileEntries([entries[1]])[0];
  const cursorBeforeTwin = reconciler.snapshot().cursor;
  assert.deepEqual(reconciler.ingestFileEntries([entries[2]]), []);
  assert.equal(reconciler.snapshot().cursor, cursorBeforeTwin);

  const standaloneFallback = reconciler.ingestFileEntries([entries[3]])[0];
  assert.ok(standaloneFallback);
  assert.notEqual(standaloneFallback.eventId, firstCanonical.eventId);
  assert.equal(standaloneFallback.cursor, cursorBeforeTwin + 1);
  const fallbackDelta = reconciler.read({
    serverInstanceId: 'server-narrative-cff',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: cursorBeforeTwin,
  });
  assert.equal(fallbackDelta.mode, 'delta');
  assert.deepEqual(fallbackDelta.events.map(event => event.eventId), [standaloneFallback.eventId]);

  const secondCanonical = reconciler.ingestFileEntries([entries[4]])[0];
  assert.equal(secondCanonical.eventId, standaloneFallback.eventId);
  assert.equal(secondCanonical.cursor, standaloneFallback.cursor + 1);
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id || ''), [
    'msg-narrative-cff-1', 'msg-narrative-cff-2',
  ]);

  const oldVersion = reconciler.snapshot().snapshotVersion;
  reconciler.rehydrate(entries);
  const reconnect = reconciler.read({
    serverInstanceId: 'server-narrative-cff', snapshotVersion: oldVersion, cursor: 0,
  });
  assert.equal(reconnect.mode, 'snapshot');
  assert.deepEqual(
    reconnect.events.filter(event => event.summaryKind === 'commentary').map(event => event.id || ''),
    ['msg-narrative-cff-1', 'msg-narrative-cff-2'],
  );
});

test('fallback-canonical-fallback publishes the next fallback with a new cursor and survives rehydrate', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-fcf' });
  const entries = [
    fileEntry({ ...turnItem('task_started', 'turn-narrative-fcf'), _stableOrder: 1 }, 0),
    fileEntry(fallbackCommentary('Repeated FCF checkpoint', 2), 100),
    fileEntry(canonicalCommentary('msg-narrative-fcf-1', 'Repeated FCF checkpoint', 2), 200),
    fileEntry(fallbackCommentary('Repeated FCF checkpoint', 3, '2026-07-10T00:00:02.000Z'), 300),
  ];

  reconciler.ingestFileEntries([entries[0]]);
  const firstFallback = reconciler.ingestFileEntries([entries[1]])[0];
  const firstCanonical = reconciler.ingestFileEntries([entries[2]])[0];
  assert.equal(firstCanonical.eventId, firstFallback.eventId);
  const cursorAfterPair = reconciler.snapshot().cursor;

  const standaloneFallback = reconciler.ingestFileEntries([entries[3]])[0];
  assert.ok(standaloneFallback);
  assert.notEqual(standaloneFallback.eventId, firstCanonical.eventId);
  assert.equal(standaloneFallback.cursor, cursorAfterPair + 1);
  const delta = reconciler.read({
    serverInstanceId: 'server-narrative-fcf',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: cursorAfterPair,
  });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.events.map(event => event.eventId), [standaloneFallback.eventId]);
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id || ''), [
    'msg-narrative-fcf-1', '',
  ]);

  const oldVersion = reconciler.snapshot().snapshotVersion;
  reconciler.rehydrate(entries);
  const reconnect = reconciler.read({
    serverInstanceId: 'server-narrative-fcf', snapshotVersion: oldVersion, cursor: 0,
  });
  assert.equal(reconnect.mode, 'snapshot');
  assert.deepEqual(
    reconnect.events.filter(event => event.summaryKind === 'commentary').map(event => event.id || ''),
    ['msg-narrative-fcf-1', ''],
  );
});

test('canonical-fallback pairs with repeated text keep two canonicals and stable cursors after rehydrate', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-cfcf' });
  const entries = [
    fileEntry({ ...turnItem('task_started', 'turn-narrative-cfcf'), _stableOrder: 1 }, 0),
    fileEntry(canonicalCommentary('msg-narrative-cfcf-1', 'Repeated canonical checkpoint', 2), 100),
    fileEntry(fallbackCommentary('Repeated canonical checkpoint', 2), 200),
    fileEntry(canonicalCommentary('msg-narrative-cfcf-2', 'Repeated canonical checkpoint', 3, '2026-07-10T00:00:02.000Z'), 300),
    fileEntry(fallbackCommentary('Repeated canonical checkpoint', 3, '2026-07-10T00:00:02.000Z'), 400),
  ];

  reconciler.ingestFileEntries([entries[0]]);
  const firstCanonical = reconciler.ingestFileEntries([entries[1]])[0];
  const firstCursor = reconciler.snapshot().cursor;
  assert.deepEqual(reconciler.ingestFileEntries([entries[2]]), []);
  assert.equal(reconciler.snapshot().cursor, firstCursor);
  const secondCanonical = reconciler.ingestFileEntries([entries[3]])[0];
  assert.notEqual(secondCanonical.eventId, firstCanonical.eventId);
  const secondCursor = reconciler.snapshot().cursor;
  assert.deepEqual(reconciler.ingestFileEntries([entries[4]]), []);
  assert.equal(reconciler.snapshot().cursor, secondCursor);
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id), [
    'msg-narrative-cfcf-1', 'msg-narrative-cfcf-2',
  ]);

  reconciler.rehydrate(entries);
  assert.deepEqual(commentaryEvents(reconciler).map(event => event.id), [
    'msg-narrative-cfcf-1', 'msg-narrative-cfcf-2',
  ]);
});

test('narrative replacement preserves two canonicals, two fallbacks, operation boundaries, and kind boundaries', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-narrative-boundaries' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', 'turn-narrative-boundaries'), _stableOrder: 1 }, 0),
    fileEntry(canonicalCommentary('msg-canonical-a', 'Independent canonical', 2), 100),
    fileEntry(canonicalCommentary('msg-canonical-b', 'Independent canonical', 3, '2026-07-10T00:00:02.000Z'), 200),
    fileEntry(fallbackCommentary('Independent fallback', 4, '2026-07-10T00:00:03.000Z'), 300),
    fileEntry(fallbackCommentary('Independent fallback', 5, '2026-07-10T00:00:04.000Z'), 400),
    fileEntry(fallbackCommentary('Separated checkpoint', 6, '2026-07-10T00:00:05.000Z'), 500),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T00:00:05.500Z', _stableOrder: 7,
      payload: { type: 'function_call', id: 'call-boundary', name: 'shell_command', arguments: '{}' },
    }, 600),
    fileEntry(canonicalCommentary('msg-separated', 'Separated checkpoint', 8, '2026-07-10T00:00:06.000Z'), 700),
    fileEntry(fallbackCommentary('Cross-kind checkpoint', 9, '2026-07-10T00:00:07.000Z'), 800),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T00:00:07.000Z', _stableOrder: 9,
      payload: { type: 'plan', id: 'plan-cross-kind', text: 'Cross-kind checkpoint' },
    }, 900),
  ]);

  const events = reconciler.snapshot().events;
  assert.deepEqual(
    events.filter(event => event.body === 'Independent canonical').map(event => event.id),
    ['msg-canonical-a', 'msg-canonical-b'],
  );
  assert.equal(
    events.filter(event => event.body === 'Independent fallback' && !event.id).length,
    2,
  );
  assert.equal(events.filter(event => event.body === 'Separated checkpoint').length, 2);
  assert.equal(events.filter(event => event.body === 'Cross-kind checkpoint').length, 2);
});

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

test('turn snapshots preserve rollout order across UUID versions, updates, rehydrate, and restart', () => {
  const legacyContinuationTurn = '4b1bc5ce-1c68-400e-8473-adee9914adc4';
  const currentTurn = '019f66aa-e653-7c22-8e5f-0cdb5d1d5e7a';
  const entries = [
    fileEntry(turnItem('task_started', legacyContinuationTurn, '2026-07-09T19:44:51.763Z'), 100),
    fileEntry(turnItem('task_complete', legacyContinuationTurn, '2026-07-09T19:49:00.000Z'), 200),
    fileEntry(turnItem('task_started', currentTurn, '2026-07-15T17:00:00.000Z'), 300),
  ];
  const expected = [
    { turnId: legacyContinuationTurn, state: 'completed' },
    { turnId: currentTurn, state: 'started' },
  ];

  const reconciler = new EventReconciler({ serverInstanceId: 'server-turn-order' });
  reconciler.ingestFileEntries(entries);
  assert.deepEqual(reconciler.turnSnapshot(), expected);
  const initialSnapshot = reconciler.snapshot();
  assert.deepEqual(initialSnapshot.turns, expected);
  assert.deepEqual(reconciler.read({
    serverInstanceId: initialSnapshot.serverInstanceId,
    snapshotVersion: initialSnapshot.snapshotVersion,
    cursor: initialSnapshot.cursor,
  }).turns, expected, 'cursor reads retain the same chronological turn order');

  reconciler.ingestFileEntries([
    fileEntry(turnItem('task_complete', legacyContinuationTurn, '2026-07-16T00:00:00.000Z'), 400),
  ]);
  assert.deepEqual(reconciler.turnSnapshot(), expected, 'a later lifecycle replay cannot move an old turn');

  reconciler.rehydrate(entries);
  assert.deepEqual(reconciler.snapshot().turns, expected);

  const restarted = new EventReconciler({ serverInstanceId: 'server-turn-order-restart' });
  restarted.rehydrate(entries);
  assert.deepEqual(restarted.snapshot().turns, expected);
});

test('a timestamp-less realtime turn appends after file history until its file anchor arrives', async () => {
  const oldTurn = '89d83326-4768-46c5-af25-b0338f2298e2';
  const currentTurn = '019f66aa-e653-7c22-8e5f-0cdb5d1d5e7a';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-realtime-turn-order' });
  reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', oldTurn, '2026-07-09T21:00:00.000Z'), 100),
    fileEntry(turnItem('task_complete', oldTurn, '2026-07-09T21:01:00.000Z'), 200),
  ]);

  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { threadId: 'thread-main', turn: { id: currentTurn } },
  });
  const expected = [
    { turnId: oldTurn, state: 'completed' },
    { turnId: currentTurn, state: 'started' },
  ];
  assert.deepEqual(reconciler.snapshot().turns, expected);

  reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', currentTurn, '2026-07-15T17:00:00.000Z'), 300),
  ]);
  assert.deepEqual(reconciler.snapshot().turns, expected, 'the authoritative file replay keeps the same slot');
});

test('a stale file start still upgrades a completed RPC turn to its authoritative rollout position', async () => {
  const earlierFileTurn = '89d83326-4768-46c5-af25-b0338f2298e2';
  const rpcFirstTurn = '019f66aa-e653-7c22-8e5f-0cdb5d1d5e7a';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-late-authoritative-anchor' });
  await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'turn/started',
    params: { threadId: 'thread-main', turn: { id: rpcFirstTurn } },
  });
  await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'turn/completed',
    params: { threadId: 'thread-main', turn: { id: rpcFirstTurn, status: 'completed' } },
  });
  reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', earlierFileTurn, '2026-07-09T21:00:00.000Z'), 100),
    fileEntry(turnItem('task_complete', earlierFileTurn, '2026-07-09T21:01:00.000Z'), 200),
  ]);
  assert.deepEqual(reconciler.snapshot().turns.map(turn => turn.turnId), [rpcFirstTurn, earlierFileTurn]);

  const accepted = reconciler.ingestFileEntries([
    fileEntry(turnItem('task_started', rpcFirstTurn, '2026-07-15T17:00:00.000Z'), 300),
  ]);
  assert.deepEqual(accepted, [], 'stale lifecycle rows remain unpublished');
  assert.deepEqual(reconciler.snapshot().turns, [
    { turnId: earlierFileTurn, state: 'completed' },
    { turnId: rpcFirstTurn, state: 'completed' },
  ]);

  reconciler.rehydrate([
    fileEntry(turnItem('task_started', rpcFirstTurn, '2026-07-15T17:00:00.000Z'), 300),
    fileEntry(turnItem('task_complete', rpcFirstTurn, '2026-07-15T17:01:00.000Z'), 400),
  ]);
  assert.deepEqual(reconciler.snapshot().turns, [
    { turnId: rpcFirstTurn, state: 'completed' },
  ], 'a truncated full replay rebuilds anchors only from surviving file rows');
});

test('paired user records keep one public event and merge safe attachments', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const accepted = reconciler.ingestFileEntries([
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T10:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [{
        type: 'input_text',
         text: '# Files mentioned by the user:\n## a.png: C:/private/a.png\n## spec.txt: C:/private/spec.txt\n## My request for Codex:\n查看图片',
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
  assert.deepEqual(userEvents[0].attachments.map(item => item.name), ['a.png', 'spec.txt']);
  assert.equal(getPrivateAttachmentSource(userEvents[0].attachments[0]), 'C:/private/a.png');
  assert.equal(JSON.stringify(userEvents).includes('C:/private'), false);
  assert.equal(JSON.stringify(userEvents).includes('base64'), false);
});

test('nested file envelope pairs with the desktop user_message and keeps one process owner', () => {
  const turnId = 'turn-nested-user-envelope';
  const inner = '# Files mentioned by the user:\n## inner.png: C:/private/inner.png\n## My request for Codex:\n检查长线程';
  const outer = `# Files mentioned by the user:\n## outer.png: C:/private/outer.png\n## My request for Codex:\n${inner}`;
  const reconciler = new EventReconciler({ serverInstanceId: 'server-nested-user-envelope' });
  reconciler.rehydrate([
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-17T15:10:33.000Z'), _stableOrder: 1 }, 0),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-17T15:10:33.260Z', _stableOrder: 2,
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: outer }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }, 100),
    fileEntry({
      type: 'event_msg', timestamp: '2026-07-17T15:10:33.262Z', _stableOrder: 3,
      payload: { type: 'user_message', message: '检查长线程', local_images: ['C:/private/inner.png'] },
    }, 200),
  ]);

  const users = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, '检查长线程');
  assert.equal(users[0].turnId, turnId);
  assert.deepEqual(users[0].attachments.map(item => item.name), ['outer.png', 'inner.png']);
});

test('visible reasoning boundary keeps same-text user actions distinct across delta snapshot and restart', () => {
  const turnId = 'turn-user-boundary';
  const entries = [
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-10T11:00:00.000Z'), _stableOrder: 1 }, 0),
    fileEntry(fallbackUser('确认', 2, '2026-07-10T11:00:00.100Z'), 100),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T11:00:00.300Z', _stableOrder: 3,
      payload: {
        type: 'reasoning', id: 'reasoning-user-boundary',
        summary: [{ type: 'summary_text', text: '处理下一步' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }, 200),
    fileEntry(canonicalUser('canonical-after-reasoning', '确认', turnId, 4, '2026-07-10T11:00:00.600Z'), 300),
  ];
  const reconciler = new EventReconciler({ serverInstanceId: 'server-user-boundary' });
  reconciler.ingestFileEntries(entries.slice(0, 3));
  const beforeCanonical = reconciler.snapshot();
  const fallback = beforeCanonical.events.find(event => event.role === 'user');

  const accepted = reconciler.ingestFileEntries(entries.slice(3));
  const canonical = accepted.find(event => event.role === 'user');
  assert.ok(canonical);
  assert.notEqual(canonical.eventId, fallback.eventId, 'reasoning closes adjacency before the next user action');

  const delta = reconciler.read({
    serverInstanceId: 'server-user-boundary',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: beforeCanonical.cursor,
  });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.events.filter(event => event.role === 'user').map(event => event.eventId), [canonical.eventId]);
  assert.equal(reconciler.snapshot().events.filter(event => event.role === 'user').length, 2);

  const oldVersion = reconciler.snapshot().snapshotVersion;
  reconciler.rehydrate(entries);
  const rehydrated = reconciler.read({
    serverInstanceId: 'server-user-boundary', snapshotVersion: oldVersion, cursor: 0,
  });
  const rehydratedUsers = rehydrated.events.filter(event => event.role === 'user');
  assert.equal(rehydratedUsers.length, 2);

  const restarted = new EventReconciler({ serverInstanceId: 'server-user-boundary-restarted' });
  restarted.rehydrate(entries);
  const restartedUsers = restarted.snapshot().events.filter(event => event.role === 'user');
  assert.equal(restartedUsers.length, 2);
  assert.deepEqual(restartedUsers.map(event => event.eventId), rehydratedUsers.map(event => event.eventId));
});

test('matching stable user record identity can pair complementary records across a visible boundary', () => {
  const turnId = 'turn-stable-user-record';
  const stableId = 'stable-user-record-1';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-stable-user-record' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-10T11:09:59.900Z'), _stableOrder: 1 }, 0),
    fileEntry({
      ...fallbackUser('同一条记录', 2, '2026-07-10T11:10:00.000Z'),
      payload: { type: 'user_message', id: stableId, message: '同一条记录' },
    }, 100),
    fileEntry({
      type: 'response_item', timestamp: '2026-07-10T11:10:00.200Z', _stableOrder: 3,
      payload: {
        type: 'reasoning', id: 'stable-record-boundary',
        summary: [{ type: 'summary_text', text: '同一记录的展示边界' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    }, 200),
    fileEntry(canonicalUser(stableId, '同一条记录', turnId, 4, '2026-07-10T11:10:00.400Z'), 300),
  ]);

  const users = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].turnId, turnId);
  assert.equal(users[0].delivery, 'steer');
});

test('paired active-turn user records keep canonical steer identity while fallback only adds attachments', () => {
  const turnId = 'turn-user-pair-steer';
  const timestamp = '2026-07-10T10:10:00.000Z';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-user-pair-steer' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-10T10:09:59.000Z'), _stableOrder: 1 }, 0),
    fileEntry(canonicalUser('user-canonical-1', '补充桌面任务', turnId, 2, timestamp), 100),
  ]);
  const cursorAfterCanonical = reconciler.snapshot().cursor;
  const canonicalSnapshot = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(canonicalSnapshot.length, 1);
  assert.equal(canonicalSnapshot[0].delivery, 'steer');
  assert.equal(canonicalSnapshot[0].turnId, turnId);

  const accepted = reconciler.ingestFileEntries([
    fileEntry(fallbackUser('补充桌面任务', 3, '2026-07-10T10:10:00.001Z', ['C:/private/input.png']), 200),
  ]);
  assert.equal(accepted.length, 1, 'the safe attachment supplement is one upsert delta');
  assert.equal(accepted[0].cursor, cursorAfterCanonical + 1);
  assert.equal(accepted[0].eventId, canonicalSnapshot[0].eventId);
  assert.equal(accepted[0].delivery, 'steer', 'fallback cannot downgrade canonical delivery');
  assert.equal(accepted[0].turnId, turnId, 'fallback cannot erase canonical protocol turn identity');
  assert.deepEqual(accepted[0].attachments.map(item => item.name), ['input.png']);

  const snapshotUsers = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(snapshotUsers.length, 1, 'the paired desktop records remain exactly once in snapshots');
  assert.equal(snapshotUsers[0].delivery, 'steer');
  assert.equal(snapshotUsers[0].turnId, turnId);
});

test('paired steer semantics survive delta reads, rehydrate, and a fresh reconciler restart', () => {
  const turnId = 'turn-user-pair-rehydrate';
  const timestamp = '2026-07-10T10:20:00.000Z';
  const entries = [
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-10T10:19:59.000Z'), _stableOrder: 1 }, 0),
    fileEntry(canonicalUser('user-canonical-rehydrate', '同轮引导', turnId, 2, timestamp), 100),
    fileEntry(fallbackUser('同轮引导', 3, '2026-07-10T10:20:00.001Z', ['C:/private/guide.png']), 200),
  ];
  const reconciler = new EventReconciler({ serverInstanceId: 'server-user-pair-rehydrate' });
  reconciler.ingestFileEntries(entries.slice(0, 2));
  const cursorAfterCanonical = reconciler.snapshot().cursor;
  reconciler.ingestFileEntries(entries.slice(2));

  const delta = reconciler.read({
    serverInstanceId: 'server-user-pair-rehydrate',
    snapshotVersion: reconciler.snapshot().snapshotVersion,
    cursor: cursorAfterCanonical,
  });
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].delivery, 'steer');
  assert.equal(delta.events[0].turnId, turnId);

  reconciler.rehydrate(entries);
  const rehydrated = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(rehydrated.length, 1);
  assert.equal(rehydrated[0].delivery, 'steer');
  assert.equal(rehydrated[0].turnId, turnId);

  const restarted = new EventReconciler({ serverInstanceId: 'server-user-pair-restarted' });
  restarted.rehydrate(entries);
  const restartedUsers = restarted.snapshot().events.filter(event => event.role === 'user');
  assert.equal(restartedUsers.length, 1);
  assert.equal(restartedUsers[0].delivery, 'steer');
  assert.equal(restartedUsers[0].turnId, turnId);
  assert.equal(restartedUsers[0].eventId, rehydrated[0].eventId, 'stable file identity survives backend restart');
});

test('independent same-text canonical user messages are never mistaken for one source pair', () => {
  const turnId = 'turn-independent-same-user';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-independent-same-user' });
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', turnId, '2026-07-10T10:29:59.000Z'), _stableOrder: 1 }, 0),
    fileEntry(canonicalUser('user-same-1', '确认', turnId, 2, '2026-07-10T10:30:00.000Z'), 100),
    fileEntry(canonicalUser('user-same-2', '确认', turnId, 3, '2026-07-10T10:30:00.500Z'), 200),
  ]);

  const users = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(users.length, 2);
  assert.notEqual(users[0].eventId, users[1].eventId);
  assert.deepEqual(users.map(event => event.delivery), ['steer', 'steer']);
});

test('independent same-text fallback user messages are never merged without a canonical pair identity', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-independent-fallback-user' });
  reconciler.ingestFileEntries([
    fileEntry(fallbackUser('确认', 1, '2026-07-10T10:31:00.000Z'), 0),
    fileEntry(fallbackUser('确认', 2, '2026-07-10T10:31:00.500Z'), 100),
  ]);

  const users = reconciler.snapshot().events.filter(event => event.role === 'user');
  assert.equal(users.length, 2);
  assert.notEqual(users[0].eventId, users[1].eventId);
});

test('user attachment merge state stays bounded while recent paired upserts still merge', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-a' });
  const entries = Array.from({ length: 257 }, (_, index) => fileEntry({
    type: 'event_msg',
    timestamp: new Date(Date.parse('2026-07-10T10:00:00.000Z') + index * 2000).toISOString(),
    payload: { type: 'user_message', message: `message-${index}`, local_images: [`C:/private/${index}.png`] },
  }, index * 100));
  reconciler.ingestFileEntries([
    fileEntry({ ...turnItem('task_started', 'turn-recent', '2026-07-10T09:59:59.999Z'), _stableOrder: -1 }, -100),
    ...entries,
  ]);
  const recentTime = new Date(Date.parse('2026-07-10T10:00:00.000Z') + 256 * 2000 + 1).toISOString();
  const update = reconciler.ingestFileEntries([
    fileEntry(canonicalUser('recent-canonical', 'message-256', 'turn-recent', 300, recentTime), 30000),
  ]);
  const userUpdate = update.find(event => event.role === 'user');

  assert.equal(reconciler.userAttachmentsByEventId.size <= 256, true);
  assert.equal(userUpdate.delivery, 'steer');
  assert.equal(userUpdate.turnId, 'turn-recent');
  assert.deepEqual(userUpdate.attachments.map(item => item.name), ['256.png']);
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
  assert.equal(result.accepted[0].subagent.state, 'completed');
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
  assert.equal(messageSecond.accepted[0].sequence, 3);
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

test('subagent lifecycle publishes only name and public lifecycle state end to end', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-subagent-lifecycle' });
  const started = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'item/started',
    params: { turnId: 'turn-subagent', item: {
      type: 'subAgentActivity', id: 'sub-start', kind: 'started',
      agentThreadId: 'private-thread', taskName: 'backend_audit',
      prompt: SECRET_PROMPT, output: SECRET_OUTPUT, body: SECRET_BODY,
    } },
  });
  const completed = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'item/completed',
    params: { turnId: 'turn-subagent', item: {
      type: 'subAgentActivity', id: 'sub-complete', kind: 'completed',
      agentThreadId: 'private-thread', taskName: 'backend_audit',
      prompt: SECRET_PROMPT, output: SECRET_OUTPUT, body: SECRET_BODY,
    } },
  });

  assert.deepEqual(started.accepted[0].subagent, { name: 'backend_audit', state: 'running' });
  assert.deepEqual(completed.accepted[0].subagent, { name: 'backend_audit', state: 'completed' });
  const serialized = JSON.stringify(reconciler.snapshot());
  assert.doesNotMatch(serialized, /PRIVATE_|private-thread/);
});

test('persisted subagent interactions publish distinct safe running update events', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-subagent-updates' });
  const item = (eventId, kind, timestamp) => ({ item: {
    type: 'event_msg', timestamp, payload: {
      type: 'sub_agent_activity', event_id: eventId, kind,
      agent_thread_id: 'private-update-thread', agent_path: '/root/backend_audit',
      prompt: SECRET_PROMPT, body: SECRET_BODY, arguments: SECRET_ARGUMENT, output: SECRET_OUTPUT,
    },
  } });

  const accepted = reconciler.ingestFileEntries([
    item('sub-start', 'started', '2026-07-14T23:32:25.000Z'),
    item('sub-update-1', 'interacted', '2026-07-14T23:32:26.000Z'),
    item('sub-update-2', 'interacted', '2026-07-14T23:32:27.000Z'),
  ]);

  assert.equal(accepted.length, 3);
  assert.equal(new Set(accepted.map(event => event.eventId)).size, 3);
  assert.deepEqual(accepted.map(event => event.subagent), [
    { name: 'backend_audit', state: 'running' },
    { name: 'backend_audit', state: 'running' },
    { name: 'backend_audit', state: 'running' },
  ]);
  assertNoSecretCanaries(assert, reconciler.snapshot());
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /private-update-thread|sub-update-[12]/);
});

test('rehydration expands one list_agents snapshot into privacy-safe terminal lifecycle rows', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-list-agents-lifecycle' });
  reconciler.rehydrate([
    { nextOffset: 1, item: { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-agents' } } },
    { nextOffset: 2, item: { type: 'response_item', payload: {
      type: 'function_call', name: 'list_agents', call_id: 'list-call', arguments: '{}',
    } } },
    { nextOffset: 3, item: { type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'list-call', output: JSON.stringify({ agents: [
        { agent_name: '/root/backend_audit', agent_status: { completed: 'FINAL_PRIVATE' } },
        { agent_name: '/root/client_audit', agent_status: { errored: 'ERROR_PRIVATE' } },
      ] }),
    } } },
  ]);

  const events = reconciler.snapshot().events.filter(event => event.summaryKind === 'subagent');
  assert.deepEqual(events.map(event => event.subagent), [
    { name: 'backend_audit', state: 'completed' },
    { name: 'client_audit', state: 'failed' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /FINAL_PRIVATE|ERROR_PRIVATE|agent_name/);
});

test('hidden reasoning text deltas never become public events', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-hidden-reasoning' });
  const result = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'item/reasoning/textDelta',
    params: {
      turnId: 'turn-private-reasoning', itemId: 'reasoning-private-1',
      delta: SECRET_BODY, output: SECRET_OUTPUT, token: SECRET_ARGUMENT,
    },
  });

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(reconciler.snapshot().events, []);
  assertNoSecretCanaries(assert, reconciler.snapshot());
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
    turnId: 'turn-meta', diff: `diff --git a/src/old.js b/src/old.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/old.js\n@@ -0,0 +1 @@\n+${SECRET_PROMPT}\n`,
  } });
  await reconciler.ingestRpcNotification({ sequence: 4, method: 'turn/diff/updated', params: {
    turnId: 'turn-meta', diff: `diff --git a/src/current.js b/src/current.js\ndeleted file mode 100644\n--- a/src/current.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-${SECRET_ARGUMENT}\n`,
  } });
  const events = reconciler.snapshot().events;
  const plans = events.filter(event => event.summaryKind === 'plan');
  const diffs = events.filter(event => event.toolKind === 'diff');
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].stepCounts, { pending: 0, inProgress: 0, completed: 1 });
  assert.equal(plans[0].hasExplanation, false);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0].fileCounts, { total: 1, added: 0, deleted: 1, modified: 0 });
  assert.deepEqual(diffs[0].turnDiff.files, [{ id: 'file-1', fileLabel: 'src/current.js',
    changeKind: 'deleted', operation: 'delete', additions: 0, deletions: 1, displayDetail: '+0 -1' }]);
  assertNoRawNotificationCanaries(reconciler.snapshot());
});

test('file patch updates publish ordered safe children and completion replaces them in place', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-file-patch-lifecycle' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/started', params: {
    turn: { id: 'turn-file-patch' },
  } });
  const changes = [
    {
      path: 'E:\\private-workspace\\src\\alpha.js', kind: { type: 'update' },
      diff: `@@ -1 +1,2 @@\n-${SECRET_BODY}\n+safe\n+safe-two\n`,
    },
    {
      path: 'src/beta.js', kind: { type: 'delete' },
      diff: `--- a/src/beta.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-${SECRET_OUTPUT}\n-old-two\n`,
    },
  ];
  const running = await reconciler.ingestRpcNotification({ sequence: 2, method: 'item/fileChange/patchUpdated', params: {
    threadId: 'thread-file-patch', turnId: 'turn-file-patch', itemId: 'file-patch', changes,
  } });
  assert.equal(running.accepted.length, 2);
  assert.deepEqual(running.accepted.map(event => [event.id, event.state, event.fileLabel, event.displayDetail]), [
    ['file-patch:file:1', 'running', 'alpha.js', '+2 -1'],
    ['file-patch:file:2', 'running', 'src/beta.js', '+0 -2'],
  ]);

  await reconciler.ingestRpcNotification({ sequence: 3, method: 'item/completed', params: {
    turnId: 'turn-file-patch', item: { type: 'fileChange', id: 'file-patch', status: 'completed', changes },
  } });
  const files = reconciler.snapshot().events.filter(event => event.toolKind === 'file');
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(event => [event.id, event.state, event.operationKind]), [
    ['file-patch:file:1', 'succeeded', 'file'],
    ['file-patch:file:2', 'succeeded', 'file'],
  ]);
  assert.doesNotMatch(JSON.stringify(files), /private-workspace|SECRET_|@@|\/dev\/null|"diff"/i);
});

test('file patch snapshots remove disappeared children and preserve the surviving slot in place', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-file-patch-shrink' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/started', params: {
    turn: { id: 'turn-file-shrink' },
  } });
  const firstChanges = [
    { path: 'src/alpha.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    { path: 'src/beta.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ];
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'item/fileChange/patchUpdated', params: {
    threadId: 'thread-file-shrink', turnId: 'turn-file-shrink', itemId: 'file-shrink', changes: firstChanges,
  } });
  const beforeShrink = reconciler.snapshot();
  await reconciler.ingestRpcNotification({ sequence: 3, method: 'item/completed', params: {
    turnId: 'turn-file-shrink', item: {
      type: 'fileChange', id: 'file-shrink', status: 'completed', changes: [firstChanges[0]],
    },
  } });

  const files = reconciler.snapshot().events.filter(event => event.toolKind === 'file');
  assert.deepEqual(files.map(event => [event.id, event.fileLabel, event.state]), [
    ['file-shrink:file:1', 'src/alpha.js', 'succeeded'],
  ]);
  assert.equal(files.some(event => event.state === 'running'), false);
  const recovered = reconciler.read({
    serverInstanceId: beforeShrink.serverInstanceId,
    snapshotVersion: beforeShrink.snapshotVersion,
    cursor: beforeShrink.cursor,
  });
  assert.equal(recovered.mode, 'snapshot');
  assert.ok(recovered.snapshotVersion > beforeShrink.snapshotVersion);
  assert.equal(recovered.events.some(event => event.fileLabel === 'src/beta.js'), false);
});

test('rehydration keeps only the final shortened file snapshot', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-file-rehydrate-shrink' });
  const changes = [
    { path: 'src/alpha.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    { path: 'src/beta.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
  ];
  reconciler.rehydrate([
    { nextOffset: 1, item: { type: 'turn_context', payload: { turn_id: 'turn-rehydrate-shrink' } } },
    { nextOffset: 2, item: { type: 'response_item', payload: {
      type: 'fileChange', id: 'file-rehydrate-shrink', status: 'inProgress', changes,
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-rehydrate-shrink' },
    } } },
    { nextOffset: 3, item: { type: 'response_item', payload: {
      type: 'fileChange', id: 'file-rehydrate-shrink', status: 'completed', changes: [changes[0]],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-rehydrate-shrink' },
    } } },
  ]);

  const files = reconciler.snapshot().events.filter(event => event.toolKind === 'file');
  assert.deepEqual(files.map(event => [event.id, event.fileLabel, event.state]), [
    ['file-rehydrate-shrink:file:1', 'src/alpha.js', 'succeeded'],
  ]);
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

test('rawResponseItem completed projects only a paired static exec ImageContent result', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-raw-exec-image' });
  const filePath = `${SYNTHETIC_IMAGE_DIR}\\rpc-viewed.png`;
  const callId = 'rpc-exec-image';
  const started = await reconciler.ingestRpcNotification({
    sequence: 1,
    method: 'rawResponseItem/completed',
    params: {
      threadId: 'thread-image', turnId: 'turn-image',
      item: {
        type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed',
        input: `const r=await tools.view_image({path:${JSON.stringify(filePath)}}); image(r.image_url);`,
      },
    },
  });
  const completed = await reconciler.ingestRpcNotification({
    sequence: 2,
    method: 'rawResponseItem/completed',
    params: {
      threadId: 'thread-image', turnId: 'turn-image',
      item: {
        type: 'custom_tool_call_output', call_id: callId,
        output: [
          { type: 'input_text', text: SECRET_OUTPUT },
          { type: 'input_image', image_url: VALID_PNG_DATA_URL },
        ],
      },
    },
  });

  assert.deepEqual(started.accepted, []);
  assert.equal(completed.accepted.length, 1);
  assert.equal(completed.accepted[0].toolKind, 'imageView');
  assert.equal(completed.accepted[0].turnId, 'turn-image');
  assert.equal(completed.accepted[0].count, 1);
  assert.equal(completed.accepted[0].attachments[0].name, 'rpc-viewed.png');
  assert.equal(getPrivateAttachmentSource(completed.accepted[0].attachments[0]), filePath);
  assertNoSecretCanaries(assert, reconciler.snapshot());
  assert.doesNotMatch(JSON.stringify(reconciler.snapshot()), /base64/);
  assert.equal(JSON.stringify(reconciler.snapshot()).includes(SYNTHETIC_IMAGE_DIR), false);
});

test('rawResponseItem rejects invalid image URLs and consumes the same-turn producer', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'server-invalid-raw-image' });
  const callId = 'raw-invalid-image';
  const input = `const r=await tools.view_image({path:${JSON.stringify(`${SYNTHETIC_IMAGE_DIR}\\raw-invalid.png`)}});image(r.image_url);`;
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'rawResponseItem/completed', params: {
    threadId: 'thread-image', turnId: 'turn-image',
    item: { type: 'custom_tool_call', name: 'exec', call_id: callId, input },
  } });
  const invalid = await reconciler.ingestRpcNotification({ sequence: 2, method: 'rawResponseItem/completed', params: {
    threadId: 'thread-image', turnId: 'turn-image',
    item: { type: 'custom_tool_call_output', call_id: callId,
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,QUJDRA==' }] },
  } });
  const replay = await reconciler.ingestRpcNotification({ sequence: 3, method: 'rawResponseItem/completed', params: {
    threadId: 'thread-image', turnId: 'turn-image',
    item: { type: 'custom_tool_call_output', call_id: callId,
      output: [{ type: 'input_image', image_url: VALID_PNG_DATA_URL }] },
  } });

  assert.deepEqual(invalid.accepted, []);
  assert.deepEqual(replay.accepted, []);
  assert.deepEqual(reconciler.snapshot().events, []);
});

test('rawResponseItem rejects forged trust fields, oversized image data, and image count overflow', async () => {
  const fixtures = [
    {
      callId: 'raw-forged-marker',
      output: [{ type: 'input_image', _verifiedImage: true }],
      payloadFields: { _imageCorrelationOnly: true },
    },
    {
      callId: 'raw-oversized-image',
      output: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(16 * 1024 * 1024)}` }],
    },
    {
      callId: 'raw-too-many-images',
      output: Array.from({ length: 21 }, () => ({ type: 'input_image', image_url: VALID_PNG_DATA_URL })),
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const reconciler = new EventReconciler({ serverInstanceId: `server-${fixture.callId}` });
    const input = `const r=await tools.view_image({path:${JSON.stringify(`${SYNTHETIC_IMAGE_DIR}\\${fixture.callId}.png`)}});image(r.image_url);`;
    await reconciler.ingestRpcNotification({ sequence: 1, method: 'rawResponseItem/completed', params: {
      threadId: 'thread-image', turnId: `turn-${index}`,
      item: { type: 'custom_tool_call', name: 'exec', call_id: fixture.callId, input },
    } });
    const result = await reconciler.ingestRpcNotification({ sequence: 2, method: 'rawResponseItem/completed', params: {
      threadId: 'thread-image', turnId: `turn-${index}`,
      item: { type: 'custom_tool_call_output', call_id: fixture.callId,
        output: fixture.output, ...fixture.payloadFields },
    } });

    assert.deepEqual(result.accepted, [], fixture.callId);
    assert.deepEqual(reconciler.snapshot().events, [], fixture.callId);
  }
});
