'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const excluded = new Set([
  'server-sakura-config.test.js',
]);

// Tests under test/integration are always explicit because they may start
// bridge processes or use isolated runtime fixtures.
const files = fs.readdirSync(testDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => entry.name)
  .filter(name => !excluded.has(name))
  .sort()
  .map(name => path.join('test', name));

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX2FRP_TEST_MODE: 'safe',
  },
});

if (result.error) {
  throw result.error;
}
process.exitCode = typeof result.status === 'number' ? result.status : 1;
