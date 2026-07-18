'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCdpBoundThreadNavigator,
} = require('../lib/control/cdp-bound-thread-navigation');

const THREAD = '019f6596-e104-7d62-a0c7-e858f187c9f5';

test('bound thread navigation reports an exact CDP selection without using a system deep link', async () => {
  const calls = [];
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async threadId => {
      calls.push(threadId);
      return { ok: true, threadId };
    },
  });

  assert.deepEqual(await navigate(THREAD), {
    method: 'cdp-bound-thread',
    confirmedThreadId: THREAD,
  });
  assert.deepEqual(calls, [THREAD]);
});

test('bound thread navigation fails closed when exact CDP selection cannot be confirmed', async () => {
  let deepLinks = 0;
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async () => ({
      ok: false,
      code: 'CODEX_THREAD_ROW_NOT_FOUND',
      observedThreadId: '',
    }),
    navigateViaDeepLink: async () => { deepLinks += 1; },
  });

  await assert.rejects(navigate(THREAD), error => {
    assert.equal(error.code, 'CODEX_THREAD_ROW_NOT_FOUND');
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(deepLinks, 0, 'an available CDP target that cannot confirm the task must not downgrade to a deep link');
});

test('bound thread navigation safely falls back to the native deep link only when CDP is unavailable', async () => {
  const calls = [];
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async threadId => {
      calls.push(['cdp', threadId]);
      throw Object.assign(new Error('control port is not enabled'), { code: 'CODEX_CDP_REQUIRED' });
    },
    navigateViaDeepLink: async threadId => {
      calls.push(['deep-link', threadId]);
      return {
        method: 'codex-deep-link',
        confirmedThreadId: threadId,
        route: `codex://threads/${threadId}`,
      };
    },
  });

  assert.deepEqual(await navigate(THREAD), {
    method: 'codex-deep-link',
    confirmedThreadId: THREAD,
    route: `codex://threads/${THREAD}`,
  });
  assert.deepEqual(calls, [['cdp', THREAD], ['deep-link', THREAD]]);
});

test('bound thread navigation does not mask non-CDP action failures with a deep link', async () => {
  let deepLinks = 0;
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async () => {
      throw Object.assign(new Error('renderer action failed'), { code: 'CODEX_APP_ACTION_FAILED' });
    },
    navigateViaDeepLink: async () => { deepLinks += 1; },
  });

  await assert.rejects(navigate(THREAD), error => error.code === 'CODEX_APP_ACTION_FAILED');
  assert.equal(deepLinks, 0);
});
