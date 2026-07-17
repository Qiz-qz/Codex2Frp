'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { segmentVisibleTimeline } = require('../lib/events/visible-segmenter');
const { classifyMenuItem } = require('../lib/control/composer-menu-classifier');

const fixture = name => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'desktop', name), 'utf8',
));

test('0.144.2 session projection preserves adjacency without claiming desktop visibility', () => {
  const capture = fixture('0.144.2-visible-timeline.json');
  const segments = segmentVisibleTimeline(capture.sessionProjection.entries);
  assert.deepEqual(segments.map(segment => [segment.kind, segment.count]),
    capture.sessionProjection.expectedSegments);
  assert.deepEqual(segments.filter(segment => segment.kind === 'command').map(segment => segment.count), [3]);
  const mixed = segments.find(segment => segment.kind === 'operation');
  assert.deepEqual({ commandCount: mixed.commandCount, fileCount: mixed.fileCount }, { commandCount: 2, fileCount: 2 });
  assert.deepEqual(mixed.items.map(item => item.operationKind), ['command', 'file']);
  assert.equal(segments.at(-1).items[0].state, 'succeeded');
  assert.equal(capture.sessionProjection.entries.every(entry => entry.desktopVisibility === 'not-asserted'), true);
  assert.doesNotMatch(JSON.stringify(capture.sessionProjection.entries),
    /(?:rawOutput|arguments|privatePath|token|authorization)/i);
});

test('0.144.2 direct visual evidence pins real command and image captions without invented details', () => {
  const capture = fixture('0.144.2-visible-timeline.json');
  assert.deepEqual(capture.visualPresentation.sources.map(source => source.sha256), [
    'a08f84a2ffea7fc08e3ca1a55d856375bb5a1796bfc66675aace2c27565222cc',
    '4836a08bbec1e667c9a812a98b081e5c7013bcc67e9c88f2634aa3465041c4e1',
  ]);
  assert.deepEqual(capture.visualPresentation.groups.map(group => [group.kind, group.count, group.title]), [
    ['command', 3, '运行了 3 个命令'],
    ['image', 4, '已查看 4 张图像'],
    ['image', 1, '已查看 1 张图像'],
  ]);
  assert.equal(capture.visualPresentation.groups.every(group => group.expansionObserved === false), true);
  assert.equal(capture.visualPresentation.groups.some(group => group.kind === 'image'
    && group.variant === 'imageView'), true);
});

test('0.144.2 composer fixture keeps subagents, plugins, files, and unknown rows distinct', () => {
  const capture = fixture('0.144.2-composer-menu.json');
  assert.deepEqual(capture.rows.map(row => classifyMenuItem(row).kind),
    capture.rows.map(row => row.expectedKind));
  assert.equal(capture.rowsAreObservedMenuRows, false);
  assert.equal(capture.rows.find(row => row.expectedKind === 'subagent').evidence,
    'inferred-negative-contract');
  assert.equal(capture.collaboration.userFacingEntryObserved, false);
  assert.equal(capture.collaboration.phoneControlAllowed, false);
});

test('0.144.2 selection fixture consumes cross-run sentinel fingerprints and fails closed', () => {
  const capture = fixture('0.144.2-selection.json');
  assert.equal(capture.observation.exactDesktopUuidAvailable, false);
  assert.equal(capture.observation.mustGuessFromTitleBodyRecencyOrStatus, false);
  const evidence = capture.sentinelComparison;
  assert.ok(evidence.baselineSamples >= 2);
  assert.ok(evidence.endSamples >= 2);
  assert.equal(evidence.baselinePassed && evidence.endPassed, true);
  assert.deepEqual([
    evidence.baselineChanges, evidence.endChanges,
    evidence.baselineViolations, evidence.endViolations,
    evidence.baselineErrors, evidence.endErrors,
  ], [0, 0, 0, 0, 0, 0]);
  assert.equal(Object.values(evidence.fields).every(field => field.equal
    && field.baseline === field.end && /^[0-9a-f]{64}$/.test(field.baseline)), true);
  assert.equal(evidence.storesRawHandlesTitlesUuids, false);
});
