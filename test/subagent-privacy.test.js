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

test('online lifecycle DTO contains only safe subagent name and state', () => {
  const privacy = createPrivacy();
  const result = privacy.normalize(subagentActivity('started').payload);

  assert.deepEqual(result, {
    name: 'private-secret-agent-path',
    state: 'running',
  });
});

test('uses only the sanitized task-name segment and exposes running lifecycle state', () => {
  const privacy = createPrivacy();
  const result = privacy.normalize(subagentActivity('started').payload);

  assert.deepEqual(result, {
    name: 'private-secret-agent-path',
    state: 'running',
  });
  assertNoSecretCanaries(assert, result);
});

test('tracks completed, failed, and interrupted states without exposing raw identity', () => {
  const privacy = createPrivacy();
  privacy.normalize(subagentActivity('started').payload);
  const completed = privacy.normalize(subagentActivity('closed').payload);

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

  assert.equal(completed.name, 'private-secret-agent-path');
  assert.equal(completed.state, 'completed');
  assert.equal(failed.name, 'private-failed');
  assert.equal(failed.state, 'failed');
  assert.equal(interrupted.name, 'private-interrupted');
  assert.equal(interrupted.state, 'interrupted');
  assert.deepEqual(completed, { name: 'private-secret-agent-path', state: 'completed' });
  assert.deepEqual(failed, { name: 'private-failed', state: 'failed' });
  assert.deepEqual(interrupted, { name: 'private-interrupted', state: 'interrupted' });
  assertNoSecretCanaries(assert, [completed, failed, interrupted]);
});

test('publishes every real interaction as a privacy-safe running update', () => {
  const privacy = createPrivacy();
  privacy.normalize(subagentActivity('started').payload);

  assert.deepEqual(privacy.normalize(subagentActivity('interacted').payload), {
    name: 'private-secret-agent-path',
    state: 'running',
  });
  assert.deepEqual(privacy.normalize(subagentActivity('interacted').payload), {
    name: 'private-secret-agent-path',
    state: 'running',
  });
  assert.equal(privacy.normalize(subagentActivity('future-secret-kind').payload), null);
  assertNoSecretCanaries(assert, privacy.snapshot());
});

test('interaction-only activity creates one safe running lifecycle without content', () => {
  const privacy = createPrivacy();
  const result = privacy.normalize(subagentActivity('interacted').payload);

  assert.deepEqual(result, {
    name: 'private-secret-agent-path',
    state: 'running',
  });
  assert.deepEqual(privacy.snapshot(), {
    agents: [{ name: 'private-secret-agent-path', status: 'running' }],
    aggregate: { running: 1, completed: 0, failed: 0, interrupted: 0 },
  });
  assertNoSecretCanaries(assert, result);
});
