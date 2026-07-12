'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GuardError,
  createProtectedThreadGuard,
} = require('../lib/control/protected-thread-guard');
const { CommandCoordinator } = require('../lib/control/command-coordinator');

const PROTECTED = '019f4840-00df-7ee0-88cb-e3dbcb1871dc';
const TEST_THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function expectGuardCode(error, code) {
  assert.equal(error instanceof GuardError, true);
  assert.equal(error.code, code);
  return true;
}

test('protected requested thread rejects mutation before transport or UI callbacks', async () => {
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED] });
  const coordinator = new CommandCoordinator({ guard });
  let transportCalls = 0;
  let uiCalls = 0;

  await assert.rejects(
    coordinator.run({ action: 'turn.start', mode: 'rpc', threadId: PROTECTED }, async () => {
      transportCalls += 1;
    }),
    error => expectGuardCode(error, 'PROTECTED_THREAD'),
  );
  await assert.rejects(
    coordinator.run({ action: 'composer.plus', mode: 'ui', threadId: PROTECTED }, async () => {
      uiCalls += 1;
    }),
    error => expectGuardCode(error, 'PROTECTED_THREAD'),
  );

  assert.equal(transportCalls, 0);
  assert.equal(uiCalls, 0);
});

test('UI action rejects when protected task is the observed desktop task', async () => {
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED] });
  const coordinator = new CommandCoordinator({ guard });
  let calls = 0;

  await assert.rejects(
    coordinator.run({
      action: 'thread.openDesktop',
      mode: 'ui',
      threadId: TEST_THREAD,
      desktopThreadId: PROTECTED,
    }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'PROTECTED_THREAD'),
  );

  assert.equal(calls, 0);
});

test('explicit control enable is allowlisted but remains blocked for protected desktop tasks', async () => {
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED] });
  const coordinator = new CommandCoordinator({ guard });
  let calls = 0;

  const result = await coordinator.run({
    action: 'control.enable',
    mode: 'ui',
    threadId: TEST_THREAD,
    desktopThreadId: TEST_THREAD,
  }, async () => {
    calls += 1;
    return 'enabled';
  });
  assert.equal(result, 'enabled');

  await assert.rejects(coordinator.run({
    action: 'control.enable',
    mode: 'ui',
    threadId: TEST_THREAD,
    desktopThreadId: PROTECTED,
  }, async () => {
    calls += 1;
  }), error => expectGuardCode(error, 'PROTECTED_THREAD'));
  assert.equal(calls, 1);
});

test('zero-focus RPC may target an allowlisted task while desktop shows a protected task', async () => {
  const guard = createProtectedThreadGuard({
    protectedThreadIds: [PROTECTED],
    allowedThreadIds: [TEST_THREAD],
    requireAllowlist: true,
  });
  const coordinator = new CommandCoordinator({ guard });
  let calls = 0;

  const result = await coordinator.run({
    action: 'turn.start',
    mode: 'rpc',
    threadId: TEST_THREAD,
    desktopThreadId: PROTECTED,
  }, async () => {
    calls += 1;
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('queue dispatch performs the same protected and allowlist gate as direct sends', async () => {
  const guard = createProtectedThreadGuard({
    protectedThreadIds: [PROTECTED],
    allowedThreadIds: [TEST_THREAD],
    requireAllowlist: true,
  });
  const coordinator = new CommandCoordinator({ guard });
  let calls = 0;

  await assert.rejects(
    coordinator.run({ action: 'queue.dispatch', mode: 'queue', threadId: PROTECTED }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'PROTECTED_THREAD'),
  );
  await assert.rejects(
    coordinator.run({ action: 'queue.dispatch', mode: 'queue', threadId: OTHER_THREAD }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'THREAD_NOT_ALLOWLISTED'),
  );
  const result = await coordinator.run({ action: 'queue.dispatch', mode: 'queue', threadId: TEST_THREAD }, async () => {
    calls += 1;
    return 'dispatched';
  });

  assert.equal(result, 'dispatched');
  assert.equal(calls, 1);
});

test('missing targets, mismatched active turns, and unknown actions fail closed', async () => {
  const guard = createProtectedThreadGuard();
  const coordinator = new CommandCoordinator({ guard });
  let calls = 0;

  await assert.rejects(
    coordinator.run({ action: 'turn.interrupt', mode: 'rpc', threadId: '' }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'TARGET_THREAD_REQUIRED'),
  );
  await assert.rejects(
    coordinator.run({
      action: 'turn.interrupt',
      mode: 'rpc',
      threadId: TEST_THREAD,
      observedThreadId: OTHER_THREAD,
      requireObservedTargetMatch: true,
    }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'THREAD_TARGET_MISMATCH'),
  );
  await assert.rejects(
    coordinator.run({ action: 'future.unknownMutation', mode: 'rpc', threadId: TEST_THREAD }, async () => {
      calls += 1;
    }),
    error => expectGuardCode(error, 'UNKNOWN_MUTATION_ACTION'),
  );

  assert.equal(calls, 0);
});

test('read operations remain available for protected tasks without entering mutation queue', async () => {
  const guard = createProtectedThreadGuard({ protectedThreadIds: [PROTECTED] });
  const coordinator = new CommandCoordinator({ guard });

  const result = await coordinator.run({ action: 'thread.read', mode: 'read', threadId: PROTECTED }, async () => 'snapshot');
  assert.equal(result, 'snapshot');
});

test('commands serialize per task while unrelated tasks can progress independently', async () => {
  const guard = createProtectedThreadGuard();
  const coordinator = new CommandCoordinator({ guard });
  const events = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = coordinator.run({ action: 'thread.rename', mode: 'rpc', threadId: TEST_THREAD }, async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
  });
  const second = coordinator.run({ action: 'thread.archive', mode: 'rpc', threadId: TEST_THREAD }, async () => {
    events.push('second-start');
    events.push('second-end');
  });
  const unrelated = coordinator.run({ action: 'thread.rename', mode: 'rpc', threadId: OTHER_THREAD }, async () => {
    events.push('other-start');
    events.push('other-end');
  });

  await unrelated;
  assert.deepEqual(events, ['first-start', 'other-start', 'other-end']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    'first-start',
    'other-start',
    'other-end',
    'first-end',
    'second-start',
    'second-end',
  ]);
});
