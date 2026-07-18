'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCdpBoundThreadNavigator } = require('../lib/control/cdp-bound-thread-navigation');
const { createDesktopSelectionAdapter } = require('../lib/control/desktop-selection-adapter');
const { createProtectedThreadGuard } = require('../lib/control/protected-thread-guard');
const {
  UiActionCircuitBreaker,
  ExplicitProcessControlTransaction,
  UiActionTransaction,
  attachProcessControlReplacement,
  createExplicitUiIntent,
} = require('../lib/control/ui-action-transaction');
const { WINDOW_SHOW_STATES } = require('../lib/windows/window-session');

const TEST_THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROTECTED_THREAD = '9e32d9f0-2f20-4fb6-8b60-3c4d5e6f7081';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createWin32Adapter(options = {}) {
  const targetWindow = 'codex-window';
  let foreground = options.foreground || 'editor-window';
  let focused = options.focused || 'editor-input';
  const placements = new Map([[targetWindow, clone(options.placement || {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 },
  })]]);
  const validWindows = new Set(['editor-window', 'editor-input', 'codex-input', targetWindow]);
  const events = [];

  return {
    events,
    listTopLevelWindows() {
      events.push({ type: 'listTopLevelWindows' });
      return [{
        handle: targetWindow,
        processId: 300,
        processName: 'ChatGPT.exe',
        title: 'Codex',
        visible: true,
        ownerHandle: null,
      }];
    },
    getForegroundWindow() {
      events.push({ type: 'getForegroundWindow', handle: foreground });
      return foreground;
    },
    getFocusedWindow() {
      events.push({ type: 'getFocusedWindow', handle: focused });
      return focused;
    },
    getWindowPlacement(handle) {
      events.push({ type: 'getWindowPlacement', handle });
      return clone(placements.get(handle));
    },
    setWindowPlacement(handle, placement) {
      events.push({ type: 'setWindowPlacement', handle, placement: clone(placement) });
      placements.set(handle, clone(placement));
    },
    activateWindow(handle) {
      events.push({ type: 'activateWindow', handle });
      foreground = handle;
      focused = 'codex-input';
      const placement = placements.get(handle);
      placements.set(handle, { ...clone(placement), showState: WINDOW_SHOW_STATES.NORMAL });
    },
    setForegroundWindow(handle) {
      events.push({ type: 'setForegroundWindow', handle });
      foreground = handle;
    },
    setFocusedWindow(handle) {
      events.push({ type: 'setFocusedWindow', handle });
      focused = handle;
      return true;
    },
    isWindow(handle) {
      return validWindows.has(handle);
    },
    simulatePlacement(placement) {
      placements.set(targetWindow, clone(placement));
      events.push({ type: 'simulatePlacement', placement: clone(placement) });
    },
    currentForeground() {
      return foreground;
    },
    currentFocus() {
      return focused;
    },
    targetPlacement() {
      return clone(placements.get(targetWindow));
    },
  };
}

function createTransaction(adapter, options = {}) {
  return new UiActionTransaction({
    adapter,
    guard: options.guard || createProtectedThreadGuard(),
    timeoutMs: options.timeoutMs || 100,
    timeoutGraceMs: options.timeoutGraceMs,
    circuitBreaker: options.circuitBreaker,
    resolveObservedThread: options.resolveObservedThread,
    observedThreadReadyTimeoutMs: options.observedThreadReadyTimeoutMs,
    observedThreadPollIntervalMs: options.observedThreadPollIntervalMs,
    now: options.now,
    sleep: options.sleep,
  });
}

function context(intent, overrides = {}) {
  return {
    action: 'composer.plus',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
    intent,
    ...overrides,
  };
}

function createRestartingAdapter(options = {}) {
  const events = [];
  let codexWindow = 'codex-old';
  let codexProcessId = 500;
  let foreground = options.foreground || 'editor-window';
  const validWindows = new Set(['editor-window', 'browser-window', codexWindow]);
  const placements = new Map([[codexWindow, clone(options.placement || {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 7,
    normalPosition: { left: 120, top: 80, right: 1320, bottom: 880 },
  })]]);
  return {
    events,
    listTopLevelWindows() {
      events.push({ type: 'listTopLevelWindows' });
      return codexWindow ? [{
        handle: codexWindow,
        processId: codexProcessId,
        processName: 'ChatGPT.exe',
        title: 'Codex',
        visible: true,
        ownerHandle: null,
      }] : [];
    },
    getForegroundWindow() {
      events.push({ type: 'getForegroundWindow', handle: foreground });
      return foreground;
    },
    getWindowPlacement(handle) {
      events.push({ type: 'getWindowPlacement', handle });
      return clone(placements.get(handle));
    },
    setWindowPlacement(handle, placement) {
      events.push({ type: 'setWindowPlacement', handle, placement: clone(placement) });
      placements.set(handle, clone(placement));
      return true;
    },
    activateWindow(handle) {
      events.push({ type: 'activateWindow', handle });
      foreground = handle;
      return true;
    },
    setForegroundWindow(handle) {
      events.push({ type: 'setForegroundWindow', handle });
      foreground = handle;
      return true;
    },
    isWindow(handle) {
      return validWindows.has(handle);
    },
    restartCodex(newHandle = 'codex-new', processId = 501) {
      validWindows.delete(codexWindow);
      codexWindow = newHandle;
      codexProcessId = processId;
      validWindows.add(newHandle);
      placements.set(newHandle, {
        showState: WINDOW_SHOW_STATES.NORMAL,
        flags: 0,
        normalPosition: { left: 0, top: 0, right: 800, bottom: 600 },
      });
      foreground = newHandle;
      events.push({ type: 'restartCodex', handle: newHandle });
    },
    removeCodexWindow() {
      validWindows.delete(codexWindow);
      codexWindow = '';
    },
    simulateUserFocus(handle) {
      foreground = handle;
      events.push({ type: 'simulateUserFocus', handle });
    },
    currentForeground() { return foreground; },
    placementOf(handle) { return clone(placements.get(handle)); },
  };
}

test('only a branded explicit intent enters a UI transaction and it can be consumed once', async () => {
  const adapter = createWin32Adapter();
  const transaction = createTransaction(adapter);

  await assert.rejects(
    transaction.run(context({ id: 'plain-object' }), async () => 'never'),
    error => {
      assert.equal(error.code, 'UI_EXPLICIT_INTENT_REQUIRED');
      return true;
    },
  );
  assert.equal(adapter.events.length, 0);

  const intent = createExplicitUiIntent({ id: 'intent-once', action: 'composer.plus', threadId: TEST_THREAD });
  assert.equal(await transaction.run(context(intent), async ({ window }) => window.handle), 'codex-window');
  await assert.rejects(transaction.run(context(intent), async () => 'never'), error => {
    assert.equal(error.code, 'UI_EXPLICIT_INTENT_CONSUMED');
    return true;
  });
  assert.equal(adapter.events.filter(event => event.type === 'activateWindow').length, 1);
});

test('the default UI lock serializes transactions globally across coordinator instances', async () => {
  const adapter = createWin32Adapter({ placement: {
    showState: WINDOW_SHOW_STATES.NORMAL,
    flags: 0,
    normalPosition: { left: 20, top: 20, right: 1020, bottom: 720 },
  } });
  const firstTransaction = createTransaction(adapter);
  const secondTransaction = createTransaction(adapter);
  const sequence = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = firstTransaction.run(context(createExplicitUiIntent({
    id: 'intent-lock-1',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    sequence.push('first-start');
    await firstGate;
    sequence.push('first-end');
  });
  const second = secondTransaction.run(context(createExplicitUiIntent({
    id: 'intent-lock-2',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    sequence.push('second-start');
    sequence.push('second-end');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sequence, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(sequence, ['first-start', 'first-end', 'second-start', 'second-end']);

  const activationIndexes = adapter.events
    .map((event, index) => event.type === 'activateWindow' ? index : -1)
    .filter(index => index >= 0);
  assert.equal(activationIndexes.length, 2);
  assert.equal(
    adapter.events.slice(activationIndexes[0] + 1, activationIndexes[1])
      .some(event => event.type === 'setWindowPlacement'),
    true,
  );
});

test('protected tasks are rejected before discovery, capture, or activation', async () => {
  const adapter = createWin32Adapter();
  const transaction = createTransaction(adapter, {
    guard: createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] }),
  });
  const intent = createExplicitUiIntent({
    id: 'intent-protected',
    action: 'composer.plus',
    threadId: PROTECTED_THREAD,
  });

  await assert.rejects(transaction.run(context(intent, {
    threadId: PROTECTED_THREAD,
    desktopThreadId: PROTECTED_THREAD,
  }), async () => 'never'), error => {
    assert.equal(error.code, 'PROTECTED_THREAD');
    return true;
  });
  assert.deepEqual(adapter.events, []);
});

test('explicit task B rejects with 409 before composer mutation when desktop still shows task A', async () => {
  const adapter = createWin32Adapter();
  const transaction = createTransaction(adapter, {
    resolveObservedThread: async () => TEST_THREAD,
  });
  let composerInputs = 0;
  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-target-mismatch',
    action: 'composer.plugin',
    threadId: OTHER_THREAD,
  }), {
    action: 'composer.plugin',
    threadId: OTHER_THREAD,
    requireObservedTargetMatch: true,
  }), async () => {
    composerInputs += 1;
  }), error => {
    assert.equal(error.code, 'THREAD_TARGET_MISMATCH');
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(composerInputs, 0, 'no input or click reaches task A');
  assert.equal(adapter.events.some(event => event.type === 'setFocusedWindow' && event.handle === 'codex-input'), false);
});

test('explicit task B runs only after exact observed identity confirms task B', async () => {
  const adapter = createWin32Adapter();
  const transaction = createTransaction(adapter, {
    resolveObservedThread: async () => OTHER_THREAD,
  });
  let composerInputs = 0;
  await transaction.run(context(createExplicitUiIntent({
    id: 'intent-target-confirmed',
    action: 'composer.plugin',
    threadId: OTHER_THREAD,
  }), {
    action: 'composer.plugin',
    threadId: OTHER_THREAD,
    requireObservedTargetMatch: true,
  }), async () => {
    composerInputs += 1;
  });
  assert.equal(composerInputs, 1);
});

test('desktop selection transaction permits exact A to B navigation and restores window state', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 12,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const win32 = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  let selectedThreadId = TEST_THREAD;
  let navigationCalls = 0;
  const transaction = createTransaction(win32, {
    resolveObservedThread: async () => selectedThreadId,
  });
  const selection = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${selectedThreadId}` }),
    navigate: async ({ threadId }) => {
      navigationCalls += 1;
      selectedThreadId = threadId;
    },
    transaction,
    createIntent: createExplicitUiIntent,
    createSourceToken: () => 'selection-a-to-b',
    sleep: async () => {},
  });

  assert.deepEqual(await selection.openDesktopThread(OTHER_THREAD), {
    status: 'confirmed', requestedThreadId: OTHER_THREAD, observedThreadId: OTHER_THREAD,
  });
  assert.equal(navigationCalls, 1);
  assert.deepEqual(win32.targetPlacement(), originalPlacement);
  assert.equal(win32.currentForeground(), 'editor-window');
  assert.equal(win32.currentFocus(), 'editor-input');
});

test('CDP-unavailable native thread fallback remains bounded by the explicit transaction and restores state', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 14,
    normalPosition: { left: 80, top: 50, right: 1280, bottom: 850 } };
  const win32 = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  const transaction = createTransaction(win32, {
    resolveObservedThread: async () => TEST_THREAD,
  });
  const dispatches = [];
  let now = 0;
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async () => {
      throw Object.assign(new Error('CDP disabled'), { code: 'CODEX_CDP_REQUIRED' });
    },
    navigateViaDeepLink: async threadId => {
      dispatches.push(`codex://threads/${threadId}`);
      return {
        method: 'codex-deep-link',
        confirmedThreadId: threadId,
        route: `codex://threads/${threadId}`,
      };
    },
  });
  const selection = createDesktopSelectionAdapter({
    observeSource: async () => null,
    navigate: ({ threadId }) => navigate(threadId),
    transaction,
    createIntent: createExplicitUiIntent,
    createSourceToken: () => 'native-fallback-transaction',
    confirmationTimeoutMs: 1,
    confirmationPollIntervalMs: 1,
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
  });

  assert.deepEqual(await selection.openDesktopThread(OTHER_THREAD), {
    status: 'confirmed',
    requestedThreadId: OTHER_THREAD,
    observedThreadId: OTHER_THREAD,
    verifiedBy: 'codex-deep-link',
  });
  assert.deepEqual(dispatches, [`codex://threads/${OTHER_THREAD}`]);
  assert.deepEqual(win32.targetPlacement(), originalPlacement);
  assert.equal(win32.currentForeground(), 'editor-window');
  assert.equal(win32.currentFocus(), 'editor-input');
});

test('desktop selection can leave native home without inventing an active source task', async () => {
  const win32 = createWin32Adapter({ foreground: 'editor-window' });
  const guardedContexts = [];
  const baseGuard = createProtectedThreadGuard();
  const transaction = createTransaction(win32, {
    guard: {
      assertAllowed(value) {
        guardedContexts.push({ ...value });
        return baseGuard.assertAllowed(value);
      },
    },
    resolveObservedThread: async () => {
      const error = new Error('native home has no active task');
      error.code = 'UI_ACTIVE_THREAD_UNKNOWN';
      throw error;
    },
    observedThreadReadyTimeoutMs: 20,
    sleep: async () => {},
  });
  let navigationCalls = 0;

  await transaction.run(context(createExplicitUiIntent({
    id: 'intent-home-to-task',
    action: 'thread.openDesktop',
    threadId: OTHER_THREAD,
  }), {
    action: 'thread.openDesktop',
    threadId: OTHER_THREAD,
    requireObservedTargetMatch: false,
  }), async () => {
    navigationCalls += 1;
  });

  assert.equal(navigationCalls, 1);
  assert.ok(guardedContexts.every(value => value.threadId === OTHER_THREAD));
  assert.deepEqual(win32.currentForeground(), 'editor-window');
});

test('protected desktop selection target is rejected before discovery or navigation', async () => {
  const win32 = createWin32Adapter();
  let navigationCalls = 0;
  const transaction = createTransaction(win32, {
    guard: createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] }),
    resolveObservedThread: async () => TEST_THREAD,
  });
  const selection = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${TEST_THREAD}` }),
    navigate: async () => { navigationCalls += 1; },
    transaction,
    createIntent: createExplicitUiIntent,
    createSourceToken: () => 'selection-protected',
  });

  await assert.rejects(selection.openDesktopThread(PROTECTED_THREAD), error => error.code === 'PROTECTED_THREAD');
  assert.equal(navigationCalls, 0);
  assert.deepEqual(win32.events, []);
});

test('desktop selection post-confirmation mismatch returns conflict state and restores window state', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 13,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const win32 = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  let now = 0;
  const transaction = createTransaction(win32, {
    resolveObservedThread: async () => TEST_THREAD,
  });
  const selection = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${TEST_THREAD}` }),
    navigate: async () => {},
    transaction,
    createIntent: createExplicitUiIntent,
    createSourceToken: () => 'selection-mismatch',
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
    confirmationTimeoutMs: 20,
    confirmationPollIntervalMs: 10,
  });

  assert.deepEqual(await selection.openDesktopThread(OTHER_THREAD), {
    status: 'uncertain',
    requestedThreadId: OTHER_THREAD,
    observedThreadId: TEST_THREAD,
    reason: 'desktop_selection_mismatch',
  });
  assert.deepEqual(win32.targetPlacement(), originalPlacement);
  assert.equal(win32.currentForeground(), 'editor-window');
  assert.equal(win32.currentFocus(), 'editor-input');
});

test('background actions cannot enter or consume an explicit UI transaction', async () => {
  const adapter = createWin32Adapter();
  const transaction = createTransaction(adapter);
  const intent = createExplicitUiIntent({
    id: 'intent-background',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  });

  await assert.rejects(transaction.run(context(intent, { background: true }), async () => 'never'), error => {
    assert.equal(error.code, 'UI_BACKGROUND_ACTION_FORBIDDEN');
    return true;
  });
  assert.deepEqual(adapter.events, []);
  assert.equal(await transaction.run(context(intent), async () => 'foreground-ok'), 'foreground-ok');
});

test('action errors still restore the original placement and foreground in finally', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MAXIMIZED,
    flags: 0,
    normalPosition: { left: 40, top: 30, right: 1240, bottom: 830 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement });
  const transaction = createTransaction(adapter);
  const failure = new Error('UI action failed');

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-error',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    adapter.simulatePlacement({
      showState: WINDOW_SHOW_STATES.NORMAL,
      flags: 9,
      normalPosition: { left: 0, top: 0, right: 600, bottom: 400 },
    });
    throw failure;
  }), error => error === failure);

  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('activation errors still restore the captured placement and foreground', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 90, top: 70, right: 1190, bottom: 770 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement });
  const activate = adapter.activateWindow.bind(adapter);
  const activationFailure = new Error('native activation failed');
  adapter.activateWindow = handle => {
    activate(handle);
    throw activationFailure;
  };
  const transaction = createTransaction(adapter);

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-activation-error',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => 'must-not-run'), error => error === activationFailure);

  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('a rejected native activation never runs the UI operation and still restores state', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MAXIMIZED,
    flags: 0,
    normalPosition: { left: 30, top: 20, right: 1430, bottom: 920 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement });
  const activate = adapter.activateWindow.bind(adapter);
  adapter.activateWindow = handle => {
    activate(handle);
    return false;
  };
  const transaction = createTransaction(adapter);
  let operationRan = false;

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-activation-rejected',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    operationRan = true;
  }), error => {
    assert.equal(error.code, 'UI_WINDOW_ACTIVATION_FAILED');
    return true;
  });

  assert.equal(operationRan, false);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('placement restore failures still attempt foreground restore and surface a state error', async () => {
  const adapter = createWin32Adapter();
  adapter.setWindowPlacement = () => {
    throw new Error('native placement restore failed');
  };
  const transaction = createTransaction(adapter);

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-placement-restore-error',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => 'operation-complete'), error => {
    assert.equal(error.code, 'UI_STATE_RESTORE_FAILED');
    assert.equal(error.details.targetPlacementRestored, false);
    assert.equal(error.details.foregroundRestored, true);
    return true;
  });

  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('foreground restore rejection is surfaced instead of reporting a successful UI action', async () => {
  const adapter = createWin32Adapter();
  adapter.setForegroundWindow = () => false;
  const transaction = createTransaction(adapter);

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-foreground-restore-error',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => 'operation-complete'), error => {
    assert.equal(error.code, 'UI_STATE_RESTORE_FAILED');
    assert.equal(error.details.targetPlacementRestored, true);
    assert.equal(error.details.foregroundRestored, false);
    return true;
  });
});

test('an unobservable post-action foreground fails closed without reclaiming focus', async () => {
  const adapter = createWin32Adapter();
  const getForegroundWindow = adapter.getForegroundWindow.bind(adapter);
  let foregroundReads = 0;
  adapter.getForegroundWindow = () => {
    foregroundReads += 1;
    if (foregroundReads > 1) throw new Error('foreground observation unavailable');
    return getForegroundWindow();
  };
  const transaction = createTransaction(adapter);

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-foreground-observation-error',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => 'operation-complete'), error => {
    assert.equal(error.code, 'UI_STATE_RESTORE_FAILED');
    assert.deepEqual(error.details.restoreErrors, ['foreground-capture']);
    return true;
  });

  assert.equal(
    adapter.events.some(event => event.type === 'setForegroundWindow'),
    false,
  );
});

test('action timeout aborts the operation and restores placement and foreground in finally', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 70, top: 50, right: 1170, bottom: 750 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement });
  const transaction = createTransaction(adapter, { timeoutMs: 15 });
  let actionSignal;

  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-timeout',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async ({ signal }) => {
    actionSignal = signal;
    adapter.simulatePlacement({
      showState: WINDOW_SHOW_STATES.NORMAL,
      flags: 1,
      normalPosition: { left: 0, top: 0, right: 500, bottom: 300 },
    });
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }), error => {
    assert.equal(error.code, 'UI_ACTION_TIMEOUT');
    return true;
  });

  assert.equal(actionSignal.aborted, true);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('timeout keeps the global lock until an abort-ignoring operation settles and then restores late effects', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 80, top: 60, right: 1180, bottom: 760 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement });
  const firstTransaction = createTransaction(adapter, { timeoutMs: 15 });
  const secondTransaction = createTransaction(adapter, { timeoutMs: 100 });
  const sequence = [];
  let actionSignal;
  let releaseLateOperation;
  const lateGate = new Promise(resolve => { releaseLateOperation = resolve; });

  const first = firstTransaction.run(context(createExplicitUiIntent({
    id: 'intent-timeout-late-effect',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async ({ signal }) => {
    actionSignal = signal;
    await lateGate;
    adapter.simulatePlacement({
      showState: WINDOW_SHOW_STATES.NORMAL,
      flags: 99,
      normalPosition: { left: 0, top: 0, right: 400, bottom: 300 },
    });
    sequence.push('late-effect');
  }).catch(error => error);
  const second = secondTransaction.run(context(createExplicitUiIntent({
    id: 'intent-timeout-followup',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    sequence.push('second-start');
  });

  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(actionSignal.aborted, true);
  assert.deepEqual(sequence, [], 'the next UI action remains locked while the timed-out operation can still mutate UI');
  releaseLateOperation();
  const timeoutError = await first;
  await second;

  assert.equal(timeoutError.code, 'UI_ACTION_TIMEOUT');
  assert.deepEqual(sequence, ['late-effect', 'second-start']);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('an abort-ignoring operation enters bounded quarantine and later UI requests fail fast', async () => {
  const adapter = createWin32Adapter();
  const circuitBreaker = new UiActionCircuitBreaker();
  const transaction = createTransaction(adapter, {
    timeoutMs: 10,
    timeoutGraceMs: 10,
    circuitBreaker,
  });
  let fenceRejected = false;
  const startedAt = Date.now();
  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-never-settles',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async ({ signal, fence }) => {
    signal.addEventListener('abort', () => {
      assert.throws(() => fence.assertAllowed(), error => error.code === 'UI_ACTION_TIMEOUT');
      fenceRejected = true;
    }, { once: true });
    return new Promise(() => {});
  }), error => error.code === 'UI_ACTION_TIMEOUT');
  assert.equal(Date.now() - startedAt < 150, true, 'timeout grace is bounded');
  assert.equal(fenceRejected, true);

  let followupRan = false;
  const followupStartedAt = Date.now();
  await assert.rejects(transaction.run(context(createExplicitUiIntent({
    id: 'intent-after-quarantine',
    action: 'composer.plus',
    threadId: TEST_THREAD,
  })), async () => {
    followupRan = true;
  }), error => error.code === 'UI_ACTION_QUARANTINED');
  assert.equal(Date.now() - followupStartedAt < 50, true, 'quarantined follow-up rejects without pending');
  assert.equal(followupRan, false);
});

test('ordinary UI guard re-resolves the observed desktop task inside the global lock', async () => {
  const adapter = createWin32Adapter();
  const observations = [TEST_THREAD, PROTECTED_THREAD];
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] });
  const resolveObservedThread = async () => observations.shift() || PROTECTED_THREAD;
  const firstTransaction = createTransaction(adapter, { guard, resolveObservedThread });
  const secondTransaction = createTransaction(adapter, { guard, resolveObservedThread });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let secondRan = false;
  const first = firstTransaction.run(context(createExplicitUiIntent({
    id: 'intent-toctou-ui-first', action: 'composer.plus', threadId: TEST_THREAD,
  })), async () => firstGate);
  const second = secondTransaction.run(context(createExplicitUiIntent({
    id: 'intent-toctou-ui-second', action: 'composer.plus', threadId: TEST_THREAD,
  })), async () => { secondRan = true; });
  await new Promise(resolve => setImmediate(resolve));
  releaseFirst();
  await first;
  await assert.rejects(second, error => error.code === 'PROTECTED_THREAD');
  assert.equal(secondRan, false);
});

test('minimized explicit UI action activates before resolving the observed task and restores afterwards', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 9,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const adapter = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  let resolverForeground = '';
  const transaction = createTransaction(adapter, { resolveObservedThread: async () => {
    resolverForeground = adapter.currentForeground();
    return TEST_THREAD;
  } });
  let operationRan = false;
  await transaction.run(context(createExplicitUiIntent({ id:'intent-minimized-order', action:'composer.plus', threadId:TEST_THREAD })), async () => {
    operationRan = true;
  });
  assert.equal(resolverForeground, 'codex-window');
  assert.equal(operationRan, true);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
  assert.equal(adapter.currentFocus(), 'editor-input');
});

test('successful explicit action restores focused HWND, foreground, and minimized placement', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 2,
    showCmd: 2,
    minimized: true,
    normalPosition: { left: 90, top: 70, right: 1190, bottom: 770 },
  };
  const adapter = createWin32Adapter({ placement: originalPlacement, focused: 'editor-input' });
  const transaction = createTransaction(adapter);
  await transaction.run(context(createExplicitUiIntent({
    id: 'intent-focus-restore', action: 'composer.plus', threadId: TEST_THREAD,
  })), async () => 'done');
  assert.equal(adapter.currentForeground(), 'editor-window');
  assert.equal(adapter.currentFocus(), 'editor-input');
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.events.some(event => event.type === 'setFocusedWindow'), true);
});

test('read-only explicit UI action skips task identity guard and restores minimized state and focus', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 11,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const adapter = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  let resolverCalls = 0;
  const transaction = createTransaction(adapter, {
    guard: createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] }),
    resolveObservedThread: async () => {
      resolverCalls += 1;
      throw Object.assign(new Error('unknown'), { code: 'UI_ACTIVE_THREAD_UNKNOWN' });
    },
  });
  let operationRan = false;
  await transaction.run(context(createExplicitUiIntent({
    id: 'intent-read-only-menu', action: 'composer.plus', threadId: TEST_THREAD,
  }), { access: 'readOnly' }), async () => {
    operationRan = true;
  });
  assert.equal(operationRan, true);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('unknown observed task after activation fails closed and still restores minimized state and focus', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 3,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const adapter = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  const unknown = Object.assign(new Error('unknown'), { code:'UI_ACTIVE_THREAD_UNKNOWN' });
  let now = 0;
  const transaction = createTransaction(adapter, {
    resolveObservedThread: async () => { throw unknown; },
    observedThreadReadyTimeoutMs: 20,
    observedThreadPollIntervalMs: 10,
    now: () => now,
    sleep: async ms => { now += ms; },
  });
  let operationRan = false;
  await assert.rejects(transaction.run(context(createExplicitUiIntent({ id:'intent-minimized-unknown', action:'composer.plus', threadId:TEST_THREAD })), async () => {
    operationRan = true;
  }), error => error.code === 'UI_ACTIVE_THREAD_UNKNOWN');
  assert.equal(operationRan, false);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('protected observed task is checked after activation and still restores minimized state and focus', async () => {
  const originalPlacement = { showState: WINDOW_SHOW_STATES.MINIMIZED, flags: 5,
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 } };
  const adapter = createWin32Adapter({ placement: originalPlacement, foreground: 'editor-window' });
  let observedForeground = '';
  const transaction = createTransaction(adapter, {
    guard: createProtectedThreadGuard({ protectedThreadIds:[PROTECTED_THREAD] }),
    resolveObservedThread: async () => { observedForeground = adapter.currentForeground(); return PROTECTED_THREAD; }
  });
  let operationRan = false;
  await assert.rejects(transaction.run(context(createExplicitUiIntent({ id:'intent-minimized-protected', action:'composer.plus', threadId:TEST_THREAD })), async () => {
    operationRan = true;
  }), error => error.code === 'PROTECTED_THREAD');
  assert.equal(observedForeground, 'codex-window');
  assert.equal(operationRan, false);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('explicit UI waits with bounded readiness polling for active task after activation', async () => {
  const adapter = createWin32Adapter({ foreground:'editor-window' });
  const observations = ['', '', TEST_THREAD];
  let now = 0;
  const sleeps = [];
  const transaction = createTransaction(adapter, {
    resolveObservedThread: async () => observations.shift() ?? TEST_THREAD,
    observedThreadReadyTimeoutMs: 200,
    observedThreadPollIntervalMs: 25,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
  });
  let operationRan = false;
  await transaction.run(context(createExplicitUiIntent({ id:'intent-readiness-success', action:'composer.plus', threadId:TEST_THREAD })), async () => {
    operationRan = true;
  });
  assert.equal(operationRan, true);
  assert.deepEqual(sleeps, [25, 25]);
  assert.equal(adapter.currentForeground(), 'editor-window');
  assert.equal(sleeps.reduce((sum, value) => sum + value, 0) <= 200, true);
});

test('active task readiness timeout fails closed without a long sleep and restores state', async () => {
  const originalPlacement = { showState:WINDOW_SHOW_STATES.MINIMIZED, flags:4,
    normalPosition:{ left:100, top:60, right:1300, bottom:860 } };
  const adapter = createWin32Adapter({ foreground:'editor-window', placement:originalPlacement });
  let now = 0;
  const sleeps = [];
  const transaction = createTransaction(adapter, {
    resolveObservedThread: async () => { throw Object.assign(new Error('not ready'), { code:'UI_ACTIVE_THREAD_UNKNOWN' }); },
    observedThreadReadyTimeoutMs: 90,
    observedThreadPollIntervalMs: 30,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; },
  });
  await assert.rejects(transaction.run(context(createExplicitUiIntent({ id:'intent-readiness-timeout', action:'composer.plus', threadId:TEST_THREAD })), async () => {}),
    error => error.code === 'UI_ACTIVE_THREAD_UNKNOWN');
  assert.deepEqual(sleeps, [30,30,30]);
  assert.equal(Math.max(...sleeps) <= 30, true);
  assert.deepEqual(adapter.targetPlacement(), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});

test('explicit process control rebinds restoration to a restarted Codex HWND without activating the old HWND', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 7,
    normalPosition: { left: 120, top: 80, right: 1320, bottom: 880 },
  };
  const adapter = createRestartingAdapter({ placement: originalPlacement });
  const transaction = new ExplicitProcessControlTransaction({
    adapter,
    guard: createProtectedThreadGuard(),
    timeoutMs: 100,
  });
  const result = await transaction.run({
    action: 'control.enable',
    threadId: 'desktop-control',
    desktopThreadId: '',
    intent: createExplicitUiIntent({
      id: 'intent-process-restart',
      action: 'control.enable',
      threadId: 'desktop-control',
    }),
  }, async ({ signal }) => {
    assert.equal(signal.aborted, false);
    adapter.restartCodex('codex-new', 501);
    return attachProcessControlReplacement({ ready: true }, { processId: 501 });
  });

  assert.deepEqual(result, {
    value: { ready: true },
    processControl: {
      targetRebound: true,
      targetPlacementRestored: true,
      foregroundRestored: true,
      userFocusChanged: false,
    },
  });
  assert.deepEqual(adapter.placementOf('codex-new'), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
  assert.equal(adapter.events.some(event => event.type === 'activateWindow'), false);
  assert.equal(adapter.events.some(event => (
    event.type === 'setWindowPlacement' && event.handle === 'codex-old'
  )), false);
});

test('explicit process control blocks background actions but permits non-mutating enable while protected task is visible', async () => {
  const adapter = createRestartingAdapter();
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] });
  const transaction = new ExplicitProcessControlTransaction({ adapter, guard });

  await assert.rejects(transaction.run({
    action: 'control.enable',
    threadId: TEST_THREAD,
    background: true,
    intent: createExplicitUiIntent({ id: 'process-background', action: 'control.enable', threadId: TEST_THREAD }),
  }, async () => {}), error => error.code === 'UI_BACKGROUND_ACTION_FORBIDDEN');
  assert.deepEqual(adapter.events, []);

  const enabled = await transaction.run({
    action: 'control.enable',
    threadId: PROTECTED_THREAD,
    desktopThreadId: PROTECTED_THREAD,
    intent: createExplicitUiIntent({ id: 'process-protected', action: 'control.enable', threadId: PROTECTED_THREAD }),
  }, async () => ({ ready: true }));

  assert.deepEqual(enabled.value, { ready: true });
});

test('process control guard does not confuse a protected desktop observation with a protected-task mutation', async () => {
  const adapter = createRestartingAdapter();
  const observations = [TEST_THREAD, PROTECTED_THREAD];
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED_THREAD] });
  const options = {
    adapter,
    guard,
    resolveObservedThread: async () => observations.shift() || PROTECTED_THREAD,
  };
  const firstTransaction = new ExplicitProcessControlTransaction(options);
  const secondTransaction = new ExplicitProcessControlTransaction(options);
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let secondRan = false;
  const first = firstTransaction.run({
    action: 'control.enable',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
    intent: createExplicitUiIntent({ id: 'intent-toctou-process-first', action: 'control.enable', threadId: TEST_THREAD }),
  }, async () => firstGate);
  const second = secondTransaction.run({
    action: 'control.enable',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
    intent: createExplicitUiIntent({ id: 'intent-toctou-process-second', action: 'control.enable', threadId: TEST_THREAD }),
  }, async () => { secondRan = true; });
  await new Promise(resolve => setImmediate(resolve));
  releaseFirst();
  await first;
  await second;
  assert.equal(secondRan, true);
  assert.equal(observations.length, 0);
});

test('process control restores only the replacement process returned by the restart operation', async () => {
  const adapter = createRestartingAdapter();
  const listWindows = adapter.listTopLevelWindows.bind(adapter);
  let unrelatedVisible = false;
  adapter.listTopLevelWindows = () => [
    ...(unrelatedVisible ? [{
      handle: 'codex-unrelated',
      processId: 999,
      processName: 'ChatGPT.exe',
      title: 'Codex unrelated',
      visible: true,
      ownerHandle: null,
    }] : []),
    ...listWindows(),
  ];
  const transaction = new ExplicitProcessControlTransaction({
    adapter,
    guard: createProtectedThreadGuard(),
  });
  await transaction.run({
    action: 'control.enable',
    threadId: 'desktop-control',
    intent: createExplicitUiIntent({ id: 'intent-process-bound-pid', action: 'control.enable', threadId: 'desktop-control' }),
  }, async () => {
    adapter.restartCodex('codex-new', 501);
    unrelatedVisible = true;
    return attachProcessControlReplacement({ ready: true }, { processId: 501 });
  });

  assert.equal(adapter.events.some(event => (
    event.type === 'setWindowPlacement' && event.handle === 'codex-new'
  )), true);
  assert.equal(adapter.events.some(event => (
    event.type === 'setWindowPlacement' && event.handle === 'codex-unrelated'
  )), false);
});

test('a process restart that settles during timeout grace still restores its bound replacement', async () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 4,
    normalPosition: { left: 70, top: 50, right: 1270, bottom: 850 },
  };
  const adapter = createRestartingAdapter({ placement: originalPlacement });
  const transaction = new ExplicitProcessControlTransaction({
    adapter,
    guard: createProtectedThreadGuard(),
    timeoutMs: 10,
    timeoutGraceMs: 60,
    circuitBreaker: new UiActionCircuitBreaker(),
  });

  await assert.rejects(transaction.run({
    action: 'control.enable',
    threadId: 'desktop-control',
    intent: createExplicitUiIntent({ id: 'intent-process-timeout-bound', action: 'control.enable', threadId: 'desktop-control' }),
  }, async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    adapter.restartCodex('codex-new', 501);
    return attachProcessControlReplacement({ ready: true }, { processId: 501 });
  }), error => error.code === 'UI_ACTION_TIMEOUT');
  assert.deepEqual(adapter.placementOf('codex-new'), originalPlacement);
  assert.equal(adapter.currentForeground(), 'editor-window');
});
