'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function functionBody(name) {
  const marker = `async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf('\nasync function ', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test('phone task selection stays inside the verified CDP process instead of dispatching a system deep link', () => {
  const adapterWiring = source.slice(
    source.indexOf('const desktopSelectionAdapter'),
    source.indexOf('const explicitProcessControlTransaction'),
  );
  assert.match(adapterWiring, /navigate:\s*async \(\{ threadId \}\) => cdpBoundThreadNavigator\(threadId\)/);
  assert.doesNotMatch(adapterWiring, /navigateCodexThreadViaDeepLink\(threadId\)/);

  const activation = functionBody('activateCodexThreadViaExistingCdp');
  assert.match(activation, /findCodexCdpTarget\(\{ autoOpen: false \}\)/);
  assert.match(activation, /buildShowThreadExpression\(threadId\)/);
  assert.match(activation, /normalizeShowThreadResult/);
  assert.doesNotMatch(activation, /data-app-action-sidebar-thread-id|cdpClickRect/);
  assert.match(activation, /if \(!navigation\.ok\) return navigation/);
});
