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
    runner(operation, payload) {
      assert.equal(operation, 'listTopLevelWindows');
      assert.deepEqual(payload, { processId: 321 });
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

  assert.deepEqual(adapter.listTopLevelWindows({ processId: 321 }), [{
    handle: '9001',
    ownerHandle: null,
    processId: 321,
    processName: 'ChatGPT.exe',
    title: 'Codex',
    visible: true,
  }]);
});

test('adapter rejects invalid process filters before invoking the native helper', () => {
  let calls = 0;
  const adapter = new Win32FocusAdapter({
    runner() { calls += 1; },
  });
  for (const processId of [0, -1, 1.5, 0x1_0000_0000, 'not-a-pid']) {
    assert.throws(() => adapter.listTopLevelWindows({ processId }), /positive.*integer/i);
  }
  assert.equal(calls, 0);
});

test('native runner compiles one stable helper and sends every operation only over stdin', () => {
  const invocations = [];
  let assemblyExists = false;
  const runner = createPowerShellWin32Runner({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    runtimeDir: 'E:\\runtime\\win32-focus',
    existsSync() {
      return assemblyExists;
    },
    mkdirSync() {},
    execFileSync(file, args, options) {
      const invocation = { file, args: [...args], options: { ...options } };
      invocations.push(invocation);
      if (file.endsWith('powershell.exe')) {
        assemblyExists = true;
        return '';
      }
      const request = JSON.parse(options.input);
      if (request.operation === '__health') return '{"ok":true}\r\n';
      return '{"handle":"7001"}\r\n';
    },
  });

  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.equal(invocations.length, 4, 'one compile, one native validation, and two native operations');
  const compileInvocation = invocations[0];
  const validationInvocation = invocations[1];
  const invocation = invocations[2];
  assert.equal(compileInvocation.file.endsWith('powershell.exe'), true);
  assert.match(validationInvocation.file, /Codex2FrpFocusNative-[a-f0-9]{64}\.exe$/);
  assert.equal(invocation.file, validationInvocation.file);
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.options.windowsHide, false);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.encoding, 'utf8');
  const compileScript = compileInvocation.options.input;
  const request = JSON.parse(invocation.options.input);
  assert.equal(typeof compileScript, 'string');
  assert.ok(compileScript.length > invocation.options.input.length * 2,
    'the native source is confined to the one-time compiler input');
  assert.equal(compileInvocation.args.some(argument => argument.includes('Codex2FrpFocusNative')), false,
    'the native source never enters the Windows command line');
  assert.match(compileScript, /Add-Type -TypeDefinition \$source -Language CSharp -OutputAssembly \$tempPath -OutputType ConsoleApplication/);
  assert.match(compileScript, /Move-Item -LiteralPath \$tempPath -Destination \$assemblyPath/);
  assert.deepEqual(JSON.parse(validationInvocation.options.input), { operation: '__health', payload: {} });
  assert.deepEqual(request, { operation: 'getForegroundWindow', payload: {} });
  assert.equal(invocation.args.some(argument => argument.includes('getForegroundWindow')), false,
    'operation and payload never enter the command line');
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
    assert.match(compileScript, new RegExp(api));
  }
  assert.match(compileScript, /finally\s*\{[\s\S]*AttachThreadInput\([^;]+false\)/,
    'temporary input attachment is always detached');
  assert.match(compileScript, /GetForegroundWindow\(\)\s*==\s*handle/,
    'activation reports success only when the target is actually foreground');
  assert.match(compileScript, /ListWindows\(uint filterProcessId\)[\s\S]*GetWindowThreadProcessId\(handle, out processId\);[\s\S]*filterProcessId != 0 && processId != filterProcessId[\s\S]*processNames\.TryGetValue/,
    'a bound process is rejected before process-name and title work, while generic discovery caches process names');
  assert.doesNotMatch(compileScript, /SendKeys|keybd_event|SetWindowPos/,
    'activation uses neither keyboard simulation nor permanent topmost flags');
});

test('native runner uses an existing cached helper without invoking PowerShell', () => {
  const invocations = [];
  const runner = createPowerShellWin32Runner({
    platform: 'win32',
    runtimeDir: 'E:\\runtime\\win32-focus',
    existsSync: () => true,
    mkdirSync() {},
    execFileSync(file, args, options) {
      invocations.push({ file, args, options });
      const request = JSON.parse(options.input);
      return request.operation === '__health' ? '{"ok":true}\r\n' : '{"handle":"7001"}\r\n';
    },
  });

  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.equal(invocations.length, 2, 'one bounded native validation plus the operation');
  assert.equal(invocations.some(row => row.file.endsWith('powershell.exe')), false);
  assert.match(invocations[0].file, /Codex2FrpFocusNative-[a-f0-9]{64}\.exe$/);
  assert.deepEqual(invocations[0].args, []);
});

test('native runner removes one corrupt hash-named helper and rebuilds it once', () => {
  const invocations = [];
  const removed = [];
  let corrupt = true;
  let assemblyExists = true;
  const runner = createPowerShellWin32Runner({
    platform: 'win32',
    runtimeDir: 'E:\\runtime\\win32-focus',
    existsSync: () => assemblyExists,
    mkdirSync() {},
    unlinkSync(file) {
      removed.push(file);
      assemblyExists = false;
      corrupt = false;
    },
    execFileSync(file, args, options) {
      invocations.push({ file, args, options });
      if (file.endsWith('powershell.exe')) {
        assemblyExists = true;
        return '';
      }
      const request = JSON.parse(options.input);
      if (request.operation === '__health') {
        if (corrupt) throw new Error('Bad IL format');
        return '{"ok":true}\r\n';
      }
      return '{"handle":"7001"}\r\n';
    },
  });

  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.deepEqual(runner('getForegroundWindow', {}), { handle: '7001' });
  assert.equal(removed.length, 1);
  assert.match(removed[0], /Codex2FrpFocusNative-[a-f0-9]{64}\.exe$/);
  assert.equal(invocations.filter(row => row.file.endsWith('powershell.exe')).length, 1);
  assert.equal(invocations.length, 5, 'failed validation, compile, validation, and two operations');
});

test('native runner fails closed when the cached helper cannot be prepared', () => {
  let calls = 0;
  const runner = createPowerShellWin32Runner({
    platform: 'win32',
    runtimeDir: 'E:\\runtime\\win32-focus',
    existsSync: () => false,
    mkdirSync() {},
    execFileSync() {
      calls += 1;
      throw new Error('compiler denied');
    },
  });

  assert.throws(() => runner('getForegroundWindow', {}), error => {
    assert.equal(error.code, 'WIN32_FOCUS_ASSEMBLY_FAILED');
    assert.match(error.message, /could not be prepared/i);
    assert.equal(JSON.stringify(error.details).includes('E:\\runtime'), false);
    return true;
  });
  assert.equal(calls, 1, 'the operation is not attempted without a loadable native bridge');
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
