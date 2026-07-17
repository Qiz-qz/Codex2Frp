'use strict';

const path = require('node:path');

const CODEX_PROCESS_NAMES = Object.freeze([
  'chatgpt.exe',
  'codex.exe',
]);

function normalizedProcessName(value) {
  const name = path.win32.basename(String(value || '').trim()).toLowerCase();
  if (name === 'chatgpt' || name === 'codex') return `${name}.exe`;
  return name;
}

function discoverCodexWindow(adapter) {
  if (!adapter || typeof adapter.listTopLevelWindows !== 'function') {
    throw new TypeError('Codex window discovery requires listTopLevelWindows().');
  }
  const processPriority = new Map(CODEX_PROCESS_NAMES.map((name, index) => [name, index]));
  return (adapter.listTopLevelWindows() || [])
    .map((window, index) => ({
      window,
      index,
      processName: normalizedProcessName(window && window.processName),
    }))
    .filter(candidate => candidate.window
      && candidate.window.handle
      && candidate.window.visible === true
      && processPriority.has(candidate.processName))
    .sort((left, right) => {
      const processOrder = processPriority.get(left.processName) - processPriority.get(right.processName);
      if (processOrder !== 0) return processOrder;
      const ownerOrder = Number(Boolean(left.window.ownerHandle)) - Number(Boolean(right.window.ownerHandle));
      return ownerOrder || left.index - right.index;
    })[0]?.window || null;
}

module.exports = {
  CODEX_PROCESS_NAMES,
  discoverCodexWindow,
  normalizedProcessName,
};
