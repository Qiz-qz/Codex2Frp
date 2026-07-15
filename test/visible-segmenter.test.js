'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { segmentVisibleTimeline } = require('../lib/events/visible-segmenter');

function entry(kind, id, overrides = {}) {
  return {
    id,
    sequence: overrides.sequence ?? 1,
    kind,
    phase: overrides.phase || (kind === 'commentary' ? 'commentary' : 'activity'),
    state: overrides.state || 'succeeded',
    provenance: { source: 'file', eventId: id, ordinal: overrides.ordinal ?? 1 },
    ...overrides,
  };
}

test('visible commentary closes a command segment', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'a'), entry('command', 'b'),
    entry('commentary', 'next', { publicNarrative: 'Next step' }),
    entry('command', 'c'), entry('command', 'd'),
  ]);

  assert.deepEqual(segments.map(segment => [segment.kind, segment.count]), [
    ['command', 2], ['commentary', 1], ['command', 2],
  ]);
  assert.notEqual(segments[0].id, segments[2].id);
});

test('lifecycle updates for one command update in place and count once', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'command-a', { state: 'running', title: 'Run tests', durationMs: 20 }),
    entry('command', 'command-a', { state: 'running', title: 'Run tests', durationMs: 40 }),
    entry('command', 'command-a', { state: 'succeeded', title: 'Run tests', durationMs: 75 }),
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].count, 1);
  assert.equal(segments[0].state, 'succeeded');
  assert.deepEqual(segments[0].items, [{
    id: 'command-a', title: 'Run tests', state: 'succeeded', durationMs: 75,
    operationKind: 'command',
  }]);
});

test('a lifecycle update without count preserves the original operation contribution', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'batched-command', { state: 'running', count: 3 }),
    entry('command', 'batched-command', { state: 'succeeded', durationMs: 50 }),
  ]);

  assert.equal(segments[0].count, 3);
  assert.equal(segments[0].items.length, 1);
});

test('late lifecycle data updates its closed operation without merging later groups', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'command-a', { state: 'running', title: 'Compile' }),
    entry('commentary', 'commentary-a', { publicNarrative: 'Checking result' }),
    entry('command', 'command-b', { state: 'running', title: 'Test' }),
    entry('command', 'command-a', { state: 'failed', title: 'Compile', durationMs: 12 }),
  ]);

  assert.deepEqual(segments.map(segment => [segment.kind, segment.count, segment.state]), [
    ['command', 1, 'failed'], ['commentary', 1, 'succeeded'], ['command', 1, 'running'],
  ]);
  assert.equal(segments[0].items[0].durationMs, 12);
  assert.equal(segments[2].items[0].id, 'command-b');
});

test('visible file and image details expose only allowlisted desktop metadata', () => {
  const privateCanaries = [
    'C:\\Users\\fixture-user\\secret.txt', 'RAW_COMMAND_ARGUMENT', 'RAW_COMMAND_OUTPUT',
    'SUBAGENT_PROMPT', 'HIDDEN_REASONING', 'TOKEN_SECRET',
  ];
  const segments = segmentVisibleTimeline([
    entry('file', 'file-a', {
      title: 'Edited file', fileLabel: 'src/server.js', changeKind: 'modified',
      path: privateCanaries[0], arguments: privateCanaries[1], output: privateCanaries[2],
    }),
    entry('image', 'image-a', {
      title: 'Viewed image', attachments: [{
        name: 'result.png', mime: 'image/png', url: '/codex/attachment/0123456789abcdef0123456789abcdef',
        filePath: privateCanaries[0], token: privateCanaries[5],
      }],
    }),
    entry('subagent', 'worker-a', {
      title: 'worker running', prompt: privateCanaries[3], output: privateCanaries[3],
    }),
    entry('reasoningSummary', 'reasoning-a', {
      publicNarrative: 'Visible summary', body: privateCanaries[4],
    }),
  ]);

  assert.deepEqual(segments[0].items, [{
    id: 'file-a', title: 'Edited file', state: 'succeeded',
    fileLabel: 'src/server.js', changeKind: 'modified', operationKind: 'file',
  }]);
  assert.deepEqual(segments[1].items[0].attachments, [{
    name: 'result.png', mime: 'image/png', url: '/codex/attachment/0123456789abcdef0123456789abcdef',
  }]);
  assert.equal(segments[0].expandable, true);
  assert.equal(segments[1].expandable, true);
  const serialized = JSON.stringify(segments);
  for (const canary of privateCanaries) assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes('body'), false);
  assert.equal(serialized.includes('prompt'), false);
  assert.equal(serialized.includes('output'), false);
});

test('subagent items publish only valid safe lifecycle metadata and drop invalid siblings', () => {
  const privateCanaries = [
    'PRIVATE_SUBAGENT_TITLE', 'PRIVATE_SUBAGENT_CONTENT', 'PRIVATE_SUBAGENT_PROMPT',
    'PRIVATE_SUBAGENT_BODY', 'PRIVATE_SUBAGENT_ID',
  ];
  const validStates = ['running', 'completed', 'failed', 'interrupted'];
  const segments = segmentVisibleTimeline([
    ...validStates.map((state, index) => entry('subagent', `subagent-${index}`, {
      title: privateCanaries[0], durationMs: 25, operation: 'spawn',
      content: privateCanaries[1], prompt: privateCanaries[2], body: privateCanaries[3],
      subagent: {
        name: `worker-${index}`, state, id: privateCanaries[4], content: privateCanaries[1],
        prompt: privateCanaries[2], body: privateCanaries[3], status: 'cancelled',
      },
    })),
    entry('subagent', 'subagent-invalid', {
      title: privateCanaries[0],
      subagent: { name: 'invalid-worker', state: 'cancelled', id: privateCanaries[4] },
    }),
  ]);

  assert.deepEqual(segments[0].items, [
    ...validStates.map((state, index) => ({
      id: `subagent-${index}`,
      state: 'succeeded',
      subagent: { name: `worker-${index}`, state },
    })),
  ]);
  assert.equal(segments[0].count, validStates.length);
  const serialized = JSON.stringify(segments);
  for (const canary of privateCanaries) assert.equal(serialized.includes(canary), false);
  for (const forbidden of ['content', 'prompt', 'body', 'durationMs', 'operation']) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false);
  }
});

test('invalid subagent metadata never publishes an empty segment or item shell', () => {
  const privateCanaries = [
    'PRIVATE_INVALID_NAME', 'PRIVATE_INVALID_PROMPT', 'PRIVATE_INVALID_ID',
  ];
  const segments = segmentVisibleTimeline([
    entry('subagent', 'subagent-empty-name', {
      subagent: {
        name: '   ', state: 'running', id: privateCanaries[2], prompt: privateCanaries[1],
      },
    }),
    entry('subagent', 'subagent-cancelled', {
      title: privateCanaries[0],
      subagent: {
        name: privateCanaries[0], state: 'cancelled', id: privateCanaries[2],
        prompt: privateCanaries[1],
      },
    }),
    entry('subagent', 'subagent-missing-state', {
      subagent: { name: privateCanaries[0], id: privateCanaries[2], prompt: privateCanaries[1] },
    }),
  ]);

  assert.deepEqual(segments, []);
  const serialized = JSON.stringify(segments);
  for (const canary of privateCanaries) assert.equal(serialized.includes(canary), false);
});

test('segment ids and states are deterministic and input entries stay immutable', () => {
  const input = [
    entry('command', 'a', { state: 'succeeded', count: 2 }),
    entry('command', 'b', { state: 'cancelled' }),
  ];
  const before = JSON.stringify(input);
  const first = segmentVisibleTimeline(input);
  const second = segmentVisibleTimeline(input);

  assert.deepEqual(first, second);
  assert.equal(first[0].count, 3);
  assert.equal(first[0].state, 'cancelled');
  assert.equal(JSON.stringify(input), before);
});

test('image view and generation variants form distinct adjacent presentation groups', () => {
  const segments = segmentVisibleTimeline([
    entry('image', 'view-a', { variant: 'imageView', operation: 'view' }),
    entry('image', 'generate-a', { variant: 'imageGeneration', operation: 'generate' }),
  ]);

  assert.deepEqual(segments.map(segment => [segment.kind, segment.variant, segment.count]), [
    ['image', 'imageView', 1],
    ['image', 'imageGeneration', 1],
  ]);
  assert.deepEqual(segments.map(segment => segment.items[0].operation), ['view', 'generate']);
});

test('adjacent command operations share one command presentation group', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'run-a', { operation: 'run' }),
    entry('command', 'exec-b', { operation: 'exec' }),
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'command');
  assert.equal(segments[0].count, 2);
  assert.deepEqual(segments[0].items.map(item => item.operation), ['run', 'exec']);
  assert.deepEqual(segments[0].items.map(item => item.operationKind), ['command', 'command']);
});

test('adjacent file and command items form one mixed operation group while narrative closes it', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'command-a', { operation: 'run', displayDetail: 'npm test' }),
    entry('file', 'file-a', {
      operation: 'edit', operationKind: 'file', fileLabel: 'src/server.js',
      changeKind: 'modified', displayDetail: '+3 -1',
    }),
    entry('command', 'command-b', { operation: 'run', displayDetail: 'npm run check' }),
    entry('commentary', 'checkpoint', { publicNarrative: 'Checking result' }),
    entry('file', 'file-b', {
      operation: 'create', operationKind: 'file', fileLabel: 'test/new.test.js',
      changeKind: 'added', displayDetail: '+8 -0',
    }),
  ]);

  assert.deepEqual(segments.map(segment => [
    segment.kind, segment.count, segment.commandCount, segment.fileCount,
  ]), [
    ['operation', 3, 2, 1],
    ['commentary', 1, undefined, undefined],
    ['file', 1, undefined, undefined],
  ]);
  assert.deepEqual(segments[0].items.map(item => [item.id, item.operationKind]), [
    ['command-a', 'command'], ['file-a', 'file'], ['command-b', 'command'],
  ]);
  assert.equal(segments[0].items[1].displayDetail, '+3 -1');
});

test('stable multi command children preserve source ordinal and lifecycle updates replace in place', () => {
  const segments = segmentVisibleTimeline([
    entry('command', 'outer:detail:1', { state: 'running', displayDetail: 'Get-Date', sourceOrdinal: 1 }),
    entry('command', 'outer:detail:2', { state: 'running', displayDetail: 'Get-Date', sourceOrdinal: 2 }),
    entry('command', 'outer:detail:1', { state: 'succeeded', displayDetail: 'Get-Date', sourceOrdinal: 1 }),
  ]);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].count, 2);
  assert.deepEqual(segments[0].items.map(item => item.id), ['outer:detail:1', 'outer:detail:2']);
  assert.deepEqual(segments[0].items.map(item => item.sourceOrdinal), [1, 2]);
  assert.deepEqual(segments[0].items.map(item => item.state), ['succeeded', 'running']);
});
