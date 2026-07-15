'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testRoot = __dirname;

function javascriptFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}

test('public backend tests contain no real protected task id or workstation paths', () => {
  const realProtectedId = ['019f', '4840-00df-7ee0-88cb-e3dbcb1871dc'].join('');
  const escapedSeparator = '\\'.repeat(2);
  const realHome = ['C:', escapedSeparator, 'Users', escapedSeparator, 'admin'].join('');
  const realWorkspace = ['E:', escapedSeparator, 'HarmonyOS', '_develop'].join('');
  const offenders = [];
  for (const file of javascriptFiles(testRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const secret of [realProtectedId, realHome, realWorkspace]) {
      if (source.includes(secret)) offenders.push(`${path.relative(testRoot, file)}:${secret}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('live integration takes its protected target only from the explicit singular environment variable', () => {
  const file = path.join(testRoot, 'integration', 'app-server-live-smoke.test.js');
  const source = fs.readFileSync(file, 'utf8');
  const realProtectedId = ['019f', '4840-00df-7ee0-88cb-e3dbcb1871dc'].join('');
  assert.match(source, /process\.env\.CODEX2FRP_PROTECTED_THREAD_ID/);
  assert.doesNotMatch(source, /const PROTECTED_CURRENT_THREAD_ID\s*=/);
  assert.equal(source.includes(realProtectedId), false);
});
