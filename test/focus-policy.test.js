'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WINDOW_SHOW_STATES,
  captureWindowSession,
} = require('../lib/windows/window-session');
const {
  CODEX_PROCESS_NAMES,
  discoverCodexWindow,
} = require('../lib/windows/codex-window-discovery');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createWin32Adapter(options = {}) {
  let foreground = options.foreground || 'editor-window';
  const placements = new Map(Object.entries(options.placements || {}));
  const validWindows = new Set(options.validWindows || [foreground, ...placements.keys()]);
  const windows = (options.windows || []).map(clone);
  const events = [];

  return {
    events,
    listTopLevelWindows() {
      events.push({ type: 'listTopLevelWindows' });
      return windows.map(clone);
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
    },
    activateWindow(handle) {
      events.push({ type: 'activateWindow', handle });
      foreground = handle;
      const placement = placements.get(handle);
      if (placement && placement.showState === WINDOW_SHOW_STATES.MINIMIZED) {
        placements.set(handle, { ...clone(placement), showState: WINDOW_SHOW_STATES.NORMAL });
      }
    },
    setForegroundWindow(handle) {
      events.push({ type: 'setForegroundWindow', handle });
      foreground = handle;
    },
    isWindow(handle) {
      return validWindows.has(handle);
    },
    simulateUserFocus(handle) {
      validWindows.add(handle);
      foreground = handle;
      events.push({ type: 'simulateUserFocus', handle });
    },
    currentForeground() {
      return foreground;
    },
    placementOf(handle) {
      return clone(placements.get(handle));
    },
  };
}

test('dynamic Codex discovery prefers the current ChatGPT.exe host over legacy Codex.exe', () => {
  const legacy = {
    handle: 'legacy-codex',
    processId: 100,
    processName: 'Codex.exe',
    title: 'Codex',
    visible: true,
    ownerHandle: null,
  };
  const current = {
    handle: 'current-codex',
    processId: 200,
    processName: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe',
    title: 'Codex',
    visible: true,
    ownerHandle: null,
  };
  const adapter = createWin32Adapter({
    windows: [legacy, { handle: 'notes', processName: 'notepad.exe', visible: true }, current],
  });

  assert.deepEqual(CODEX_PROCESS_NAMES, ['chatgpt.exe', 'codex.exe']);
  assert.deepEqual(discoverCodexWindow(adapter), current);
  assert.equal(adapter.events.some(event => event.type === 'activateWindow'), false);
});

test('dynamic Codex discovery falls back to visible legacy Codex.exe windows', () => {
  const legacy = {
    handle: 'legacy-codex',
    processId: 101,
    processName: 'C:\\Users\\test\\AppData\\Local\\Programs\\Codex\\CODEX.EXE',
    title: 'Codex',
    visible: true,
    ownerHandle: null,
  };
  const adapter = createWin32Adapter({
    windows: [
      { handle: 'hidden-chatgpt', processName: 'ChatGPT.exe', visible: false },
      legacy,
    ],
  });

  assert.deepEqual(discoverCodexWindow(adapter), legacy);
});

test('dynamic Codex discovery accepts the current ChatGPT process name without an exe suffix', () => {
  const current = {
    handle: 'current-chatgpt',
    processId: 202,
    processName: 'ChatGPT',
    title: 'ChatGPT',
    visible: true,
    ownerHandle: null,
  };
  const adapter = createWin32Adapter({ windows: [current] });

  assert.deepEqual(discoverCodexWindow(adapter), current);
});

for (const showState of Object.values(WINDOW_SHOW_STATES)) {
  test(`window session restores ${showState} placement and the original foreground window`, () => {
    const originalPlacement = {
      showState,
      flags: 0,
      normalPosition: { left: 120, top: 80, right: 1320, bottom: 880 },
    };
    const adapter = createWin32Adapter({
      foreground: 'editor-window',
      placements: { 'codex-window': originalPlacement },
      validWindows: ['editor-window', 'codex-window'],
    });
    const session = captureWindowSession(adapter, 'codex-window');

    session.activate();
    adapter.setWindowPlacement('codex-window', {
      showState: WINDOW_SHOW_STATES.NORMAL,
      flags: 2,
      normalPosition: { left: 0, top: 0, right: 800, bottom: 600 },
    });
    const restored = session.restore();

    assert.deepEqual(adapter.placementOf('codex-window'), originalPlacement);
    assert.equal(adapter.currentForeground(), 'editor-window');
    assert.deepEqual(restored, {
      targetPlacementRestored: true,
      foregroundRestored: true,
      userFocusChanged: false,
    });
  });
}

test('window session preserves a foreground window chosen by the user during the action', () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 10, top: 20, right: 1010, bottom: 720 },
  };
  const adapter = createWin32Adapter({
    foreground: 'editor-window',
    placements: { 'codex-window': originalPlacement },
    validWindows: ['editor-window', 'codex-window'],
  });
  const session = captureWindowSession(adapter, 'codex-window');

  session.activate();
  adapter.simulateUserFocus('browser-window');
  const restored = session.restore();

  assert.deepEqual(adapter.placementOf('codex-window'), originalPlacement);
  assert.equal(adapter.currentForeground(), 'browser-window');
  assert.equal(
    adapter.events.some(event => event.type === 'setForegroundWindow' && event.handle === 'editor-window'),
    false,
  );
  assert.deepEqual(restored, {
    targetPlacementRestored: true,
    foregroundRestored: false,
    userFocusChanged: true,
  });
});

test('window session never steals focus when the post-action foreground cannot be observed', () => {
  const originalPlacement = {
    showState: WINDOW_SHOW_STATES.MINIMIZED,
    flags: 0,
    normalPosition: { left: 25, top: 35, right: 1025, bottom: 735 },
  };
  const adapter = createWin32Adapter({
    foreground: 'editor-window',
    placements: { 'codex-window': originalPlacement },
    validWindows: ['editor-window', 'codex-window'],
  });
  const getForegroundWindow = adapter.getForegroundWindow.bind(adapter);
  let foregroundReads = 0;
  adapter.getForegroundWindow = () => {
    foregroundReads += 1;
    if (foregroundReads > 1) throw new Error('foreground observation unavailable');
    return getForegroundWindow();
  };
  const session = captureWindowSession(adapter, 'codex-window');

  session.activate();
  const restored = session.restore();

  assert.deepEqual(adapter.placementOf('codex-window'), originalPlacement);
  assert.equal(
    adapter.events.some(event => event.type === 'setForegroundWindow'),
    false,
  );
  assert.equal(restored.userFocusChanged, true);
  assert.equal(restored.foregroundRestored, false);
  assert.deepEqual(restored.restoreErrors, ['foreground-capture']);
});
