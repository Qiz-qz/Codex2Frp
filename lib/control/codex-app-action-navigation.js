'use strict';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeThreadId(value) {
  const threadId = String(value || '').trim().toLowerCase();
  return THREAD_ID.test(threadId) ? threadId : '';
}

const RESOLVE_APP_HOST = `async () => {
  const resourceUrls = performance.getEntriesByType('resource')
    .map(entry => String(entry?.name || ''))
    .filter(url => /\\/assets\\/rpc-[A-Za-z0-9_-]+\\.js(?:$|[?#])/.test(url));
  let rpcUrl = resourceUrls.at(-1);
  if (!rpcUrl) {
    const entryUrl = [...document.scripts]
      .map(script => String(script?.src || ''))
      .find(url => /\\/assets\\/index-[A-Za-z0-9_-]+\\.js(?:$|[?#])/.test(url));
    if (entryUrl) {
      const entrySource = await fetch(entryUrl).then(response => {
        if (!response.ok) throw new Error('Codex renderer entry resource unavailable');
        return response.text();
      });
      const match = entrySource.match(/\\.\\/(rpc-[A-Za-z0-9_-]+\\.js)/);
      if (match) rpcUrl = new URL('./assets/' + match[1], location.href).href;
    }
  }
  if (!rpcUrl) throw new Error('Codex app-action RPC resource unavailable');
  const parsed = new URL(rpcUrl, location.href);
  if (parsed.protocol !== 'app:' || !/^\\/assets\\/rpc-[A-Za-z0-9_-]+\\.js$/.test(parsed.pathname)) {
    throw new Error('Codex app-action RPC resource was not trusted');
  }
  const rpc = await import(parsed.href);
  let primaryActions = rpc.appServices?.appActions;
  if ((!primaryActions || typeof primaryActions.runInPrimaryWindow !== 'function')
      && typeof rpc.initializeAppHostServices === 'function') {
    await rpc.initializeAppHostServices();
    primaryActions = rpc.appServices?.appActions;
  }
  if (primaryActions && typeof primaryActions.runInPrimaryWindow === 'function') {
    return {
      run: envelope => primaryActions.runInPrimaryWindow(envelope),
    };
  }
  const appHost = rpc.appHost || rpc.d;
  if (!appHost || typeof appHost.run !== 'function') {
    throw new Error('Codex app-action RPC export unavailable');
  }
  return appHost;
}`;

function buildShowThreadExpression(value, options = {}) {
  const threadId = normalizeThreadId(value);
  if (!threadId) throw new TypeError('A valid Codex task id is required.');
  const attempts = Math.max(1, Math.min(100, Number(options.attempts) || 50));
  const intervalMs = Math.max(10, Math.min(1000, Number(options.intervalMs) || 100));
  return `(async () => {
    const threadId = ${JSON.stringify(threadId)};
    try {
      const appHost = await (${RESOLVE_APP_HOST})();
      const before = await appHost.run({ action: { type: 'app.get_summary' } });
      const windowId = before?.window?.windowId;
      if (!windowId) throw new Error('Codex app-action windowId unavailable');
      const actionResult = await appHost.run({
        action: { type: 'windows.show_thread', windowId, threadId },
      });
      let after = null;
      for (let index = 0; index < ${attempts}; index += 1) {
        after = await appHost.run({ action: { type: 'app.get_summary' } });
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
      const appHost = await (${RESOLVE_APP_HOST})();
      const summary = await appHost.run({ action: { type: 'app.get_summary' } });
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

function buildShowHomeExpression(options = {}) {
  const attempts = Math.max(1, Math.min(100, Number(options.attempts) || 50));
  const intervalMs = Math.max(10, Math.min(1000, Number(options.intervalMs) || 100));
  return `(async () => {
    try {
      const appHost = await (${RESOLVE_APP_HOST})();
      const before = await appHost.run({ action: { type: 'app.get_summary' } });
      const windowId = before?.window?.windowId;
      if (!windowId) throw new Error('Codex app-action windowId unavailable');
      const actionResult = await appHost.run({ action: { type: 'windows.show_home', windowId } });
      let after = null;
      for (let index = 0; index < ${attempts}; index += 1) {
        after = await appHost.run({ action: { type: 'app.get_summary' } });
        if (after?.window?.route?.kind === 'home' || after?.window?.route?.pathname === '/') break;
        await new Promise(resolve => setTimeout(resolve, ${intervalMs}));
      }
      const home = after?.window?.route?.kind === 'home' || after?.window?.route?.pathname === '/';
      return {
        ok: home,
        windowId,
        actionResult: actionResult ?? null,
        beforeRoute: before?.window?.route ?? null,
        afterRoute: after?.window?.route ?? null,
      };
    } catch (error) {
      return { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } };
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

function normalizeShowHomeResult(value) {
  const route = value && value.afterRoute || null;
  const home = route && (route.kind === 'home' || route.pathname === '/');
  if (!value || value.ok !== true || !home) {
    return {
      ok: false,
      code: value && value.error ? 'CODEX_APP_ACTION_FAILED' : 'CODEX_HOME_SELECTION_UNCONFIRMED',
      message: value && value.error && value.error.message || '',
      route,
    };
  }
  return { ok: true, windowId: String(value.windowId || ''), route, method: 'codex-app-action' };
}

module.exports = {
  buildCurrentThreadExpression,
  buildShowHomeExpression,
  buildShowThreadExpression,
  normalizeShowHomeResult,
  normalizeShowThreadResult,
};
