'use strict';

const STATES = Object.freeze({ inProgress: 'running', completed: 'succeeded', failed: 'failed', declined: 'cancelled' });
const DIRECT_KINDS = Object.freeze({
  fileChange: 'file', webSearch: 'web', mcpToolCall: 'mcp', dynamicToolCall: 'dynamicTool',
  collabAgentToolCall: 'subagent', subAgentActivity: 'subagent', imageView: 'imageView',
  imageGeneration: 'imageGeneration', sleep: 'sleep', enteredReviewMode: 'review',
  exitedReviewMode: 'review', contextCompaction: 'compaction',
});

function safePublicType(value) {
  const type = typeof value === 'string' ? value : '';
  return type.length <= 128 && /^[A-Za-z][A-Za-z0-9_.:/-]*$/.test(type) ? type : 'unknown';
}

function classifyDesktopActivity(item = {}) {
  const type = String(item.type || '');
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const kind = type === 'commandExecution'
    ? actions.some(action => action && ['read', 'listFiles', 'search'].includes(action.type)) ? 'file' : 'shell'
    : DIRECT_KINDS[type];
  if (!kind) return null;
  return { id: String(item.id || `${type}:unknown`), kind, state: STATES[String(item.status || '')] || 'unknown' };
}

function countDesktopActivities(items = []) {
  const latest = new Map();
  for (const item of items) {
    const activity = classifyDesktopActivity(item);
    if (activity) latest.set(activity.id, activity);
  }
  const counts = {};
  for (const activity of latest.values()) counts[activity.kind] = Number(counts[activity.kind] || 0) + 1;
  return counts;
}

module.exports = { classifyDesktopActivity, countDesktopActivities, safePublicType };
