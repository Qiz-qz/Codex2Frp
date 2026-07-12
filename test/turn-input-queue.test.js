'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueueStore } = require('../lib/queue/queue-store');
const {
  QueueError,
  TurnInputQueue,
  TurnInputRouter,
} = require('../lib/queue/turn-input-queue');

const THREAD = '11111111-2222-4333-8444-555555555555';
const TURN = 'turn-active-1';

function createQueue(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  let sequence = 0;
  const queue = new TurnInputQueue({
    store: new QueueStore({ file }),
    now: () => new Date(1_750_000_000_000 + sequence * 1000),
    createId: () => `queue-${++sequence}`,
  });
  return { queue, file };
}

function expectQueueCode(error, code) {
  assert.equal(error instanceof QueueError, true);
  assert.equal(error.code, code);
  return true;
}

test('enqueue persists before acknowledgement and survives a new queue instance', (t) => {
  const { queue, file } = createQueue(t);
  const item = queue.enqueue({
    threadId: THREAD,
    clientRequestId: 'request-1',
    text: 'run after the current turn',
    attachments: [{ id: 'attachment-1', name: 'image.png' }],
  });

  assert.equal(item.state, 'queued');
  assert.equal(item.position, 1);
  assert.equal(fs.existsSync(file), true);
  const restored = new TurnInputQueue({ store: new QueueStore({ file }) });
  assert.deepEqual(restored.list(THREAD).map(entry => entry.id), [item.id]);
  assert.equal(restored.list(THREAD)[0].text, 'run after the current turn');
});

test('enqueue is idempotent for the same body and rejects conflicting reuse', (t) => {
  const { queue } = createQueue(t);
  const first = queue.enqueue({ threadId: THREAD, clientRequestId: 'same-id', text: 'first' });
  const repeated = queue.enqueue({ threadId: THREAD, clientRequestId: 'same-id', text: 'first' });
  assert.equal(repeated.id, first.id);

  assert.throws(
    () => queue.enqueue({ threadId: THREAD, clientRequestId: 'same-id', text: 'different' }),
    error => expectQueueCode(error, 'IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(queue.list(THREAD).length, 1);
});

test('dispatch waits for idle and sends queued items in FIFO order exactly once', async (t) => {
  const { queue } = createQueue(t);
  const first = queue.enqueue({ threadId: THREAD, clientRequestId: 'r1', text: 'first' });
  const second = queue.enqueue({ threadId: THREAD, clientRequestId: 'r2', text: 'second' });
  const calls = [];

  assert.equal(await queue.dispatchNext(THREAD, { threadStatus: 'active', startTurn: async () => {} }), null);
  assert.equal(await queue.dispatchNext(THREAD, { threadStatus: 'completed', startTurn: async () => {} }), null);
  const accepted = await queue.dispatchNext(THREAD, {
    threadStatus: 'idle',
    startTurn: async item => {
      calls.push(item.id);
      return { turnId: 'turn-next-1' };
    },
  });

  assert.equal(accepted.id, first.id);
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.turnId, 'turn-next-1');
  assert.deepEqual(calls, [first.id]);
  assert.equal(queue.list(THREAD).find(item => item.id === second.id).position, 1);

  await queue.dispatchNext(THREAD, {
    threadStatus: 'idle',
    startTurn: async item => {
      calls.push(item.id);
      return { turnId: 'turn-next-2' };
    },
  });
  assert.deepEqual(calls, [first.id, second.id]);
});

test('uncertain dispatch becomes needs_reconcile and is never blindly retried', async (t) => {
  const { queue } = createQueue(t);
  const item = queue.enqueue({ threadId: THREAD, clientRequestId: 'uncertain', text: 'maybe sent' });
  const error = new Error('connection closed after write');
  error.uncertain = true;

  await assert.rejects(queue.dispatchNext(THREAD, {
    threadStatus: 'idle',
    startTurn: async () => { throw error; },
  }), /connection closed/);
  assert.equal(queue.get(item.id).state, 'needs_reconcile');

  let calls = 0;
  assert.equal(await queue.dispatchNext(THREAD, {
    threadStatus: 'idle',
    startTurn: async () => { calls += 1; },
  }), null);
  assert.equal(calls, 0);
});

test('restart converts an interrupted dispatching write into needs_reconcile', (t) => {
  const { queue, file } = createQueue(t);
  const item = queue.enqueue({ threadId: THREAD, clientRequestId: 'crash', text: 'crash window' });
  queue._setStateForTest(item.id, 'dispatching');

  const restored = new TurnInputQueue({ store: new QueueStore({ file }) });
  assert.equal(restored.get(item.id).state, 'needs_reconcile');
});

test('reconcile accepts only matching delivery evidence and never blindly replays uncertain input', (t) => {
  const { queue } = createQueue(t);
  const item = queue.enqueue({
    threadId: THREAD,
    clientRequestId: 'reconcile-accepted',
    text: 'possibly delivered',
  });
  queue._setStateForTest(item.id, 'needs_reconcile');

  assert.throws(() => queue.reconcile(item.id, {
    outcome: 'accepted',
    clientUserMessageId: 'different-request',
    turnId: 'turn-confirmed',
  }), error => expectQueueCode(error, 'RECONCILE_EVIDENCE_MISMATCH'));
  assert.equal(queue.get(item.id).state, 'needs_reconcile');

  const accepted = queue.reconcile(item.id, {
    outcome: 'accepted',
    clientUserMessageId: 'reconcile-accepted',
    turnId: 'turn-confirmed',
  });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.turnId, 'turn-confirmed');
  assert.equal(queue.list(THREAD).length, 0);
});

test('negative reconciliation evidence moves input to failed and still requires explicit retry', (t) => {
  const { queue } = createQueue(t);
  const item = queue.enqueue({
    threadId: THREAD,
    clientRequestId: 'reconcile-not-accepted',
    text: 'not delivered',
  });
  queue._setStateForTest(item.id, 'needs_reconcile');

  assert.throws(
    () => queue.reconcile(item.id, { outcome: 'unknown' }),
    error => expectQueueCode(error, 'RECONCILE_EVIDENCE_REQUIRED'),
  );
  assert.equal(queue.get(item.id).state, 'needs_reconcile');

  const failed = queue.reconcile(item.id, { outcome: 'notAccepted' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.lastError.code, 'DELIVERY_NOT_ACCEPTED');
  const retried = queue.retry(item.id, { revision: failed.revision });
  assert.equal(retried.state, 'queued');
});

test('edit and reorder use optimistic revisions while cancel prevents dispatch', async (t) => {
  const { queue } = createQueue(t);
  const first = queue.enqueue({ threadId: THREAD, clientRequestId: 'edit-1', text: 'one' });
  const second = queue.enqueue({ threadId: THREAD, clientRequestId: 'edit-2', text: 'two' });

  const edited = queue.edit(first.id, { revision: first.revision, text: 'one edited' });
  assert.equal(edited.text, 'one edited');
  assert.equal(edited.revision, first.revision + 1);
  assert.throws(
    () => queue.edit(first.id, { revision: first.revision, text: 'stale write' }),
    error => expectQueueCode(error, 'REVISION_CONFLICT'),
  );

  queue.reorder(THREAD, [second.id, first.id]);
  assert.deepEqual(queue.list(THREAD).map(item => item.id), [second.id, first.id]);
  queue.cancel(second.id, { revision: queue.get(second.id).revision });

  let dispatched;
  await queue.dispatchNext(THREAD, {
    threadStatus: 'idle',
    startTurn: async item => {
      dispatched = item;
      return { turnId: 'next' };
    },
  });
  assert.equal(dispatched.id, first.id);
  assert.equal(queue.get(second.id).state, 'cancelled');
});

test('steer uses exact active turn precondition and never silently becomes a new turn', async (t) => {
  const { queue } = createQueue(t);
  const calls = [];
  const router = new TurnInputRouter({
    queue,
    getActiveTurn: async threadId => ({ threadId, turnId: TURN, status: 'active', steerable: true }),
    steer: async request => {
      calls.push(request);
      return { turnId: request.expectedTurnId };
    },
  });

  const result = await router.deliver({
    mode: 'steer-current',
    threadId: THREAD,
    expectedTurnId: TURN,
    clientRequestId: 'steer-1',
    text: 'additional guidance',
  });
  assert.equal(result.state, 'applied');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedTurnId, TURN);

  await assert.rejects(router.deliver({
    mode: 'steer-current',
    threadId: THREAD,
    expectedTurnId: 'stale-turn',
    clientRequestId: 'steer-2',
    text: 'must not be rerouted',
  }), error => expectQueueCode(error, 'TURN_MISMATCH'));
  assert.equal(calls.length, 1);
  assert.equal(queue.list(THREAD).length, 0);
});

test('non-steerable active turn returns a queue suggestion without changing delivery mode', async (t) => {
  const { queue } = createQueue(t);
  const router = new TurnInputRouter({
    queue,
    getActiveTurn: async () => ({ threadId: THREAD, turnId: TURN, status: 'active', steerable: false }),
    steer: async () => { throw new Error('should not run'); },
  });

  await assert.rejects(router.deliver({
    mode: 'steer-current',
    threadId: THREAD,
    expectedTurnId: TURN,
    clientRequestId: 'steer-3',
    text: 'review cannot steer',
  }), error => {
    expectQueueCode(error, 'ACTIVE_TURN_NOT_STEERABLE');
    assert.equal(error.details.suggestedMode, 'enqueue-next-turn');
    return true;
  });
  assert.equal(queue.list(THREAD).length, 0);
});

test('queued input converts to steer through one persisted transaction and leaves the queue', async (t) => {
  const { queue } = createQueue(t);
  const item = queue.enqueue({ threadId: THREAD, clientRequestId: 'convert-1', text: 'apply now' });
  const calls = [];
  const converted = await queue.convertToSteer(item.id, {
    revision: item.revision,
    expectedTurnId: TURN,
    steer: async queued => {
      calls.push({ state: queue.get(queued.id).state, expectedTurnId: TURN, text: queued.text });
      return { turnId: TURN };
    },
  });
  assert.deepEqual(calls, [{ state: 'dispatching', expectedTurnId: TURN, text: 'apply now' }]);
  assert.equal(converted.state, 'cancelled');
  assert.equal(converted.turnId, TURN);
  assert.deepEqual(queue.list(THREAD), []);
});

test('uncertain steer conversion becomes needs_reconcile instead of remaining queued', async (t) => {
  const { queue } = createQueue(t);
  const item = queue.enqueue({ threadId: THREAD, clientRequestId: 'convert-uncertain', text: 'maybe now' });
  const error = new Error('connection closed');
  error.uncertain = true;
  await assert.rejects(queue.convertToSteer(item.id, {
    revision: item.revision,
    expectedTurnId: TURN,
    steer: async () => { throw error; },
  }), /connection closed/);
  assert.equal(queue.get(item.id).state, 'needs_reconcile');
});
