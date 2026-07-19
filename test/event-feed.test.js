'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventFeed } = require('../lib/events/event-feed');
const {
  getPrivateAttachmentSource,
  setPrivateAttachmentSource,
} = require('../lib/events/private-attachment-source');

function event(eventId, order, value = eventId) {
  return { eventId, order, type: 'test', value };
}

test('feed deduplicates event ids and publishes an out-of-order batch in canonical order', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  const accepted = feed.publish([
    event('three', 3),
    event('one', 1),
    event('one', 1),
    event('two', 2),
  ]);

  assert.deepEqual(accepted.map(item => item.eventId), ['one', 'two', 'three']);
  assert.deepEqual(accepted.map(item => item.cursor), [1, 2, 3]);
  assert.deepEqual(feed.publish([event('two', 2)]), []);
});

test('feed accepts late events without rewinding cursor and sorts snapshots by event order', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  feed.publish([event('later', 10)]);
  const lateArrival = feed.publish([event('earlier', 5)]);

  assert.equal(lateArrival[0].cursor, 2);
  const snapshot = feed.read({ serverInstanceId: 'wrong-instance', snapshotVersion: 1, cursor: 0 });
  assert.equal(snapshot.mode, 'snapshot');
  assert.deepEqual(snapshot.events.map(item => item.eventId), ['earlier', 'later']);
  assert.deepEqual(snapshot.events.map(item => item.cursor), [2, 1]);
});

test('feed clones preserve private attachment sources without serializing workstation paths', () => {
  const filePath = 'E:\\ProtocolFixtures\\private-user-image.png';
  const attachment = setPrivateAttachmentSource({ name: 'private-user-image.png', mime: 'image/png' }, filePath);
  const feed = new EventFeed({ serverInstanceId: 'server-private-attachment' });
  const accepted = feed.publish([{
    eventId: 'private-attachment-event', order: 1, type: 'message', role: 'user', attachments: [attachment],
  }]);
  const snapshot = feed.snapshot();
  const delta = feed.read({ serverInstanceId: 'server-private-attachment', snapshotVersion: 1, cursor: 0 });

  assert.equal(getPrivateAttachmentSource(accepted[0].attachments[0]), filePath);
  assert.equal(getPrivateAttachmentSource(snapshot.events[0].attachments[0]), filePath);
  assert.equal(getPrivateAttachmentSource(delta.events[0].attachments[0]), filePath);
  assert.equal(JSON.stringify([accepted, snapshot, delta]).includes('ProtocolFixtures'), false);
});

test('feed accepts a private-source supplement even when public attachment metadata is unchanged', () => {
  const filePath = 'E:\\ProtocolFixtures\\late-private-source.png';
  const feed = new EventFeed({ serverInstanceId: 'server-private-supplement' });
  const publicEvent = {
    eventId: 'private-source-supplement', order: 1, type: 'message', role: 'user',
    attachments: [{ name: 'late-private-source.png', mime: 'image/png' }],
  };
  feed.publish([publicEvent]);
  const supplemented = structuredClone(publicEvent);
  setPrivateAttachmentSource(supplemented.attachments[0], filePath);

  const accepted = feed.publish([supplemented]);
  assert.equal(accepted.length, 1);
  assert.equal(getPrivateAttachmentSource(feed.snapshot().events[0].attachments[0]), filePath);
});

test('equal-sequence events preserve first-observed order across upsert and rehydrate', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-equal-order' });
  feed.publish([
    { ...event('z-first', 7), sequence: 7, state: 'running' },
    { ...event('a-second', 7), sequence: 7, state: 'running' },
  ]);

  assert.deepEqual(feed.snapshot().events.map(item => item.eventId), ['z-first', 'a-second']);
  assert.deepEqual(feed.snapshot().events.map(item => item.sourceOrdinal), [1, 2]);

  feed.publish([{ ...event('z-first', 7), sequence: 7, state: 'succeeded' }]);
  assert.deepEqual(feed.snapshot().events.map(item => item.eventId), ['z-first', 'a-second']);
  assert.deepEqual(feed.snapshot().events.map(item => item.sourceOrdinal), [1, 2]);

  const rehydrated = feed.replaceSnapshot([
    { ...event('z-first', 7), sequence: 7, state: 'succeeded' },
    { ...event('a-second', 7), sequence: 7, state: 'running' },
  ]);
  assert.deepEqual(rehydrated.events.map(item => item.eventId), ['z-first', 'a-second']);
  assert.deepEqual(rehydrated.events.map(item => item.sourceOrdinal), [1, 2]);
});

test('matching server and snapshot metadata returns only events after the client cursor', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  feed.publish([event('one', 1), event('two', 2), event('three', 3)]);

  assert.deepEqual(feed.read({
    serverInstanceId: 'server-a',
    snapshotVersion: 1,
    cursor: 1,
  }), {
    mode: 'delta',
    serverInstanceId: 'server-a',
    snapshotVersion: 1,
    cursor: 3,
    events: [
      { ...event('two', 2), sourceOrdinal: 2, cursor: 2 },
      { ...event('three', 3), sourceOrdinal: 3, cursor: 3 },
    ],
  });
});

test('one reasoning status per turn is compacted in snapshots while deltas retain every revision', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  feed.publish([
    { eventId: 'reasoning-turn-a', order: 1, type: 'summary', summaryKind: 'reasoning', turnId: 'turn-a', body: 'first' },
    event('command-one', 2),
  ]);
  const update = feed.publish([
    { eventId: 'reasoning-turn-a', order: 3, type: 'summary', summaryKind: 'reasoning', turnId: 'turn-a', body: 'second' },
  ]);

  assert.equal(update.length, 1);
  assert.equal(update[0].cursor, 3);
  const snapshot = feed.snapshot();
  assert.equal(snapshot.cursor, 3);
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events.find(item => item.eventId === 'reasoning-turn-a').body, 'second');
  assert.equal(feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 2 }).mode, 'delta');
  const fullDelta = feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 0 });
  assert.equal(fullDelta.mode, 'delta');
  assert.deepEqual(fullDelta.events.map(item => item.cursor), [1, 2, 3]);
  assert.deepEqual(fullDelta.events.filter(item => item.eventId === 'reasoning-turn-a')
    .map(item => item.body), ['first', 'second']);
  assert.deepEqual(feed.publish([
    { eventId: 'reasoning-turn-a', order: 4, type: 'summary', summaryKind: 'reasoning', turnId: 'turn-a', body: 'second' },
  ]), []);
});

test('bounded revision journal forces a snapshot when a client cursor falls behind the retained window', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-bounded-journal', maxChanges: 2 });
  feed.publish([event('one', 1), event('two', 2), event('three', 3)]);

  const stale = feed.read({ serverInstanceId: 'server-bounded-journal', snapshotVersion: 1, cursor: 0 });
  assert.equal(stale.mode, 'snapshot');
  assert.equal(stale.cursor, 3);
  assert.deepEqual(stale.events.map(item => item.eventId), ['one', 'two', 'three']);

  const current = feed.read({ serverInstanceId: 'server-bounded-journal', snapshotVersion: 1, cursor: 1 });
  assert.equal(current.mode, 'delta');
  assert.deepEqual(current.events.map(item => item.cursor), [2, 3]);
});

test('per-turn presentation revision advances only when that turn changes', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-turn-revision' });
  feed.publish([
    { eventId: 'turn-a-reasoning', order: 1, type: 'summary', turnId: 'turn-a', body: 'first' },
    { eventId: 'turn-b-command', order: 2, type: 'summary', turnId: 'turn-b', body: 'command' },
  ]);

  assert.equal(feed.turnRevision('turn-a'), 'v1-c1');
  assert.equal(feed.turnRevision('turn-b'), 'v1-c2');
  assert.equal(feed.turnRevision('missing'), '');

  feed.publish([
    { eventId: 'turn-a-reasoning', order: 3, type: 'summary', turnId: 'turn-a', body: 'second' },
  ]);
  assert.equal(feed.turnRevision('turn-a'), 'v1-c3');
  assert.equal(feed.turnRevision('turn-b'), 'v1-c2');

  feed.replaceSnapshot([
    { eventId: 'turn-a-reasoning', order: 1, type: 'summary', turnId: 'turn-a', body: 'rehydrated' },
  ]);
  assert.equal(feed.turnRevision('turn-a'), 'v2-c1');
  assert.equal(feed.turnRevision('turn-b'), '');
});

test('generic activities upsert state, count, and attachments under one stable event id', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  const running = {
    eventId: 'image-view-1',
    order: 1,
    type: 'summary',
    summaryKind: 'tool',
    toolKind: 'imageView',
    state: 'running',
    count: 1,
    attachments: [{ name: 'first.png', filePath: 'E:\\fixtures\\first.png' }],
  };
  const completed = {
    ...running,
    order: 2,
    state: 'succeeded',
    count: 2,
    attachments: [
      ...running.attachments,
      { name: 'second.png', filePath: 'E:\\fixtures\\second.png' },
    ],
  };

  assert.equal(feed.publish([running])[0].cursor, 1);
  const update = feed.publish([completed]);
  assert.equal(update.length, 1);
  assert.equal(update[0].cursor, 2);
  assert.equal(feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 1 }).mode, 'delta');
  const fullDelta = feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 0 });
  assert.equal(fullDelta.mode, 'delta');
  assert.deepEqual(fullDelta.events.map(item => item.cursor), [1, 2]);
  assert.deepEqual(fullDelta.events.map(item => item.state), ['running', 'succeeded']);
  const snapshot = feed.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].state, 'succeeded');
  assert.equal(snapshot.events[0].count, 2);
  assert.deepEqual(snapshot.events[0].attachments.map(item => item.name), ['first.png', 'second.png']);
});

test('multi command lifecycle upsert replaces the outer detail array without appending stale children', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-multi-command' });
  const running = {
    eventId: 'outer-command', order: 1, type: 'summary', summaryKind: 'tool', toolKind: 'command',
    state: 'running', count: 2, displayDetails: ['Get-Date', 'Get-Location'],
  };
  const completed = {
    ...running, order: 2, state: 'succeeded', count: 3,
    displayDetails: ['Get-Date', 'Get-ChildItem', 'Get-ChildItem'],
  };

  feed.publish([running]);
  const accepted = feed.publish([completed]);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].displayDetails, completed.displayDetails);
  const snapshot = feed.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].count, 3);
  assert.deepEqual(snapshot.events[0].displayDetails, completed.displayDetails);
  assert.equal(snapshot.events[0].sourceOrdinal, 1);
});

test('server instance or snapshot version mismatch forces a full snapshot', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  feed.publish([event('one', 1), event('two', 2)]);

  for (const request of [
    { serverInstanceId: 'server-old', snapshotVersion: 1, cursor: 1 },
    { serverInstanceId: 'server-a', snapshotVersion: 0, cursor: 1 },
  ]) {
    const result = feed.read(request);
    assert.equal(result.mode, 'snapshot');
    assert.equal(result.serverInstanceId, 'server-a');
    assert.equal(result.snapshotVersion, 1);
    assert.equal(result.cursor, 2);
    assert.deepEqual(result.events.map(item => item.eventId), ['one', 'two']);
  }
});

test('full rehydrate replaces events, increments snapshot version, and restarts cursor', () => {
  const feed = new EventFeed({ serverInstanceId: 'server-a' });
  feed.publish([event('stale', 1)]);

  const replaced = feed.replaceSnapshot([
    event('current-two', 2),
    event('current-one', 1),
    event('current-one', 1),
  ]);

  assert.equal(replaced.mode, 'snapshot');
  assert.equal(replaced.snapshotVersion, 2);
  assert.equal(replaced.cursor, 2);
  assert.deepEqual(replaced.events.map(item => item.eventId), ['current-one', 'current-two']);
  assert.deepEqual(replaced.events.map(item => item.cursor), [1, 2]);
  assert.equal(feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 1 }).mode, 'snapshot');
});
