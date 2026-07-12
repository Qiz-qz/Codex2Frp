'use strict';

const DURABLE = new Set([
  'shell', 'file', 'image', 'web', 'mcp', 'dynamicTool', 'commentary', 'plan',
]);
const INTERACTIVE = new Set(['approval', 'userInput', 'review', 'subagent']);

function activityKey(activity) {
  return `${activity.kind}:${activity.variant || ''}`;
}

function contribution(activity) {
  return Number.isFinite(activity.count) ? Math.max(1, Math.floor(activity.count)) : 1;
}

function aggregateTitle(activity) {
  const count = Math.max(1, activity.count || 1);
  let title;
  if (activity.kind === 'shell') title = `已运行 ${count} 条命令`;
  else if (activity.kind === 'file') title = `已修改 ${count} 个文件`;
  else if (activity.kind === 'web') title = `已完成 ${count} 次网页搜索`;
  else if (activity.kind === 'mcp') title = `已完成 ${count} 次 MCP 调用`;
  else if (activity.kind === 'dynamicTool') title = `已调用 ${count} 次工具`;
  else if (activity.kind === 'commentary') title = `已更新 ${count} 条进度`;
  else if (activity.kind === 'plan') title = `已更新 ${count} 次计划`;
  else if (activity.kind === 'image' && activity.variant === 'imageGeneration') {
    title = `已生成 ${count} 张图像`;
  } else if (activity.kind === 'image') title = count === 1 ? '已查看一张图像' : `已查看 ${count} 张图像`;
  else title = activity.title || `已完成 ${count} 项操作`;
  if (activity.failedCount > 0) title += ` · ${activity.failedCount} 条失败`;
  if (activity.cancelledCount > 0) title += ` · ${activity.cancelledCount} 条已取消`;
  return title;
}

function safeAttachmentUrl(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source || source.length > 4096) return '';
  try {
    const relative = source.startsWith('/');
    const parsed = new URL(source, 'https://capability.invalid');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    const capability = /^\/codex\/attachment\/[A-Za-z0-9_-]{1,128}$/.test(parsed.pathname);
    if (relative) return capability && source === parsed.pathname ? source : '';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && capability)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function safeAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  const safe = {};
  for (const field of ['name', 'mime', 'mimeType']) {
    if (typeof item[field] === 'string' && item[field].trim()) {
      safe[field] = item[field].trim().slice(0, 256);
    }
  }
  for (const field of ['size', 'count']) {
    if (Number.isFinite(item[field]) && item[field] >= 0) safe[field] = Math.floor(item[field]);
  }
  for (const field of ['url', 'thumbnailUrl']) {
    const url = safeAttachmentUrl(item[field]);
    if (url) safe[field] = url;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function mergeSafeImageAttachments(target, incoming) {
  const merged = Array.isArray(target) ? target : [];
  const seen = new Set(merged.map(item => `${item.url || ''}\n${item.name || ''}`));
  for (const item of incoming || []) {
    const safe = safeAttachment(item);
    if (!safe) continue;
    const key = `${safe.url || ''}\n${safe.name || ''}`;
    if (!seen.has(key)) {
      merged.push(safe);
      seen.add(key);
    }
  }
  return merged;
}

function safeActivity(activity) {
  const result = {};
  for (const field of ['id', 'kind', 'variant', 'state', 'title']) {
    if (typeof activity[field] === 'string') result[field] = activity[field];
  }
  if (activity.kind !== 'subagent') {
    for (const field of ['operation', 'server', 'tool', 'namespace']) {
      const value = typeof activity[field] === 'string' ? activity[field].trim() : '';
      if (/^[A-Za-z0-9_.:/-]{1,64}$/.test(value) && !value.includes(':/')) result[field] = value;
    }
    if (Number.isFinite(activity.durationMs) && activity.durationMs >= 0) result.durationMs = Math.floor(activity.durationMs);
    if (Number.isInteger(activity.exitCode)) result.exitCode = activity.exitCode;
    if (typeof activity.background === 'boolean') result.background = activity.background;
  }
  if (Number.isFinite(activity.count)) result.count = activity.count;
  const copyCounts = (field, keys) => {
    if (!activity[field] || typeof activity[field] !== 'object') return;
    const counts = {};
    for (const key of keys) {
      const value = activity[field][key];
      counts[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }
    result[field] = counts;
  };
  copyCounts('stepCounts', ['pending', 'inProgress', 'completed']);
  copyCounts('fileCounts', ['total', 'added', 'deleted', 'modified']);
  if (typeof activity.hasExplanation === 'boolean') result.hasExplanation = activity.hasExplanation;
  if (['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(activity.noticeKind)) {
    result.noticeKind = activity.noticeKind;
  }
  if (typeof activity.fatal === 'boolean') result.fatal = activity.fatal;
  if (typeof activity.willRetry === 'boolean') result.willRetry = activity.willRetry;
  if (typeof activity.publicType === 'string' && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(activity.publicType)) {
    result.publicType = activity.publicType;
  }
  if (activity.subagent && typeof activity.subagent === 'object') {
    const subagent = {};
    for (const field of ['name', 'action', 'state']) {
      if (typeof activity.subagent[field] === 'string') subagent[field] = activity.subagent[field];
    }
    if (Object.keys(subagent).length > 0) result.subagent = subagent;
  }
  if (Array.isArray(activity.attachments)) {
    result.attachments = mergeSafeImageAttachments([], activity.attachments);
  }
  return result;
}

function appendProjectedActivity(process, activity) {
  process.detailActivities ||= [];
  process.activities ||= [];
  process.counts ||= {};
  const projected = safeActivity(activity);

  if (projected.kind === 'reasoning') {
    process.activities = process.activities.filter(item => item.kind !== 'reasoning');
    process.detailActivities = process.detailActivities.filter(item => item.kind !== 'reasoning');
    process.activities.push({ ...projected, id: `${process.turnId || 'turn'}-reasoning` });
    process.detailActivities.push({ ...projected, id: `${process.turnId || 'turn'}-reasoning-detail` });
    process.detailCount = process.detailActivities.length;
    return;
  }

  process.detailActivities.push({ ...projected });
  process.detailCount = process.detailActivities.length;
  if (!DURABLE.has(projected.kind) || INTERACTIVE.has(projected.kind)) {
    process.activities.push({ ...projected });
    return;
  }

  const key = activityKey(projected);
  let summary = key === 'image:imageView'
    ? process.activities[process.activities.length - 1]
    : process.activities.find(item => item.aggregateKey === key);
  if (key === 'image:imageView' && (!summary || summary.aggregateKey !== key)) summary = null;
  if (!summary) {
    const segment = process.activities.filter(item => item.aggregateKey === key).length + 1;
    summary = {
      ...projected,
      id: `${process.turnId || 'turn'}-summary-${key.replace(/:$/, '')}${key === 'image:imageView' ? `-${segment}` : ''}`,
      aggregateKey: key,
      count: 0,
      failedCount: 0,
      cancelledCount: 0,
      ...(Array.isArray(projected.attachments) ? { attachments: [] } : {}),
    };
    process.activities.push(summary);
  }
  summary.count += contribution(projected);
  if (projected.state === 'failed') summary.failedCount += contribution(projected);
  if (projected.state === 'cancelled') summary.cancelledCount += contribution(projected);
  summary.state = projected.state === 'running'
    ? 'running'
    : summary.failedCount > 0 ? 'failed' : 'succeeded';
  if (Array.isArray(projected.attachments)) {
    summary.attachments = mergeSafeImageAttachments(summary.attachments, projected.attachments);
  }
  summary.title = aggregateTitle(summary);
}

module.exports = {
  appendProjectedActivity,
};
