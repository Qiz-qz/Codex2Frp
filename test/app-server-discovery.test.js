'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  detectCodexCliVersion,
  discoverCodexExecutable,
  normalizeCodexCliVersion,
  profileFileForCliVersion,
} = require('../lib/app-server/discovery');

test('CLI version detection uses a hidden no-shell process and parses stdout', () => {
  const calls = [];
  const version = detectCodexCliVersion('C:\\Codex\\codex.exe', {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'codex-cli 0.144.0-alpha.4\n', stderr: '' };
    },
  });
  assert.equal(version, '0.144.0-alpha.4');
  assert.equal(calls[0].command, 'C:\\Codex\\codex.exe');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('CLI version detection fails closed on process errors or unknown output', () => {
  assert.equal(detectCodexCliVersion('', {}), '');
  assert.equal(detectCodexCliVersion('codex.exe', {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'failed' }),
  }), '');
  assert.equal(detectCodexCliVersion('codex.exe', {
    spawnSync: () => { throw new Error('not found'); },
  }), '');
});

test('explicit executable wins and invalid candidates are ignored', () => {
  const files = new Map([
    ['C:\\explicit\\codex.exe', { isFile: true, mtimeMs: 10 }],
    ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\old\\codex.exe', { isFile: true, mtimeMs: 20 }],
    ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe', { isFile: true, mtimeMs: 30 }],
  ]);
  const result = discoverCodexExecutable({
    explicitPath: 'C:\\explicit\\codex.exe',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    listCandidates: () => [...files.keys()].slice(1),
    stat: file => files.get(file) || null,
  });
  assert.equal(result, 'C:\\explicit\\codex.exe');
});

test('bundled discovery chooses the newest valid Codex binary deterministically', () => {
  const candidates = [
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\a\\codex.exe',
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\b\\codex.exe',
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\not-a-file\\codex.exe',
  ];
  const result = discoverCodexExecutable({
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    listCandidates: () => candidates,
    stat: file => file.includes('not-a-file')
      ? { isFile: false, mtimeMs: 999 }
      : { isFile: true, mtimeMs: file.includes('\\b\\') ? 200 : 100 },
  });
  assert.equal(result, candidates[1]);
});

test('version parser accepts current Codex output and rejects unrelated text', () => {
  assert.equal(normalizeCodexCliVersion('codex-cli 0.144.0-alpha.4\n'), '0.144.0-alpha.4');
  assert.equal(normalizeCodexCliVersion('codex 0.144.0-alpha.4'), '0.144.0-alpha.4');
  assert.equal(normalizeCodexCliVersion('hello 1.2.3'), '');
});

test('profile selection is exact and fails closed for unknown CLI versions', () => {
  const known = profileFileForCliVersion('0.144.0-alpha.4');
  assert.equal(path.basename(known), 'v0144-profile.json');
  assert.equal(profileFileForCliVersion('0.145.0'), '');
  assert.equal(profileFileForCliVersion(''), '');
});
