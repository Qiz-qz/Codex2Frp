'use strict';

function guardError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.statusCode = 409;
  error.details = { ...details };
  error.detail = JSON.stringify(error.details);
  return error;
}

async function assertExactThreadBeforeSideEffect(options = {}) {
  const threadId = String(options.threadId || '').trim().toLowerCase();
  if (!threadId) return { threadId: '', skipped: true };
  const details = observedThreadId => ({
    action: String(options.action || ''),
    expectedThreadId: threadId,
    observedThreadId,
  });
  if (typeof options.observe !== 'function') {
    throw guardError(
      'CODEX_THREAD_UNVERIFIED_BEFORE_SIDE_EFFECT',
      'The active Codex task could not be verified immediately before the requested control change.',
      details(''),
    );
  }
  let observed = null;
  try {
    observed = await options.observe();
  } catch (cause) {
    const error = guardError(
      'CODEX_THREAD_UNVERIFIED_BEFORE_SIDE_EFFECT',
      'The active Codex task could not be verified immediately before the requested control change.',
      details(''),
    );
    error.cause = cause;
    throw error;
  }
  const observedThreadId = String(observed && observed.threadId || '').trim().toLowerCase();
  if (!observedThreadId || !observed || observed.confidence !== 'exact') {
    throw guardError(
      'CODEX_THREAD_UNVERIFIED_BEFORE_SIDE_EFFECT',
      'The active Codex task could not be verified immediately before the requested control change.',
      details(observedThreadId),
    );
  }
  if (observedThreadId !== threadId) {
    throw guardError(
      'CODEX_THREAD_CHANGED_BEFORE_SIDE_EFFECT',
      'The active Codex task changed before the requested control change could be applied.',
      details(observedThreadId),
    );
  }
  return observed;
}

module.exports = {
  assertExactThreadBeforeSideEffect,
};
