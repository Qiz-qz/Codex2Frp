'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProtectedThreadGuard } = require('../lib/control/protected-thread-guard');
const {
  UiActionTransaction,
  createExplicitUiIntent,
} = require('../lib/control/ui-action-transaction');
const {
  Win32FocusAdapter,
  createPowerShellWin32Runner,
} = require('../lib/windows/win32-focus-adapter');

const TEST_THREAD = '11111111-2222-4333-8444-555555555555';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const MINIMIZED_PLACEMENT = Object.freeze({
  flags: 2,
  showCmd: 2,
  showState: 'minimized',
  visible: true,
  minimized: true,
  maximized: false,
  minPosition: { x: -32000, y: -32000 },
  maxPosition: { x: 0, y: 0 },
  normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 },
});

test('adapter captures foreground HWND and complete WINDOWPLACEMENT visibility state', () => {
  const calls = [];
  const adapter = new Win32FocusAdapter({
    runner(operation, payload) {
      calls.push({ operation, payload: clone(payload) });
      if (operation === 'getForegroundWindow') return { handle: '7001' };
      if (operation === 'getFocusedWindow') return { handle: '7002' };
      if (operation === 'getWindowPlacement') return { placement: clone(MINIMIZED_PLACEMENT) };
      throw new Error(`unexpected ${operation}`);
    },
  });

  assert.equal(adapter.getForegroundWindow(), '7001');
  assert.equal(adapter.getFocusedWindow(), '7002');
  assert.deepEqual(adapter.getWindowPlacement('9001'), MINIMIZED_PLACEMENT);
  assert.deepEqual(calls, [
    { operation: 'getForegroundWindow', payload: {} },
    { operation: 'getFocusedWindow', payload: {} },
    { operation: 'getWindowPlacement', payload: { handle: '9001' } },
  ]);
});

test('adapter restores the full captured placement and exposes activation primitives', () => {
  const calls = [];
  const adapter = new Win32FocusAdapter({
    runner(operation, payload) {
      calls.push({ operation, payload: clone(payload) });
      return { ok: true };
    },
  });

  assert.equal(adapter.setWindowPlacement('9001', MINIMIZED_PLACEMENT), true);
  assert.equal(adapter.activateWindow('9001'), true);
  assert.equal(adapter.setForegroundWindow('7001'), true);
  assert.equal(adapter.setFocusedWindow('7002'), true);
  assert.equal(adapter.isWindow('7001'), true);
  assert.deepEqual(calls, [
    {
      operation: 'setWindowPlacement',
      payload: { handle: '9001', placement: clone(MINIMIZED_PLACEMENT) },
    },
    { operation: 'activateWindow', payload: { handle: '9001' } },
    { operation: 'setForegroundWindow', payload: { handle: '7001' } },
    { operation: 'setFocusedWindow', payload: { handle: '7002' } },
    { operation: 'isWindow', payload: { handle: '7001' } },
  ]);
});

test('adapter normalizes enumerated Win32 windows for strict Codex discovery', () => {
  const adapter = new Win32FocusAdapter({
    runner(operation) {
      assert.equal(operation, 'listTopLevelWindows');
      return {
        windows: [{
          handle: 9001,
          ownerHandle: 0,
          processId: 321,
          processName: 'ChatGPT.exe',
          title: 'Codex',
          visible: true,
        }],
      };
    },
  });

  assert.deepEqual(adapter.listTopLevelWindows(), [{
    handle: '9001',
    ownerHandle: null,
    processId: 321,
    processName: 'ChatGPT.exe',
    title: 'Codex',
    visible: true,
  }]);
});

test('PowerShell runner streams the native bridge over stdin to avoid Windows command-line limits', () => {
  let invocation;
  const runner = createPowerShellWin32Runner({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    execFileSync(file, args, options) {
      invocation = { file, args: [...args], options: { ...options } };
      return '{"handle":"7001"}\r\n';
    },
  });

  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.equal(invocation.file.endsWith('powershell.exe'), true);
  assert.deepEqual(invocation.args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '$input | Out-String | Invoke-Expression',
  ]);
  assert.equal(invocation.options.windowsHide, false);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.encoding, 'utf8');
  const script = invocation.options.input;
  assert.equal(typeof script, 'string');
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length > 32_767,
    'the former encoded-command argument exceeds the Windows command-line limit');
  for (const api of [
    'EnumWindows',
    'GetForegroundWindow',
    'GetWindowPlacement',
    'SetWindowPlacement',
    'IsWindowVisible',
    'IsIconic',
    'ShowWindowAsync',
    'SetForegroundWindow',
    'GetCurrentThreadId',
    'GetWindowThreadProcessId',
    'AttachThreadInput',
    'BringWindowToTop',
    'SetActiveWindow',
  ]) {
    assert.match(script, new RegExp(api));
  }
  assert.match(script, /finally\s*\{[\s\S]*AttachThreadInput\([^;]+false\)/,
    'temporary input attachment is always detached');
  assert.match(script, /GetForegroundWindow\(\)\s*==\s*handle/,
    'activation reports success only when the target is actually foreground');
  assert.doesNotMatch(script, /SendKeys|keybd_event|SetWindowPos/,
    'activation uses neither keyboard simulation nor permanent topmost flags');
});

test('PowerShell runner fails closed off Windows without invoking a process', () => {
  let calls = 0;
  const runner = createPowerShellWin32Runner({
    platform: 'linux',
    execFileSync() {
      calls += 1;
    },
  });

  assert.throws(() => runner('getForegroundWindow', {}), error => {
    assert.equal(error.code, 'WIN32_FOCUS_UNAVAILABLE');
    return true;
  });
  assert.equal(calls, 0);
});

function createStatefulNativeRunner() {
  const state = {
    foreground: '7001',
    focused: '7002',
    target: '9001',
    placement: clone(MINIMIZED_PLACEMENT),
    calls: [],
  };
  const runner = (operation, payload = {}) => {
    state.calls.push({ operation, payload: clone(payload) });
    switch (operation) {
      case 'listTopLevelWindows':
        return { windows: [{
          handle: state.target,
          ownerHandle: null,
          processId: 321,
          processName: 'ChatGPT.exe',
          title: 'Codex',
          visible: true,
        }] };
      case 'getForegroundWindow':
        return { handle: state.foreground };
      case 'getFocusedWindow':
        return { handle: state.focused };
      case 'getWindowPlacement':
        return { placement: clone(state.placement) };
      case 'activateWindow':
        state.foreground = String(payload.handle);
        state.focused = '9002';
        state.placement = {
          ...state.placement,
          showCmd: 1,
          showState: 'normal',
          minimized: false,
        };
        return { ok: true };
      case 'setWindowPlacement':
        state.placement = clone(payload.placement);
        return { ok: true };
      case 'setForegroundWindow':
        state.foreground = String(payload.handle);
        return { ok: true };
      case 'setFocusedWindow':
        state.focused = String(payload.handle);
        return { ok: true };
      case 'isWindow':
        return { ok: true };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  };
  return { runner, state };
}

test('real adapter contract composes with UI transaction and restores captured visible/minimized placement', async () => {
  const native = createStatefulNativeRunner();
  const adapter = new Win32FocusAdapter({ runner: native.runner });
  const transaction = new UiActionTransaction({
    adapter,
    guard: createProtectedThreadGuard(),
    timeoutMs: 100,
  });
  const originalPlacement = clone(native.state.placement);
  const intent = createExplicitUiIntent({
    id: 'win32-adapter-success',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  });

  await transaction.run({
    action: 'composer.plus',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
    intent,
  }, async () => {
    assert.equal(native.state.foreground, '9001');
    native.state.placement.visible = false;
  });

  assert.equal(native.state.foreground, '7001');
  assert.equal(native.state.focused, '7002');
  assert.deepEqual(native.state.placement, originalPlacement);
  const restoreCall = native.state.calls.find(call => call.operation === 'setWindowPlacement');
  assert.deepEqual(restoreCall.payload.placement, originalPlacement);
});

test('real adapter contract does not steal focus back after a user selects another window', async () => {
  const native = createStatefulNativeRunner();
  const adapter = new Win32FocusAdapter({ runner: native.runner });
  const transaction = new UiActionTransaction({
    adapter,
    guard: createProtectedThreadGuard(),
    timeoutMs: 100,
  });
  const intent = createExplicitUiIntent({
    id: 'win32-adapter-user-focus',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  });

  await transaction.run({
    action: 'composer.plus',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
    intent,
  }, async () => {
    native.state.foreground = '8001';
  });

  assert.equal(native.state.foreground, '8001');
  assert.equal(native.state.focused, '9002');
  assert.equal(
    native.state.calls.some(call => call.operation === 'setForegroundWindow' && call.payload.handle === '7001'),
    false,
  );
  assert.deepEqual(native.state.placement, MINIMIZED_PLACEMENT);
});
