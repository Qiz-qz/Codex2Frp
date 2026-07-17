'use strict';

function positiveProcessId(value) {
  const processId = Number(value);
  return Number.isSafeInteger(processId) && processId > 0 ? processId : 0;
}

function reconcileCdpProcessBinding(options = {}) {
  const port = Number(options.port);
  const currentProcessId = positiveProcessId(options.currentProcessId);
  const exact = (Array.isArray(options.processes) ? options.processes : [])
    .find(process => Number(process && process.port) === port && positiveProcessId(process && process.processId));
  if (exact) return positiveProcessId(exact.processId);

  const currentStillOwnsWindow = currentProcessId > 0
    && (Array.isArray(options.currentWindows) ? options.currentWindows : [])
      .some(window => Number(window && window.processId) === currentProcessId && window.visible === true);
  return currentStillOwnsWindow ? currentProcessId : 0;
}

module.exports = {
  reconcileCdpProcessBinding,
};
