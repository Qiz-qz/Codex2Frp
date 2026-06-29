'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const bannedName = new RegExp(['codex', '[ _-]?', 'mini'].join(''), 'i');
const textExtensions = new Set([
  '',
  '.cs',
  '.html',
  '.js',
  '.json',
  '.md',
  '.ps1',
  '.txt',
  '.webmanifest',
  '.xml',
]);

function trackedFiles() {
  return childProcess.execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

test('tracked backend sources use Codex2Frp branding only', () => {
  const offenders = [];
  for (const relativePath of trackedFiles()) {
    if (bannedName.test(relativePath)) offenders.push(`${relativePath}:path`);
    if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const content = fs.readFileSync(absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (bannedName.test(line)) offenders.push(`${relativePath}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
