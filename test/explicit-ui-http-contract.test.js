'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function functionBody(name) {
  const asyncMarker = `async function ${name}`;
  const plainMarker = `function ${name}`;
  const asyncStart = source.indexOf(asyncMarker);
  const plainStart = source.indexOf(plainMarker);
  const start = asyncStart >= 0 && (plainStart < 0 || asyncStart < plainStart) ? asyncStart : plainStart;
  assert.notEqual(start, -1, `${name} exists`);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} has a function body`);
  const brace = signatureEnd + 2;
  let depth = 0;
  for (let cursor = brace; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, cursor);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test('request bodies are cached so explicit UI authorization can inspect without consuming handlers', () => {
  const body = functionBody('readBody');
  assert.match(body, /REQUEST_BODY_CACHE/);
  assert.match(body, /req\[REQUEST_BODY_CACHE\]/);
});

test('only authenticated explicit mobile routes enter the focus transaction', () => {
  const body = functionBody('runExplicitUiHttpAction');
  const contextBody = functionBody('uiRouteMutationContext');
  assert.match(body, /isAuthorized\(req\)/);
  assert.match(body, /createExplicitUiIntent/);
  assert.match(body, /uiActionTransaction\.run/);
  assert.doesNotMatch(body, /readCurrentCodexThreadSelection/,
    'HTTP wrapper does not inspect the active desktop task before the transaction activates Codex');
  assert.match(functionBody('resolveExplicitUiObservedThread'), /readCurrentCodexThreadSelection/);
  assert.match(body, /BufferedHttpResponse/);
  assert.ok(body.indexOf('isAuthorized(req)') < body.indexOf('readBody(req)'), 'authorization precedes body parsing');
  assert.match(contextBody, /requireObservedTargetMatch:\s*!requestedThreadId/,
    'implicit-current actions reject a desktop task change while waiting for the UI lock');
});

test('ordinary explicit UI transaction activates before resolving and guarding the observed task', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'control', 'ui-action-transaction.js'), 'utf8');
  const body = source.slice(source.indexOf('class UiActionTransaction'), source.indexOf('class ExplicitProcessControlTransaction'));
  assert.ok(body.indexOf('session.activate()') >= 0);
  assert.ok(body.indexOf('readyGuardContext(context, this.resolveObservedThread') > body.indexOf('session.activate()'));
  assert.ok(body.indexOf('this.guard.assertAllowed(currentGuardContext)') > body.indexOf('readyGuardContext(context, this.resolveObservedThread'));
});

test('only the composer plus-menu GET is classified as a read-only UI transaction', () => {
  const contextBody = functionBody('uiRouteMutationContext');
  const transactionSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'control', 'ui-action-transaction.js'), 'utf8');
  const transactionBody = transactionSource.slice(
    transactionSource.indexOf('class UiActionTransaction'),
    transactionSource.indexOf('class ExplicitProcessControlTransaction'),
  );
  assert.match(contextBody, /pathname === '\/codex\/composer-plus-menu'[\s\S]*access\s*=\s*'readOnly'/);
  assert.match(contextBody, /\r?\n\s*access,\r?\n/);
  assert.match(transactionBody, /context\.access === 'readOnly'/);
  assert.match(transactionBody, /if \(!readOnly\)[\s\S]*readyGuardContext/);
  assert.doesNotMatch(contextBody, /composer-action[^}]+access\s*=\s*'readOnly'/s);
});

test('dispatch marks every legacy UI mutation as explicit and leaves reads/background v3 outside', () => {
  const body = functionBody('dispatchRequest');
  assert.match(body, /const pathname = new URL\(req\.url/);
  for (const route of [
    '/send',
    '/codex/select',
    '/codex/new-thread',
    '/codex/thread-action',
    '/codex/composer-plus-menu',
    '/codex/composer-action',
    '/codex/model-switch',
    '/codex/reasoning-mode',
    '/codex/speed-mode',
    '/codex/stop',
  ]) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(body, new RegExp(`pathname === '${escaped}'[^\\n]+handleExplicitUiRequest`), `${route} uses an exact explicit UI route`);
  }
  assert.doesNotMatch(body.match(/if \(req\.url\.startsWith\('\/codex\/v3\/'\)[\s\S]*?\n  }/)?.[0] || '', /runExplicitUiHttpAction/);
});

test('legacy send cannot fall through to an unscoped frontmost-window mutation', () => {
  const contextBody = functionBody('uiRouteMutationContext');
  const sendBody = functionBody('handleSend');
  assert.match(contextBody, /pathname === '\/send'[\s\S]*UNSUPPORTED_SEND_TARGET/);
  assert.doesNotMatch(contextBody, /payload\.target && payload\.target !== 'codex'\) return null/);
  assert.match(sendBody, /payload\.target === 'codex'/);
});

test('control-port probing is passive and only an explicit POST may auto-open Codex', () => {
  const resolverBody = functionBody('resolveControlPortState');
  const dispatchBody = functionBody('dispatchRequest');
  assert.match(resolverBody, /autoOpen:\s*payload\.autoOpen === true/);
  assert.match(resolverBody, /options\.refreshModeOptions === true[\s\S]*readLiveCodexModeOptionsBounded\(\{ force: true \}\)[\s\S]*cachedLiveModeOptions\(\)/);
  assert.doesNotMatch(resolverBody, /targetUrl|target\s*:\s*result\.target/,
    'control-port responses cannot expose a CDP target path, query, fragment, or task UUID');
  assert.match(dispatchBody, /req\.method === 'GET'[^\n]+\/codex\/control-port[^\n]+handleControlPort/);
  assert.match(dispatchBody, /req\.method === 'POST'[^\n]+\/codex\/control-port[^\n]+handleExplicitProcessControlRequest/);
  assert.match(source, /else if \(pathname === '\/codex\/control-port'\) \{\s*action = 'control\.enable'/);
});

test('control-port POST uses explicit process control with a safe first-enable sentinel and rebind result', () => {
  const body = functionBody('runExplicitProcessControlHttpAction');
  const observedBody = functionBody('resolveExplicitProcessObservedThread');
  assert.match(source, /new ExplicitProcessControlTransaction\(/);
  assert.match(observedBody, /threadProtectionRegistry\.summary\(\)\.protectedCount/);
  assert.match(observedBody, /PROTECTED_THREAD_CONTROL_ENABLE_BLOCKED/,
    'first enable fails safely and explains why when a protected desktop task cannot be verified');
  assert.match(body, /requestedThreadId \|\| 'desktop-control'/);
  assert.match(body, /explicitProcessControlTransaction\.run/);
  assert.match(body, /attachProcessControlReplacement|captureProcessControlReplacement/);
  assert.match(body, /processControl:\s*outcome\.processControl/);
  assert.doesNotMatch(body, /uiActionTransaction\.run|captureWindowSession/);
});

test('control-port process launch carries the transaction abort capability through every launcher stage', () => {
  const resolverBody = functionBody('resolveControlPortState');
  const readyBody = functionBody('ensureCodexCdpReady');
  const launcherBody = functionBody('runCodexCdpLauncher');
  assert.match(resolverBody, /ensureCodexCdpReady\([\s\S]*signal:\s*options\.signal/);
  assert.match(readyBody, /runCodexCdpLauncher\(options\)/);
  assert.match(launcherBody, /assertExplicitUiActionNotAborted\(options\.signal\)/);
  assert.match(launcherBody, /signal\.addEventListener\('abort'/);
  assert.match(launcherBody, /child\.kill\('SIGTERM'\)/);
});

test('mode switch fallbacks re-check the side-effect fence before config or override writes', () => {
  for (const name of ['switchCodexGuiModel', 'switchCodexReasoningMode', 'switchCodexSpeedMode']) {
    const body = functionBody(name);
    assert.match(body, /catch \(error\)[\s\S]*assertExplicitUiActionNotAborted\(\)[\s\S]*trySwitchCodex/,
      `${name} checks abort after live fallback`);
    assert.match(body, /assertExplicitUiActionNotAborted\(\)[\s\S]*writeControlOverride/,
      `${name} checks abort before control override`);
  }
  for (const name of ['trySwitchCodexModelViaConfig', 'trySwitchCodexReasoningViaConfig', 'trySwitchCodexSpeedViaConfig']) {
    assert.match(functionBody(name), /assertExplicitUiActionNotAborted\(\)[\s\S]*writeCodexConfigStringValue/,
      `${name} checks abort before config write`);
  }
});

test('PowerShell UI helpers terminate their child process when the transaction is aborted', () => {
  const body = functionBody('runProcess');
  assert.match(body, /explicitUiActionStorage\.getStore\(\)\?\.signal/);
  assert.match(body, /signal\.addEventListener\('abort'/);
  assert.match(body, /child\.kill\('SIGTERM'\)/);
});

test('legacy mutation responses do not expose session filenames or protected-task previews in error details', () => {
  const sendBody = functionBody('handleSend');
  const idleGuardBody = functionBody('assertCodexComposerActionThreadIdle');
  assert.doesNotMatch(sendBody, /watchFile|sessionFile:\s*path\.basename/);
  assert.doesNotMatch(idleGuardBody, /threadId,|sessionFile|preview/);
});

test('buffered response is flushed only after the focus transaction has restored state', () => {
  const body = functionBody('runExplicitUiHttpAction');
  const transactionIndex = body.indexOf('await uiActionTransaction.run');
  const flushIndex = body.indexOf('.flush(res)');
  assert.ok(transactionIndex >= 0 && flushIndex > transactionIndex, 'response flush follows transaction completion');
  assert.match(body, /async \(\{ window, signal, fence \}\)/);
  assert.match(body, /\{ windowHandle: window\.handle, signal, fence \}/);
  assert.match(body, /handler\(req, buffered, \{ signal, fence \}\)/);
});

test('legacy helpers can activate only the one window captured by the explicit transaction', () => {
  const runBody = functionBody('runExplicitUiHttpAction');
  const restoreStart = source.indexOf('async function restoreCodexDesktopWindow');
  const restoreEnd = source.indexOf('async function openWindowsUri', restoreStart);
  const restoreBody = source.slice(restoreStart, restoreEnd);
  assert.match(runBody, /explicitUiActionStorage\.run\(\s*\{ windowHandle: window\.handle, signal, fence \}/);
  assert.match(restoreBody, /explicitUiActionStorage\.getStore\(\)/);
  assert.match(restoreBody, /uiActionTransaction\.adapter\.activateWindow\(session\.windowHandle\)/);
  assert.doesNotMatch(restoreBody, /Get-Process|ChatGPT,Codex|SetForegroundWindow/,
    'unscoped legacy enumeration cannot activate every Codex window');
});
