'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCodexCdpSelectionObserver,
  verifiedSelectionExpression,
} = require('../lib/windows/cdp-selection-observer');

const THREAD = '11111111-2222-4333-8444-555555555555';

test('CDP selection observer evaluates only verified route/action attributes on strict Codex target', async () => {
  let expression = '';
  const observe = createCodexCdpSelectionObserver({
    listTargets: async () => [{
      id: 'main', type: 'page', title: 'Codex', url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/main',
    }],
    evaluate: async (_target, value) => {
      expression = value;
      return {
        actionAttributes: {
          'data-app-action-sidebar-thread-id': THREAD,
          'data-app-action-sidebar-thread-active': 'true',
        },
      };
    },
  });
  assert.equal((await observe()).threadId, THREAD);
  assert.equal(expression, verifiedSelectionExpression());
  assert.match(expression, /data-app-action-sidebar-thread-id/);
  assert.doesNotMatch(expression, /innerText|textContent|document\.title/);
});

test('CDP selection observer distinguishes unavailable transport from an absent exact selection', async () => {
  const unavailable = createCodexCdpSelectionObserver({ listTargets: async () => [] });
  await assert.rejects(unavailable(), error => error.code === 'DESKTOP_SELECTION_OBSERVER_UNAVAILABLE');

  const absent = createCodexCdpSelectionObserver({
    listTargets: async () => [{
      id: 'main', type: 'page', title: 'Codex', url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/main',
    }],
    evaluate: async () => ({ route: 'app://-/index.html' }),
  });
  assert.equal(await absent(), null);
});

test('CDP protected selection rejects title-only pages even when matching action attributes are present', async () => {
  let evaluations = 0;
  const observe = createCodexCdpSelectionObserver({
    listTargets: async () => [{
      id: 'forged', type: 'page', title: 'Codex', url: 'https://attacker.invalid/',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/forged',
    }],
    evaluate: async () => {
      evaluations += 1;
      return {
        actionAttributes: {
          'data-app-action-sidebar-thread-id': THREAD,
          'data-app-action-sidebar-thread-active': 'true',
        },
      };
    },
  });
  await assert.rejects(observe(), error => error.code === 'DESKTOP_SELECTION_OBSERVER_UNAVAILABLE');
  assert.equal(evaluations, 0);
});

test('CDP protected selection accepts canonical renderer and fails closed on conflicting exact sources', async () => {
  const target = {
    id: 'main', type: 'page', title: 'Anything', url: 'app://-/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/main',
  };
  const observe = createCodexCdpSelectionObserver({
    listTargets: async () => [target],
    evaluate: async () => ({
      route: `app://-/index.html#/threads/${THREAD}`,
      actionAttributes: {
        'data-app-action-sidebar-thread-id': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'data-app-action-sidebar-thread-active': 'true',
      },
    }),
  });
  assert.equal(await observe(), null);
});
