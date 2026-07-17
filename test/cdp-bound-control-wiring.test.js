'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server binds UI transactions and thread navigation to the verified CDP process', () => {
  assert.match(source, /createBoundCodexWindowDiscovery/);
  assert.match(source, /createCdpBoundThreadNavigator/);
  assert.match(source, /let codexCdpProcessId\s*=\s*0/);
  assert.match(source, /discoverWindow:\s*discoverControlledCodexWindow/);
  assert.match(source, /codexCdpProcessId\s*=\s*controlledProcess\.processId/);
  assert.match(source, /reconcileCdpProcessBinding/);
  assert.match(source, /navigate:\s*async \(\{ threadId \}\) => cdpBoundThreadNavigator\(threadId\)/);
  assert.doesNotMatch(source, /navigate:\s*async \(\{ threadId \}\) => \{\s*return navigateCodexThreadViaDeepLink/);
});
