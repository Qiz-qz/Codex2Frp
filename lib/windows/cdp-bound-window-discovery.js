'use strict';

const { discoverCodexWindow } = require('./codex-window-discovery');

function createBoundCodexWindowDiscovery(options = {}) {
  const getProcessId = typeof options.getProcessId === 'function'
    ? options.getProcessId
    : () => 0;
  const discover = typeof options.discoverWindow === 'function'
    ? options.discoverWindow
    : discoverCodexWindow;

  return adapter => {
    const processId = Number(getProcessId());
    if (!Number.isSafeInteger(processId) || processId <= 0) return discover(adapter);
    const windows = adapter && typeof adapter.listTopLevelWindows === 'function'
      ? adapter.listTopLevelWindows({ processId }) || []
      : [];
    return discover({
      listTopLevelWindows: () => windows.filter(window => Number(window && window.processId) === processId),
    });
  };
}

module.exports = {
  createBoundCodexWindowDiscovery,
};
