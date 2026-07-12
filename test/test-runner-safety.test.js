'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('default test command uses the side-effect-free test runner', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js');
  assert.equal(packageJson.scripts['test:integration'], 'node --test test/server-sakura-config.test.js test/integration/*.test.js');
});

test('safe runner excludes server-spawning and integration tests', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'run-tests.js'), 'utf8');
  assert.match(source, /server-sakura-config\.test\.js/);
  assert.match(source, /test[\\/]integration/);
  assert.match(source, /--test/);
});
