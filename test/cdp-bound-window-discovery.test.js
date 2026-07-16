'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBoundCodexWindowDiscovery,
} = require('../lib/windows/cdp-bound-window-discovery');

function adapterWith(windows, calls = []) {
  return {
    listTopLevelWindows(filter) {
      calls.push(filter);
      return filter && filter.processId
        ? windows.filter(window => window.processId === filter.processId)
        : windows;
    },
  };
}

test('CDP-bound discovery selects the Codex window owned by the controlled process', () => {
  const discover = createBoundCodexWindowDiscovery({ getProcessId: () => 222 });
  const calls = [];
  const selected = discover(adapterWith([
    { handle: 'main', processId: 111, processName: 'ChatGPT.exe', visible: true },
    { handle: 'isolated', processId: 222, processName: 'ChatGPT.exe', visible: true },
  ], calls));

  assert.equal(selected.handle, 'isolated');
  assert.deepEqual(calls, [{ processId: 222 }]);
});

test('CDP-bound discovery fails closed when the controlled process has no window', () => {
  const discover = createBoundCodexWindowDiscovery({ getProcessId: () => 333 });
  const selected = discover(adapterWith([
    { handle: 'main', processId: 111, processName: 'ChatGPT.exe', visible: true },
    { handle: 'other', processId: 222, processName: 'ChatGPT.exe', visible: true },
  ]));

  assert.equal(selected, null);
});

test('CDP-bound discovery uses ordinary Codex discovery only before a process is bound', () => {
  const discover = createBoundCodexWindowDiscovery({ getProcessId: () => 0 });
  const calls = [];
  const selected = discover(adapterWith([
    { handle: 'main', processId: 111, processName: 'ChatGPT.exe', visible: true },
  ], calls));

  assert.equal(selected.handle, 'main');
  assert.deepEqual(calls, [undefined]);
});
