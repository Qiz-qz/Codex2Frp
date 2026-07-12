'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'installed-readonly-smoke.ps1'),
  'utf8',
);

test('installed smoke uses only authenticated read routes and redacts task identity', () => {
  assert.match(source, /Authorization\s*=\s*"Bearer \$token"/);
  assert.doesNotMatch(source, /-Method\s+(?:Post|Put|Patch|Delete)\b/i);
  assert.doesNotMatch(source, /\/input|\/actions|\/interrupt|\/steer|\/flush|\/retry|\/reconcile/i);
  assert.doesNotMatch(source, /^\s{2}threadId\s*=/im, 'the summary must not emit the task id');
  assert.match(source, /threadAvailable\s*=/);
  assert.match(source, /response echoed the access token/);
});
