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

function isCdpUnavailableError(error) {
  const code = String(error && error.code || '');
  return code === 'CODEX_CDP_REQUIRED'
    || code === 'CODEX_CDP_PORT_UNAVAILABLE'
    || code === 'CODEX_CDP_EXISTING_UNREADY'
    || code === 'CODEX_CDP_LAUNCHER_MISSING';
}

function createCdpBoundThreadNavigator(options = {}) {
  if (typeof options.activateViaCdp !== 'function') {
    throw new TypeError('CDP-bound thread navigation requires activateViaCdp().');
  }
  const navigateViaDeepLink = typeof options.navigateViaDeepLink === 'function'
    ? options.navigateViaDeepLink
    : null;
  const canFallback = typeof options.isCdpUnavailable === 'function'
    ? options.isCdpUnavailable
    : isCdpUnavailableError;
  return async threadId => {
    let result;
    try {
      result = await options.activateViaCdp(threadId);
    } catch (error) {
      if (!navigateViaDeepLink || !canFallback(error)) throw error;
      return navigateViaDeepLink(threadId);
    }
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
  isCdpUnavailableError,
  navigationError,
};
