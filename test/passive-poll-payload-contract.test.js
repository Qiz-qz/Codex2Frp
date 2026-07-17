'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('selection-only polling does not enumerate the task directory', () => {
  assert.match(serverSource, /const selectionOnly = url\.searchParams\.get\('selectionOnly'\) === '1'/);
  assert.match(serverSource, /const threads = selectionOnly\s*\?\s*\[\]\s*:\s*listCodexThreads/);
  assert.match(serverSource, /desktopSelectionSuppressed: sync\.suppressed/);
  assert.match(serverSource, /selectedThreadId,/);
  assert.match(serverSource, /currentThreadId: selectedThreadId/);
});

test('compact status retains lifecycle and observed controls without process duplication', () => {
  const compactBranch = serverSource.slice(
    serverSource.indexOf("if (url.searchParams.get('compact') === '1')"),
    serverSource.indexOf('return json(res, 200, status);', serverSource.indexOf(
      "if (url.searchParams.get('compact') === '1')",
    )),
  );
  assert.ok(compactBranch.length > 0);
  for (const field of [
    'steps',
    'processText',
    'preview',
    'final',
    'error',
    'modelOptions',
    'reasoningOptions',
    'speedOptions',
    'attachments',
    'foregroundNotice',
  ]) {
    assert.match(compactBranch, new RegExp(`delete status\\.${field}`));
  }
  assert.doesNotMatch(compactBranch, /delete status\.(status|threadId|turnId|startedAt|updatedAt|context|currentModel|currentReasoning|currentSpeed|nextTurnSettings)/);
});
