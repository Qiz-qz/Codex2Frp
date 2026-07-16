'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCdpBoundThreadNavigator,
} = require('../lib/control/cdp-bound-thread-navigation');

const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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
  const navigate = createCdpBoundThreadNavigator({
    activateViaCdp: async () => ({
      ok: false,
      code: 'CODEX_THREAD_ROW_NOT_FOUND',
      observedThreadId: '',
    }),
  });

  await assert.rejects(navigate(THREAD), error => {
    assert.equal(error.code, 'CODEX_THREAD_ROW_NOT_FOUND');
    assert.equal(error.statusCode, 409);
    return true;
  });
});
