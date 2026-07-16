'use strict';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeThreadId(value) {
  const threadId = String(value || '').trim().toLowerCase();
  return THREAD_ID.test(threadId) ? threadId : '';
}

function buildShowThreadExpression(value, options = {}) {
  const threadId = normalizeThreadId(value);
  if (!threadId) throw new TypeError('A valid Codex task id is required.');
  const attempts = Math.max(1, Math.min(100, Number(options.attempts) || 50));
  const intervalMs = Math.max(10, Math.min(1000, Number(options.intervalMs) || 100));
  return `(async () => {
    const threadId = ${JSON.stringify(threadId)};
    try {
      const rpc = await import(new URL('./assets/rpc-QupjVyo7.js', location.href).href);
      const before = await rpc.d.run({ action: { type: 'app.get_summary' } });
      const windowId = before?.window?.windowId;
      if (!windowId) throw new Error('Codex app-action windowId unavailable');
      const actionResult = await rpc.d.run({
        action: { type: 'windows.show_thread', windowId, threadId },
      });
      let after = null;
      for (let index = 0; index < ${attempts}; index += 1) {
        after = await rpc.d.run({ action: { type: 'app.get_summary' } });
        if (after?.window?.route?.threadId === threadId) break;
        await new Promise(resolve => setTimeout(resolve, ${intervalMs}));
      }
      return {
        ok: after?.window?.route?.threadId === threadId,
        threadId,
        windowId,
        actionResult: actionResult ?? null,
        beforeRoute: before?.window?.route ?? null,
        afterRoute: after?.window?.route ?? null,
      };
    } catch (error) {
      return {
        ok: false,
        threadId,
        error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) },
      };
    }
  })()`;
}

function buildCurrentThreadExpression() {
  return `(async () => {
    try {
      const rpc = await import(new URL('./assets/rpc-QupjVyo7.js', location.href).href);
      const summary = await rpc.d.run({ action: { type: 'app.get_summary' } });
      const threadId = summary?.window?.route?.threadId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(threadId || ''))) {
        return { route: String(location.href || '') };
      }
      return {
        route: 'app://-/index.html#/local/' + String(threadId).toLowerCase(),
        observedAt: new Date().toISOString(),
      };
    } catch {
      return { route: String(location.href || '') };
    }
  })()`;
}

function normalizeShowThreadResult(value, requestedThreadId) {
  const threadId = normalizeThreadId(requestedThreadId);
  const observedThreadId = normalizeThreadId(value && value.afterRoute && value.afterRoute.threadId);
  if (!threadId || !value || value.ok !== true || observedThreadId !== threadId) {
    return {
      ok: false,
      threadId,
      observedThreadId,
      code: value && value.error ? 'CODEX_APP_ACTION_FAILED' : 'CODEX_THREAD_SELECTION_UNCONFIRMED',
      message: value && value.error && value.error.message || '',
      route: value && value.afterRoute || null,
    };
  }
  return {
    ok: true,
    threadId,
    windowId: String(value.windowId || ''),
    route: value.afterRoute,
    method: 'codex-app-action',
  };
}

module.exports = {
  buildCurrentThreadExpression,
  buildShowThreadExpression,
  normalizeShowThreadResult,
};
