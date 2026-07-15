'use strict';

const STATUS_BY_KIND = new Map([
  ['started', 'running'],
  ['enabled', 'running'],
  ['running', 'running'],
  ['interacted', 'running'],
  ['completed', 'completed'],
  ['finished', 'completed'],
  ['closed', 'completed'],
  ['failed', 'failed'],
  ['errored', 'failed'],
  ['interrupted', 'interrupted'],
  ['stopped', 'interrupted'],
  ['cancelled', 'interrupted'],
  ['canceled', 'interrupted'],
]);

function createSubagentPrivacy() {
  const agents = new Map();
  let nextName = 1;

  function safeNameFor(payload = {}) {
    const explicit = String(payload.task_name || payload.taskName || payload.name || '').trim();
    const pathValue = String(payload.agent_path || payload.agentPath || '').trim();
    const pathSegment = pathValue.split(/[\\/]+/).filter(Boolean).pop() || '';
    const candidate = explicit || pathSegment;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) return candidate;
    return `子代理 ${nextName++}`;
  }

  function identityFor(payload = {}) {
    return String(
      payload.agent_thread_id ||
      payload.agentThreadId ||
      payload.agent_path ||
      payload.agentPath ||
      payload.event_id ||
      payload.eventId ||
      '',
    );
  }

  function aggregate() {
    const counts = { running: 0, completed: 0, failed: 0, interrupted: 0 };
    for (const agent of agents.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, agent.status)) counts[agent.status] += 1;
    }
    return counts;
  }

  function normalize(payload = {}) {
    const identity = identityFor(payload);
    if (!identity) return null;
    const kind = String(payload.kind || payload.activityKind || '').trim().toLowerCase();
    const existing = agents.get(identity);
    let status = STATUS_BY_KIND.get(kind) || '';
    if (!status) return null;
    if (existing && existing.status === status && kind !== 'interacted') return null;

    const agent = existing || { name: safeNameFor(payload), status: 'running' };
    agent.status = status;
    agents.set(identity, agent);
    return {
      name: agent.name,
      state: status,
    };
  }

  function snapshot() {
    return {
      agents: [...agents.values()].map(agent => ({ name: agent.name, status: agent.status })),
      aggregate: aggregate(),
    };
  }

  return {
    normalize,
    snapshot,
  };
}

module.exports = {
  createSubagentPrivacy,
};
