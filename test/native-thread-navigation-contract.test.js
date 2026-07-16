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

test('phone task selection navigates with the native codex deep link and leaves CDP to observation', () => {
  assert.match(source, /async function navigateCodexThreadViaDeepLink/);
  const body = functionBody('navigateCodexThreadViaDeepLink');
  assert.match(body, /codexThreadDeepLink\(threadId\)/);
  assert.match(body, /openWindowsUri\(deepLink\)/);
  assert.match(body, /method:\s*'codex-deep-link'/);
  assert.match(body, /confirmedThreadId:\s*threadId/);
  assert.doesNotMatch(body, /cdpClickRect|Input\.dispatch|sendWindowsKeys/);

  const adapterWiring = source.slice(
    source.indexOf('const desktopSelectionAdapter'),
    source.indexOf('const explicitProcessControlTransaction'),
  );
  assert.match(adapterWiring, /navigateCodexThreadViaDeepLink\(threadId\)/);
  assert.doesNotMatch(adapterWiring, /activateCodexThreadViaExistingCdp\(threadId\)/);
});
