'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDesktopActivity,
  countDesktopActivities,
} = require('../lib/events/desktop-activity-classifier');

test('mixed generic command, file exploration, web search, and image view have non-overlapping counts', () => {
  const result = countDesktopActivities([
    { type: 'commandExecution', id: 'shell', status: 'completed', commandActions: [{ type: 'unknown', command: 'npm test' }] },
    { type: 'commandExecution', id: 'read', status: 'completed', commandActions: [{ type: 'read', command: 'Get-Content a', name: 'a', path: 'E:\\a' }] },
    { type: 'webSearch', id: 'web', query: 'schema', action: null },
    { type: 'imageView', id: 'image', path: 'E:\\private.png' },
  ]);

  assert.deepEqual(result, { shell: 1, file: 1, web: 1, imageView: 1 });
});
test('command lifecycle snapshots retain one stable specialized classification', () => {
  const snapshots = ['inProgress', 'inProgress', 'completed'].map(status => classifyDesktopActivity({
    type: 'commandExecution', id: 'read-1', status,
    commandActions: [{ type: 'listFiles', command: 'Get-ChildItem', path: null }],
  }));

  assert.deepEqual(snapshots.map(value => value.id), ['read-1', 'read-1', 'read-1']);
  assert.deepEqual(snapshots.map(value => value.kind), ['file', 'file', 'file']);
  assert.deepEqual(snapshots.map(value => value.state), ['running', 'running', 'succeeded']);
});

test('counts dedupe lifecycle snapshots by stable item id and unknown status is not success', () => {
  const items = ['inProgress', 'inProgress', 'completed'].map(status => ({
    type: 'commandExecution', id: 'same', status, commandActions: [{ type: 'unknown', command: 'npm test' }],
  }));
  assert.deepEqual(countDesktopActivities(items), { shell: 1 });
  assert.equal(classifyDesktopActivity({ type: 'commandExecution', id: 'future', status: 'future', commandActions: [] }).state, 'unknown');
});
