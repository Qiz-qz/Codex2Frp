'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TurnDiffStore, parseTurnDiff } = require('../lib/events/turn-diff-store');

const THREAD = '11111111-2222-4333-8444-555555555555';
const TURN = 'turn-authoritative-diff';

const FIRST_DIFF = [
  'diff --git a/src/alpha.js b/src/alpha.js',
  'index 111..222 100644',
  '--- a/src/alpha.js',
  '+++ b/src/alpha.js',
  '@@ -1,2 +1,3 @@',
  '-old',
  '+new',
  '+extra',
  ' stable',
  'diff --git a/src/beta.js b/src/beta.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/beta.js',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n');

test('authoritative turn diff keeps exact unique files and per-file line totals', () => {
  const parsed = parseTurnDiff(FIRST_DIFF);
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    fileCount: 2,
    additions: 4,
    deletions: 1,
    files: [
      { id: 'file-1', fileLabel: 'src/alpha.js', changeKind: 'modified', operation: 'edit',
        additions: 2, deletions: 1, displayDetail: '+2 -1' },
      { id: 'file-2', fileLabel: 'src/beta.js', changeKind: 'added', operation: 'create',
        additions: 2, deletions: 0, displayDetail: '+2 -0' },
    ],
  });
});

test('binary-only diffs fall back to safe diff headers with zero line totals', () => {
  const parsed = parseTurnDiff([
    'diff --git a/assets/logo.png b/assets/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/assets/logo.png and b/assets/logo.png differ',
    '',
  ].join('\n'));
  assert.deepEqual(parsed, {
    schemaVersion: 1,
    fileCount: 1,
    additions: 0,
    deletions: 0,
    files: [{ id: 'file-1', fileLabel: 'assets/logo.png', changeKind: 'modified', operation: 'edit',
      additions: 0, deletions: 0, displayDetail: '+0 -0' }],
  });
});

test('real git binary headers retain unquoted spaces and C-quoted UTF-8 paths', () => {
  const spaced = parseTurnDiff([
    'diff --git a/assets/space name.png b/assets/space name.png',
    'index 1111111..2222222 100644',
    'Binary files a/assets/space name.png and b/assets/space name.png differ',
    '',
  ].join('\n'));
  assert.equal(spaced.files[0].fileLabel, 'assets/space name.png');
  assert.equal(spaced.files[0].displayDetail, '+0 -0');

  const chinese = parseTurnDiff([
    'diff --git "a/assets/\\344\\270\\255\\346\\226\\207.png" "b/assets/\\344\\270\\255\\346\\226\\207.png"',
    'index 1111111..2222222 100644',
    'Binary files "a/assets/\\344\\270\\255\\346\\226\\207.png" and "b/assets/\\344\\270\\255\\346\\226\\207.png" differ',
    '',
  ].join('\n'));
  assert.equal(chinese.files[0].fileLabel, 'assets/中文.png');
  assert.equal(chinese.files[0].displayDetail, '+0 -0');
});

test('unquoted header boundaries use text or rename evidence and reject unresolved ambiguity', () => {
  const text = parseTurnDiff([
    'diff --git a/assets/space b/part.txt b/assets/space b/part.txt',
    '--- a/assets/space b/part.txt',
    '+++ b/assets/space b/part.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));
  assert.equal(text.files[0].fileLabel, 'assets/space b/part.txt');

  const renamed = parseTurnDiff([
    'diff --git a/assets/old b/name.png b/assets/new b/name.png',
    'similarity index 100%',
    'rename from assets/old b/name.png',
    'rename to assets/new b/name.png',
    '',
  ].join('\n'));
  assert.equal(renamed.files[0].fileLabel, 'assets/new b/name.png');
  assert.equal(renamed.files[0].changeKind, 'renamed');

  assert.equal(parseTurnDiff([
    'diff --git a/assets/old b/name.png b/assets/new b/name.png',
    'Binary files differ',
    '',
  ].join('\n')), null, 'binary-only differing paths fail closed without rename counterevidence');
});

test('Git path decoding strictly rejects control bytes, malformed escapes, and invalid UTF-8', () => {
  for (const escaped of ['\\011', '\\t', '\\001', '\\400', '\\8', '\\377']) {
    assert.equal(parseTurnDiff([
      `diff --git "a/assets/bad${escaped}.png" "b/assets/bad${escaped}.png"`,
      'Binary files differ',
      '',
    ].join('\n')), null, `${escaped} must fail closed`);
  }
  assert.equal(parseTurnDiff([
    'diff --git a/assets/bad\tname.png b/assets/bad\tname.png',
    'Binary files differ',
    '',
  ].join('\n')), null, 'literal controls fail closed');
});

test('mixed text and quoted binary sections retain exact safe destination paths', () => {
  const parsed = parseTurnDiff([
    'diff --git a/src/main.js b/src/main.js',
    '--- a/src/main.js',
    '+++ b/src/main.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git "a/assets/space name.png" "b/assets/space name.png"',
    'index 1111111..2222222 100644',
    'Binary files "a/assets/space name.png" and "b/assets/space name.png" differ',
    '',
  ].join('\n'));
  assert.deepEqual(parsed.files, [
    { id: 'file-1', fileLabel: 'src/main.js', changeKind: 'modified', operation: 'edit',
      additions: 1, deletions: 1, displayDetail: '+1 -1' },
    { id: 'file-2', fileLabel: 'assets/space name.png', changeKind: 'modified', operation: 'edit',
      additions: 0, deletions: 0, displayDetail: '+0 -0' },
  ]);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
});

test('binary rename headers require complete matching safe rename metadata', () => {
  const renamed = parseTurnDiff([
    'diff --git "a/assets/old name.png" "b/assets/new name.png"',
    'similarity index 100%',
    'rename from assets/old name.png',
    'rename to assets/new name.png',
    '',
  ].join('\n'));
  assert.deepEqual(renamed.files, [
    { id: 'file-1', fileLabel: 'assets/new name.png', changeKind: 'renamed', operation: 'rename',
      additions: 0, deletions: 0, displayDetail: '+0 -0' },
  ]);
  assert.equal(parseTurnDiff([
    'diff --git "a/assets/old name.png" "b/assets/new name.png"',
    'rename from assets/old name.png',
    '',
  ].join('\n')), null, 'partial rename metadata fails closed');
  assert.equal(parseTurnDiff([
    'diff --git "a/assets/old name.png" "b/assets/new name.png"',
    'rename from assets/not-old.png',
    'rename to assets/new name.png',
    '',
  ].join('\n')), null, 'mismatched rename metadata fails closed');
  assert.equal(parseTurnDiff('diff --git "a/assets/broken.png b/assets/broken.png\n'), null,
    'malformed quoted headers fail closed');
  assert.equal(parseTurnDiff([
    'diff --git assets/plain.png assets/plain.png',
    'Binary files assets/plain.png and assets/plain.png differ',
    '',
  ].join('\n')), null, 'headers without the canonical a/ and b/ sides fail closed');
  assert.equal(parseTurnDiff([
    'diff --git a/assets/old.png b/assets/new.png',
    'new file mode 100644',
    'rename from assets/old.png',
    'rename to assets/new.png',
    '',
  ].join('\n')), null, 'contradictory create and rename metadata fails closed');
});

test('safe turn diff snapshots replace atomically and survive a backend restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-turn-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'turn-diffs.json');
  const store = new TurnDiffStore({ file });
  store.save(THREAD, TURN, parseTurnDiff(FIRST_DIFF));
  const replacement = parseTurnDiff([
    'diff --git a/src/alpha.js b/src/alpha.js',
    'deleted file mode 100644',
    '--- a/src/alpha.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-old',
    '-two',
    '',
  ].join('\n'));
  store.save(THREAD, TURN, replacement);

  const restarted = new TurnDiffStore({ file });
  assert.deepEqual(restarted.get(THREAD, TURN), replacement);
  const entries = restarted.entriesForThread(THREAD);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.payload.type, 'turnDiff');
  assert.deepEqual(entries[0].item.payload.turnDiff, replacement);
  assert.equal(JSON.stringify(entries).includes('beta.js'), false, 'replacement never revives vanished files');
});

test('invalid or privacy-unsafe diff metadata fails closed', t => {
  assert.equal(parseTurnDiff('not a git diff'), null);
  assert.equal(parseTurnDiff(`diff --git a/../secret.txt b/../secret.txt\n--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1 +1 @@\n-secret\n+safe\n`), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-turn-diff-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'turn-diffs.json');
  fs.writeFileSync(file, '{broken', 'utf8');
  const store = new TurnDiffStore({ file });
  assert.equal(store.get(THREAD, TURN), null);
  assert.deepEqual(store.entriesForThread(THREAD), []);
});

test('an authoritative empty diff clears the previous snapshot without guessing', t => {
  const empty = parseTurnDiff('');
  assert.deepEqual(empty, { schemaVersion: 1, fileCount: 0, additions: 0, deletions: 0, files: [] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-turn-diff-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TurnDiffStore({ file: path.join(root, 'turn-diffs.json') });
  store.save(THREAD, TURN, parseTurnDiff(FIRST_DIFF));
  store.save(THREAD, TURN, empty);
  assert.deepEqual(store.get(THREAD, TURN), empty);
});

test('a binary-only replacement evicts old text files and an empty replacement stays cleared after restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-turn-diff-binary-replace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'turn-diffs.json');
  const store = new TurnDiffStore({ file });
  store.save(THREAD, TURN, parseTurnDiff(FIRST_DIFF));
  const binary = parseTurnDiff([
    'diff --git "a/assets/new logo.png" "b/assets/new logo.png"',
    'new file mode 100644',
    'index 0000000..2222222',
    'Binary files /dev/null and "b/assets/new logo.png" differ',
    '',
  ].join('\n'));
  store.save(THREAD, TURN, binary);
  assert.deepEqual(new TurnDiffStore({ file }).get(THREAD, TURN), binary);
  assert.equal(fs.readFileSync(file, 'utf8').includes('alpha.js'), false);

  store.save(THREAD, TURN, parseTurnDiff(''));
  assert.deepEqual(new TurnDiffStore({ file }).get(THREAD, TURN),
    { schemaVersion: 1, fileCount: 0, additions: 0, deletions: 0, files: [] });
  assert.equal(new TurnDiffStore({ file }).entriesForThread(THREAD)[0].item.payload.turnDiff.fileCount, 0);
});

test('store configuration requires an explicit persistence file', () => {
  assert.throws(() => new TurnDiffStore(), /requires file/);
});
