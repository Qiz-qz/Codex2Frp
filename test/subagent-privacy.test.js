'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RAW_AGENT_ID,
  SECRET_BODY,
  assertNoSecretCanaries,
  subagentActivity,
} = require('./fixtures/session-events');

function createPrivacy(options) {
  const { createSubagentPrivacy } = require('../lib/events/subagent-privacy');
  return createSubagentPrivacy(options);
}

test('uses only the sanitized task-name segment and exposes enabled lifecycle state', () => {
  const privacy = createPrivacy();
  const result = privacy.normalize(subagentActivity('started').payload);

  assert.deepEqual(result, {
    name: 'private-secret-agent-path',
    status: 'enabled',
    change: 'enabled',
    aggregate: {
      enabled: 1,
      closed: 0,
      failed: 0,
      interrupted: 0,
    },
  });
  assertNoSecretCanaries(assert, result);
});

test('tracks closed, failed, and interrupted states without exposing raw identity', () => {
  const privacy = createPrivacy();
  privacy.normalize(subagentActivity('started').payload);
  const closed = privacy.normalize(subagentActivity('closed').payload);

  const failedPayload = subagentActivity('failed', {
    agent_thread_id: `${RAW_AGENT_ID}-failed`,
    agent_path: '/root/private-failed',
    body: SECRET_BODY,
  }).payload;
  const failed = privacy.normalize(failedPayload);
  const interrupted = privacy.normalize(subagentActivity('interrupted', {
    agent_thread_id: `${RAW_AGENT_ID}-interrupted`,
    agent_path: '/root/private-interrupted',
  }).payload);

  assert.equal(closed.name, 'private-secret-agent-path');
  assert.equal(closed.status, 'closed');
  assert.equal(failed.name, 'private-failed');
  assert.equal(failed.status, 'failed');
  assert.equal(interrupted.name, 'private-interrupted');
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.aggregate, {
    enabled: 0,
    closed: 1,
    failed: 1,
    interrupted: 1,
  });
  assertNoSecretCanaries(assert, [closed, failed, interrupted]);
});

test('drops repeated interaction noise and unknown lifecycle kinds', () => {
  const privacy = createPrivacy();
  privacy.normalize(subagentActivity('started').payload);

  assert.equal(privacy.normalize(subagentActivity('interacted').payload), null);
  assert.equal(privacy.normalize(subagentActivity('future-secret-kind').payload), null);
  assertNoSecretCanaries(assert, privacy.snapshot());
});

test('never turns interaction-only noise into a user-visible lifecycle transition', () => {
  const privacy = createPrivacy();
  const result = privacy.normalize(subagentActivity('interacted').payload);

  assert.equal(result, null);
  assert.deepEqual(privacy.snapshot(), {
    agents: [],
    aggregate: { enabled: 0, closed: 0, failed: 0, interrupted: 0 },
  });
});
