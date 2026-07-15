'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertExactThreadBeforeSideEffect } = require('../lib/control/thread-side-effect-guard');

const TARGET = '7c10b7de-0d0e-4d94-8f4e-1a2b3c4d5e6f';
const OTHER = 'f821f7ba-d64f-4cc4-b9c0-6e7d8c9b0a1f';

test('side-effect guard accepts only exact observed task identity', async () => {
  const result = await assertExactThreadBeforeSideEffect({
    threadId: TARGET,
    observe: async () => ({ threadId: TARGET, confidence: 'exact' }),
    action: 'control.model',
  });
  assert.equal(result.threadId, TARGET);
});

test('side-effect guard fails closed when the desktop task changed after activation', async () => {
  await assert.rejects(
    assertExactThreadBeforeSideEffect({
      threadId: TARGET,
      observe: async () => ({ threadId: OTHER, confidence: 'exact' }),
      action: 'control.reasoning',
    }),
    error => error.code === 'CODEX_THREAD_CHANGED_BEFORE_SIDE_EFFECT'
      && error.statusCode === 409
      && error.details.expectedThreadId === TARGET
      && error.details.observedThreadId === OTHER,
  );
});

test('side-effect guard rejects missing or non-exact desktop evidence', async () => {
  for (const evidence of [null, { threadId: '' }, { threadId: TARGET, confidence: 'heuristic' }]) {
    await assert.rejects(
      assertExactThreadBeforeSideEffect({
        threadId: TARGET,
        observe: async () => evidence,
        action: 'control.serviceTier',
      }),
      error => error.code === 'CODEX_THREAD_UNVERIFIED_BEFORE_SIDE_EFFECT' && error.statusCode === 409,
    );
  }
});
