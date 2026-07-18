'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public 1.4.15 release sources stay version-aligned and documented', () => {
  const pkg = JSON.parse(read('package.json'));
  const launcher = read('windows/launcher/Codex2FrpLauncher.cs');
  const manifest = read('windows/installer/Codex2FrpSetup.manifest');
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');
  assert.equal(pkg.version, '1.4.15');
  assert.match(launcher, /internal const string AppVersion = "1\.4\.15";/);
  assert.match(manifest, /assemblyIdentity version="1\.4\.15\.0"/);
  assert.match(readme, /Current version: `v1\.4\.15`/);
  assert.match(changelog, /## \[1\.4\.15\]/);
  for (const topic of ['ChatGPT', 'timeline', 'process', 'privacy', 'paging']) {
    assert.match(changelog, new RegExp(topic, 'i'));
  }
});
