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

test('legacy mobile send is bridged to the real desktop internal RPC instead of an independent app-server', () => {
  assert.match(source, /require\('\.\/lib\/control\/desktop-internal-rpc-adapter'\)/);
  assert.match(source, /new DesktopInternalRpcAdapter\(/);
  assert.match(source, /new DesktopControlRuntime\(/);
  const body = functionBody('handleSend');
  assert.match(body, /desktopInternalRpcAdapter\.send\(/);
  assert.match(body, /delivery:\s*'rpc'/);
  assert.match(body, /turnId:\s*direct\.turnId/);
  assert.match(body, /threadId:\s*direct\.threadId/);
});

test('native Codex send does not decode images to temp files or touch the desktop composer', () => {
  const body = functionBody('handleSend');
  const nativeBranchStart = body.indexOf("if (target === 'codex')");
  const legacyBranchStart = body.indexOf('attachments = decodeAttachments', nativeBranchStart);
  assert.notEqual(nativeBranchStart, -1, 'native Codex branch exists');
  assert.notEqual(legacyBranchStart, -1, 'frontmost fallback still decodes attachments');
  const nativeBranch = body.slice(nativeBranchStart, legacyBranchStart);
  assert.doesNotMatch(nativeBranch, /pasteAndEnter|focusTarget|sendTextViaCodexCdp|decodeAttachments/);
});

test('v3 control runtime labels desktop and independent transports separately', () => {
  assert.match(source, /independentRuntime:\s*v3BridgeBase\.runtime/);
  assert.match(source, /desktopAdapter:\s*desktopInternalRpcAdapter/);
  assert.match(source, /runtime:\s*desktopControlRuntime/);
  assert.doesNotMatch(source, /new NativeControlAdapter/);
});

test('desktop renderer RPC evaluation awaits the response promise and returns it by value', () => {
  const body = functionBody('cdpEvaluate');
  assert.match(body, /returnByValue:\s*true/);
  assert.match(body, /awaitPromise:\s*true/);
});
