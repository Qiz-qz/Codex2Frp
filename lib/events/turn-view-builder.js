'use strict';

const { sanitizeDisplayText } = require('./display-text');
const { appendProjectedActivity } = require('./activity-projection');

function turnState(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'started' || state === 'running') return 'running';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'interrupted' || state === 'cancelled' || state === 'canceled') return 'cancelled';
  return 'unknown';
}

function activityKind(event) {
  const kind = String(event.summaryKind || '');
  if (['commentary', 'plan', 'reasoning', 'subagent'].includes(kind)) return kind;
  if (kind !== 'tool') return '';
  const toolKind = String(event.toolKind || '').toLowerCase();
  if (toolKind === 'command') return 'shell';
  if (toolKind === 'file') return 'file';
  if (['image', 'imageview', 'imagegeneration'].includes(toolKind)) return 'image';
  if (toolKind === 'search' || toolKind === 'web') return 'web';
  if (toolKind === 'mcp') return 'mcp';
  if (toolKind === 'approval') return 'approval';
  if (toolKind === 'userinput') return 'userInput';
  if (toolKind === 'review') return 'review';
  if (toolKind === 'compaction') return 'compaction';
  if (toolKind === 'sleep') return 'sleep';
  if (toolKind === 'diff') return 'diff';
  if (toolKind === 'notice') return 'notice';
  if (toolKind === 'unknown') return 'unknown';
  return 'dynamicTool';
}

function subagentProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').trim();
  const status = String(value.status || '');
  if (!name || !['enabled', 'closed', 'failed', 'interrupted'].includes(status)) return null;
  if (status === 'closed') return { name, action: 'disabled', state: 'completed' };
  if (status === 'failed') return { name, action: 'status', state: 'failed' };
  if (status === 'interrupted') return { name, action: 'status', state: 'interrupted' };
  return { name, action: 'enabled', state: 'running' };
}

function createTurn(threadId, id, user, index) {
  const turnId = String(id || `turn-${index + 1}`);
  return {
    turnId,
    threadId,
    state: 'running',
    ...(user ? { user } : {}),
    process: {
      schemaVersion: 3,
      turnId,
      state: 'running',
      summary: '处理过程',
      activities: [],
      detailActivities: [],
      detailCount: 0,
      counts: {},
    },
  };
}

function projectTurnActivity(process, activity) {
  appendProjectedActivity(process, activity);
  process.detailCount = process.detailActivities.length;
  return process;
}

function finalizeProcess(process, state) {
  process.state = state;
  process.activities = process.activities.filter(item => item.kind !== 'reasoning');
  process.detailActivities = process.detailActivities.filter(item => item.kind !== 'reasoning');
  process.detailCount = process.detailActivities.length;
  return process;
}

function removeMatchingCommentary(process, id) {
  if (!id) return process;
  const remaining = process.detailActivities.filter(item => !(item.kind === 'commentary' && item.id === id));
  if (remaining.length === process.detailActivities.length) return process;
  process.activities = [];
  process.detailActivities = [];
  process.detailCount = 0;
  process.counts = {};
  for (const activity of remaining) {
    appendProjectedActivity(process, activity);
    process.counts[activity.kind] = Number(process.counts[activity.kind] || 0) + 1;
  }
  process.detailCount = process.detailActivities.length;
  return process;
}

function userMessage(event, threadId) {
  return {
    role: 'user',
    label: '你',
    text: sanitizeDisplayText(event.text),
    time: event.time || '',
    threadId,
  };
}

function finalMessage(event, threadId) {
  return {
    role: 'assistant',
    label: 'Codex',
    text: sanitizeDisplayText(event.text),
    time: event.time || '',
    threadId,
  };
}

function buildTurnViews(events, threadId = '') {
  const turns = [];
  let current = null;
  let pendingUser = null;

  function ensureCurrent(id = '') {
    if (!current) {
      current = createTurn(threadId, id, pendingUser, turns.length);
      pendingUser = null;
      turns.push(current);
    }
    return current;
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'message' && event.role === 'user') {
      const message = userMessage(event, threadId);
      if (!message.text) continue;
      if (event.delivery === 'steer' && current) continue;
      if (current && current.state === 'running' && !current.final) {
        current.state = 'completed';
        finalizeProcess(current.process, 'completed');
      }
      current = null;
      pendingUser = message;
      continue;
    }
    if (event.type === 'turn') {
      const state = turnState(event.state);
      if (state === 'running') {
        if (current && current.turnId !== String(event.turnId || '') && !current.final) {
          current.state = 'completed';
          finalizeProcess(current.process, 'completed');
        }
        if (!current || current.turnId !== String(event.turnId || '')) current = null;
        const turn = ensureCurrent(event.turnId);
        turn.state = 'running';
        turn.process.state = 'running';
      } else {
        const turn = ensureCurrent(event.turnId);
        turn.state = state;
        finalizeProcess(turn.process, state);
        current = null;
      }
      continue;
    }
    if (event.type === 'summary') {
      const kind = activityKind(event);
      if (!kind) continue;
      const turn = ensureCurrent(event.turnId);
      const activity = {
        id: String(event.id || `${turn.turnId}-activity-${turn.process.detailActivities.length + 1}`),
        kind,
        state: String(event.state || 'succeeded'),
        title: sanitizeDisplayText(event.text) || '活动',
      };
      if (kind === 'image') {
        activity.variant = String(event.toolKind || '').toLowerCase() === 'imagegeneration'
          ? 'imageGeneration'
          : 'imageView';
      }
      if (kind === 'subagent') {
        const subagent = subagentProjection(event.subagent);
        if (!subagent) continue;
        activity.subagent = subagent;
        activity.title = `${subagent.name} ${event.subagent.status}`;
      } else {
        for (const field of ['operation', 'server', 'tool', 'namespace']) {
          if (typeof event[field] === 'string') activity[field] = event[field];
        }
        if (Number.isFinite(event.durationMs)) activity.durationMs = event.durationMs;
        if (Number.isInteger(event.exitCode)) activity.exitCode = event.exitCode;
        if (typeof event.background === 'boolean') activity.background = event.background;
      }
      if (Number.isFinite(event.count)) activity.count = Math.max(0, Number(event.count));
      for (const field of ['stepCounts', 'fileCounts']) {
        if (event[field] && typeof event[field] === 'object') activity[field] = { ...event[field] };
      }
      for (const field of ['hasExplanation', 'fatal', 'willRetry']) {
        if (typeof event[field] === 'boolean') activity[field] = event[field];
      }
      for (const field of ['noticeKind', 'publicType']) {
        if (typeof event[field] === 'string') activity[field] = event[field];
      }
      if (Array.isArray(event.attachments) && event.attachments.length > 0) {
        activity.attachments = event.attachments.map(attachment => ({ ...attachment }));
      }
      projectTurnActivity(turn.process, activity);
      turn.process.counts[kind] = Number(turn.process.counts[kind] || 0) + 1;
      continue;
    }
    if (event.type === 'message' && event.role === 'assistant' && event.phase === 'final_answer') {
      const message = finalMessage(event, threadId);
      if (!message.text) continue;
      const turn = ensureCurrent(event.turnId);
      turn.final = message;
      removeMatchingCommentary(turn.process, String(event.id || ''));
    }
  }

  if (pendingUser) turns.push(createTurn(threadId, '', pendingUser, turns.length));
  return turns;
}

module.exports = {
  buildTurnViews,
};
