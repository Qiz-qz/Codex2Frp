'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventFeed } = require('../lib/events/event-feed');

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
      { ...event('two', 2), cursor: 2 },
      { ...event('three', 3), cursor: 3 },
    ],
  });
});

test('one reasoning status per turn is updated in place and stale cursors recover by snapshot', () => {
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
  assert.equal(feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 0 }).mode, 'snapshot');
  assert.deepEqual(feed.publish([
    { eventId: 'reasoning-turn-a', order: 4, type: 'summary', summaryKind: 'reasoning', turnId: 'turn-a', body: 'second' },
  ]), []);
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
  assert.equal(feed.read({ serverInstanceId: 'server-a', snapshotVersion: 1, cursor: 0 }).mode, 'snapshot');
  const snapshot = feed.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].state, 'succeeded');
  assert.equal(snapshot.events[0].count, 2);
  assert.deepEqual(snapshot.events[0].attachments.map(item => item.name), ['first.png', 'second.png']);
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
