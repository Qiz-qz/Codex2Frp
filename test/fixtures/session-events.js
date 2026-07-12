'use strict';

const SECRET_PROMPT = 'SECRET_SUBAGENT_PROMPT_CANARY';
const SECRET_BODY = 'SECRET_SUBAGENT_BODY_CANARY';
const SECRET_ARGUMENT = 'SECRET_TOOL_ARGUMENT_CANARY';
const SECRET_OUTPUT = 'SECRET_TOOL_OUTPUT_CANARY';
const RAW_AGENT_ID = '019f0000-raw-agent-thread-id';
const RAW_AGENT_PATH = '/root/private-secret-agent-path';
const SYNTHETIC_IMAGE_DIR = 'E:\\protocol-fixtures\\images';

function sessionItem(type, payload, timestamp = '2026-07-10T00:00:00.000Z') {
  return { type, payload, timestamp };
}

function responseMessage(role, phase, text, turnId = 'turn-main') {
  return sessionItem('response_item', {
    type: 'message',
    role,
    phase,
    content: [{ type: 'output_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

function subagentActivity(kind, overrides = {}) {
  return sessionItem('event_msg', {
    type: 'sub_agent_activity',
    event_id: `raw-event-${kind}`,
    occurred_at_ms: 1_752_105_600_000,
    agent_thread_id: RAW_AGENT_ID,
    agent_path: RAW_AGENT_PATH,
    kind,
    prompt: SECRET_PROMPT,
    body: SECRET_BODY,
    arguments: SECRET_ARGUMENT,
    output: SECRET_OUTPUT,
    ...overrides,
  });
}

function appServerItem(type, overrides = {}, timestamp = '2026-07-10T00:00:00.000Z') {
  return sessionItem('response_item', {
    id: `fixture-${type}`,
    type,
    ...overrides,
  }, timestamp);
}

function rpcItemNotification(method, type, turnId, overrides = {}, sequence = 1) {
  return {
    sequence,
    method,
    params: {
      threadId: 'fixture-main-thread',
      turnId,
      [method === 'item/started' ? 'startedAtMs' : 'completedAtMs']:
        method === 'item/started' ? 1_752_105_600_000 : 1_752_105_601_000,
      item: {
        id: `fixture-${type}`,
        type,
        ...overrides,
      },
    },
  };
}

function assertNoSecretCanaries(assert, value) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    SECRET_PROMPT,
    SECRET_BODY,
    SECRET_ARGUMENT,
    SECRET_OUTPUT,
    RAW_AGENT_ID,
    RAW_AGENT_PATH,
  ]) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  for (const forbiddenKey of ['prompt', 'body', 'arguments', 'output', 'agent_thread_id', 'agent_path']) {
    assert.equal(serialized.includes(`"${forbiddenKey}"`), false, `must not expose ${forbiddenKey}`);
  }
}

module.exports = {
  RAW_AGENT_ID,
  RAW_AGENT_PATH,
  SECRET_ARGUMENT,
  SECRET_BODY,
  SECRET_OUTPUT,
  SECRET_PROMPT,
  SYNTHETIC_IMAGE_DIR,
  appServerItem,
  assertNoSecretCanaries,
  responseMessage,
  rpcItemNotification,
  sessionItem,
  subagentActivity,
};
