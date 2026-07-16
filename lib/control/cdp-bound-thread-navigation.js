'use strict';

function navigationError(result = {}) {
  const error = new Error(String(result.message || 'The exact Codex desktop task could not be selected through the bound CDP target.'));
  error.code = String(result.code || 'CODEX_THREAD_SELECTION_UNCONFIRMED');
  error.statusCode = 409;
  error.details = {
    observedThreadId: String(result.observedThreadId || ''),
  };
  return error;
}

function createCdpBoundThreadNavigator(options = {}) {
  if (typeof options.activateViaCdp !== 'function') {
    throw new TypeError('CDP-bound thread navigation requires activateViaCdp().');
  }
  return async threadId => {
    const result = await options.activateViaCdp(threadId);
    if (!result || result.ok !== true || String(result.threadId || '').toLowerCase() !== String(threadId || '').toLowerCase()) {
      throw navigationError(result);
    }
    return {
      method: 'cdp-bound-thread',
      confirmedThreadId: String(threadId).toLowerCase(),
    };
  };
}

module.exports = {
  createCdpBoundThreadNavigator,
  navigationError,
};
