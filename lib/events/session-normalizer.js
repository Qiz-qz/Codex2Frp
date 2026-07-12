'use strict';

const path = require('node:path');
const { sanitizeAssistantDisplayText, sanitizeDisplayText } = require('./display-text');
const { createSubagentPrivacy } = require('./subagent-privacy');
const { parseUserMessageEnvelope } = require('./user-message-envelope');
const { classifyDesktopActivity, safePublicType } = require('./desktop-activity-classifier');
const {
  classifyUserDelivery,
  createTurnState,
  reduceTurnEvent,
} = require('./turn-reducer');

const COLLABORATION_CALLS = new Set([
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'spawn_agent',
  'wait_agent',
  'collabagenttoolcall',
]);

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif)(?:[?#].*)?$/i;

function parseToolArguments(payload = {}) {
  const value = payload.arguments ?? payload.input ?? {};
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedImageSource(value, cwd = '') {
  const source = String(value || '').trim();
  if (!source || (!IMAGE_EXTENSION.test(source) && !/^data:image\//i.test(source))) return '';
  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source) || path.isAbsolute(source)) return source;
  return cwd ? path.resolve(cwd, source) : '';
}

function imageAttachment(sourceValue, cwd = '') {
  const source = normalizedImageSource(sourceValue, cwd);
  if (!source) return null;
  if (/^data:image\//i.test(source)) {
    // Do not retain large base64 output inside the long-lived event feed.
    // Image generation should prefer savedPath; otherwise the phone renders
    // the safe unavailable placeholder without leaking the payload.
    return null;
  }
  if (/^https?:\/\//i.test(source)) {
    let name = 'image';
    try { name = path.basename(new URL(source).pathname) || name; } catch {}
    return { name, mime: 'image/*', mimeType: 'image/*', url: source };
  }
  return {
    name: path.basename(source) || 'image',
    mime: 'image/*',
    mimeType: 'image/*',
    filePath: source,
  };
}

function imageAttachments(payload = {}) {
  const args = parseToolArguments(payload);
  const cwd = String(args.cwd || args.workdir || payload.cwd || '');
  const values = [];
  for (const key of ['path', 'filePath', 'filename', 'file', 'savedPath', 'src', 'url', 'dataUrl']) {
    const value = payload[key] ?? args[key];
    if (Array.isArray(value)) values.push(...value);
    else if (typeof value === 'string') values.push(value);
  }
  for (const key of ['paths', 'imagePaths', 'referenced_image_paths']) {
    const value = payload[key] ?? args[key];
    if (Array.isArray(value)) values.push(...value);
  }
  if (payload.type === 'imageGeneration' && typeof payload.result === 'string') values.push(payload.result);
  const attachments = [];
  const seen = new Set();
  for (const value of values) {
    const attachment = imageAttachment(value, cwd);
    const key = attachment && (attachment.filePath || attachment.url || attachment.dataUrl);
    if (!attachment || !key || seen.has(key)) continue;
    seen.add(key);
    attachments.push(attachment);
    if (attachments.length >= 8) break;
  }
  return attachments;
}

function sourceKey(payload = {}) {
  return String(payload.id || payload.call_id || payload.callId || payload.requestId ||
    payload.itemId || payload.taskId || payload.handoffId || '').trim();
}

function activityState(payload = {}) {
  const status = payload.status && typeof payload.status === 'object' ? payload.status.type : payload.status;
  const raw = [payload.lifecycle_state, status, payload.decision, payload.action, payload.outcome]
    .map(value => String(value || '').toLowerCase()).join(' ');
  if (raw.includes('fail') || raw.includes('error') || payload.success === false) return 'failed';
  if (raw.includes('cancel') || raw.includes('interrupt') || raw.includes('abort') || raw.includes('timeout')
    || raw.includes('timedout') || raw.includes('declin') || raw.includes('denied') || raw.includes('reject')) return 'cancelled';
  if (raw.includes('progress') || raw.includes('running') || raw.includes('started')) return 'running';
  if (raw.includes('pending')) return 'pending';
  return 'succeeded';
}

function planBody(payload = {}) {
  const parts = [];
  for (const value of [payload.text, payload.planContent, payload.content, payload.explanation]) {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }
  if (Array.isArray(payload.plan)) {
    for (const entry of payload.plan) {
      if (typeof entry === 'string' && entry.trim()) parts.push(entry.trim());
      else if (entry && typeof entry === 'object') {
        const text = String(entry.step || entry.text || entry.title || '').trim();
        if (text) parts.push(text);
      }
    }
  }
  return sanitizeDisplayText([...new Set(parts)].join('\n'));
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => item && (item.text || item.message || ''))
    .filter(Boolean)
    .join('\n');
}

function localImageAttachments(values) {
  if (!Array.isArray(values)) return [];
  const attachments = [];
  const seen = new Set();
  for (const value of values) {
    const filePath = String(value || '').trim();
    if (!filePath || /^data:/i.test(filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    attachments.push({
      name: path.basename(filePath) || 'image',
      mime: 'image/*',
      filePath,
    });
    if (attachments.length >= 20) break;
  }
  return attachments;
}

function summary(summaryKind, text, item, extra = {}) {
  return {
    schemaVersion: 2,
    type: 'summary',
    kind: 'summary',
    summaryKind,
    text,
    time: item.timestamp || '',
    ...extra,
  };
}

function summaryForPhase(phase, item, textValue = '') {
  const normalized = String(phase || '').trim().toLowerCase();
  const body = sanitizeDisplayText(textValue);
  const extra = body ? { body } : {};
  if (normalized === 'commentary') return summary('commentary', '正在处理请求', item, extra);
  if (normalized === 'planning' || normalized === 'plan') return summary('plan', '已更新执行计划', item, extra);
  return null;
}

function reasoningSummaryBody(payload = {}) {
  if (typeof payload.summary === 'string') return sanitizeDisplayText(payload.summary);
  if (!Array.isArray(payload.summary)) return '';
  return sanitizeDisplayText(payload.summary
    .map(part => part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n'));
}

function toolSummary(payload = {}, item) {
  const rawName = String(payload.name || payload.tool || '').split('.').pop().toLowerCase();
  if (COLLABORATION_CALLS.has(rawName)) return null;
  const type = String(payload.type || '');
  const state = activityState(payload);
  const common = { state, sourceKey: sourceKey(payload), ...(sourceKey(payload) ? { id: sourceKey(payload) } : {}) };
  const safeToken = value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_.:/-]{1,64}$/.test(text) && !text.includes(':/') ? text : '';
  };
  const durationMs = Number.isFinite(payload.durationMs) && payload.durationMs >= 0 ? Math.floor(payload.durationMs) : undefined;
  const execution = {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(Number.isInteger(payload.exitCode) ? { exitCode: payload.exitCode } : {}),
    ...(typeof payload.background === 'boolean' ? { background: payload.background } : {}),
  };
  if (type === 'notice') return noticeToolSummary(payload, item, common);
  if (type === 'turnDiff') return summary('tool', 'Files changed', item, { ...common, toolKind: 'diff', fileCounts: payload.fileCounts });
  if (type === 'unknown') return summary('tool', 'Unsupported activity', item, { ...common, toolKind: 'unknown', publicType: payload.publicType });
  if (type === 'web_search_call' || type === 'webSearch' || rawName.includes('search')) {
    return summary('tool', state === 'running' ? '正在搜索网页' : '已完成网页搜索', item,
      { ...common, toolKind: 'search', operation: safeToken(payload.action?.type || payload.operation || 'search'), ...execution });
  }
  if (type === 'commandExecution' || type === 'local_shell_call' || rawName === 'shell_command'
    || rawName === 'exec_command' || rawName === 'exec') {
    const installed = type === 'commandExecution' ? classifyDesktopActivity(payload) : null;
    if (installed && installed.kind === 'file') {
      return summary('tool', state === 'running' ? 'Exploring files' : state === 'failed' ? 'File exploration failed' : 'Explored files', item,
        { ...common, toolKind: 'file', operation: safeToken(payload.commandActions?.[0]?.type || 'read'), ...execution });
    }
    return summary('tool', state === 'running' ? '正在运行命令' : state === 'failed' ? '命令执行失败' : '已运行命令', item,
      { ...common, toolKind: 'command', operation: safeToken(payload.commandActions?.[0]?.type || payload.operation || 'run'), ...execution });
  }
  if (type === 'fileChange' || rawName === 'apply_patch') {
    const count = Array.isArray(payload.changes) ? Math.max(1, payload.changes.length) : 1;
    return summary('tool', state === 'running' ? '正在更新文件' : state === 'failed' ? '文件更新失败' : `已更新 ${count} 个文件`, item,
      { ...common, toolKind: 'file', count });
  }
  if (type === 'imageView' || type === 'image_view' || type === 'view_image_tool_call'
    || rawName === 'view_image' || rawName.includes('screenshot')) {
    const attachments = imageAttachments(payload);
    const declaredCount = Number(payload.imageCount || payload.count || 0);
    const pathCount = Array.isArray(payload.imagePaths) ? payload.imagePaths.length : 0;
    const count = Math.min(100, Math.max(1, attachments.length, pathCount,
      Number.isFinite(declaredCount) ? Math.floor(declaredCount) : 0));
    return summary('tool', state === 'failed' ? '图像查看失败' : state === 'cancelled' ? '图像查看已取消' : `已查看 ${count} 张图像`, item,
      { ...common, toolKind: 'imageView', count, attachments });
  }
  if (type === 'imageGeneration' || rawName.includes('imagegen') || rawName.includes('image_generation')) {
    const attachments = imageAttachments(payload);
    const count = Math.max(1, attachments.length);
    return summary('tool', state === 'running' ? '正在生成图像' : state === 'failed' ? '图像生成失败' : `已生成 ${count} 张图像`, item,
      { ...common, toolKind: 'imageGeneration', count, attachments });
  }
  if (type === 'mcpToolCall' || type === 'mcp_tool_call' || rawName === 'read_mcp_resource') {
    return summary('tool', state === 'running' ? '正在调用 MCP' : state === 'failed' ? 'MCP 调用失败' : '已完成 MCP 调用', item,
      { ...common, toolKind: 'mcp', server: safeToken(payload.server), tool: safeToken(payload.tool), ...execution });
  }
  if (type === 'permissionRequest' || rawName.includes('approval')) {
    return summary('tool', state === 'running' || state === 'pending' ? '等待操作审批' :
      state === 'cancelled' ? '审批已拒绝' : state === 'failed' ? '审批处理失败' : '审批已处理', item,
      { ...common, toolKind: 'approval' });
  }
  if (type === 'userInputResponse' || type === 'mcpServerElicitation' || rawName === 'request_user_input') {
    return summary('tool', state === 'running' || state === 'pending' ? '等待用户输入' :
      state === 'cancelled' ? '输入已取消' : state === 'failed' ? '输入处理失败' : '已收到用户输入', item,
      { ...common, toolKind: 'userInput' });
  }
  if (type === 'enteredReviewMode' || type === 'exitedReviewMode' || type === 'automaticApprovalReview') {
    return summary('tool', type === 'exitedReviewMode' ? '已退出审阅模式' :
      state === 'cancelled' ? '自动审阅未通过' : state === 'failed' ? '审阅失败' :
        state === 'running' || state === 'pending' ? '正在审阅' : '审阅已完成', item,
      { ...common, toolKind: 'review' });
  }
  if (type === 'contextCompaction') {
    return summary('tool', state === 'running' ? '正在压缩上下文' : '上下文压缩完成', item,
      { ...common, toolKind: 'compaction' });
  }
  if (type === 'sleep') {
    return summary('tool', state === 'running' ? '等待中' : '等待结束', item,
      { ...common, toolKind: 'sleep' });
  }
  if (type === 'error') {
    const body = sanitizeDisplayText(payload.message || payload.error || '');
    const errorState = payload.willRetry === true ? 'running' : 'failed';
    return summary('commentary', payload.willRetry === true ? '连接异常，正在重试' : '执行出现错误', item,
      { ...common, state: errorState, willRetry: payload.willRetry === true, ...(body ? { body } : {}) });
  }
  return summary('tool', state === 'running' ? '正在调用工具' : state === 'failed' ? '工具调用失败' : '已调用工具', item,
    { ...common, toolKind: type === 'dynamicToolCall' ? 'dynamicTool' : 'tool',
      ...(type === 'dynamicToolCall' ? { namespace: safeToken(payload.namespace), tool: safeToken(payload.tool), ...execution } : {}) });
}

function noticeToolSummary(payload, item, common) {
  const noticeKind = ['warning', 'guardianWarning', 'configWarning', 'deprecationNotice'].includes(payload.noticeKind)
    ? payload.noticeKind : 'warning';
  const labels = { warning: 'Codex reported a warning.', guardianWarning: 'Guardian warning.',
    configWarning: 'Configuration warning.', deprecationNotice: 'Deprecation notice.' };
  return summary('tool', labels[noticeKind], item, { ...common, toolKind: 'notice', noticeKind });
}

function createSessionNormalizer(options = {}) {
  const session = options.session || {};
  const subagentPrivacy = options.subagentPrivacy || createSubagentPrivacy();
  let turnState = createTurnState();
  const recentUserMessages = new Map();
  let recentUserSequence = 0;

  function pairedUserSource(text, timestampMs) {
    const previous = recentUserMessages.get(text);
    if (previous && (!timestampMs || !previous.timestampMs || Math.abs(timestampMs - previous.timestampMs) <= 1500)) {
      return previous.sourceKey;
    }
    const sourceKey = `user:${timestampMs || Date.now()}:${recentUserSequence++}`;
    recentUserMessages.set(text, { timestampMs, sourceKey });
    while (recentUserMessages.size > 40) recentUserMessages.delete(recentUserMessages.keys().next().value);
    return sourceKey;
  }
  function userMessage(textValue, item, turnId = '', attachments = []) {
    const parsed = parseUserMessageEnvelope(textValue);
    const text = sanitizeDisplayText(parsed.text);
    if (!text) return null;
    const timestampMs = Date.parse(item.timestamp || '') || 0;
    return {
      schemaVersion: 2,
      type: 'message',
      role: 'user',
      text,
      sourceKey: pairedUserSource(text, timestampMs),
      turnId: String(turnId || ''),
      delivery: classifyUserDelivery(turnState, turnId),
      time: item.timestamp || '',
      ...(attachments.length ? { attachments } : {}),
    };
  }

  function finalMessage(textValue, item, payload = {}) {
    const text = sanitizeAssistantDisplayText(textValue);
    if (!text) return null;
    return {
      schemaVersion: 2,
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      id: sourceKey(payload),
      sourceKey: sourceKey(payload),
      text,
      turnId: String(item.payload?.internal_chat_message_metadata_passthrough?.turn_id || ''),
      time: item.timestamp || '',
    };
  }

  function normalizeEventMessage(item) {
    const payload = item.payload || {};
    if (payload.type === 'task_started') {
      turnState = reduceTurnEvent(turnState, item);
      return {
        schemaVersion: 2,
        type: 'turn',
        state: 'started',
        turnId: String(payload.turn_id || turnState.activeTurnId || ''),
        time: item.timestamp || '',
      };
    }
    if (payload.type === 'task_complete' || payload.type === 'task_failed' || payload.type === 'task_interrupted') {
      const turnId = String(payload.turn_id || turnState.activeTurnId || '');
      turnState = reduceTurnEvent(turnState, item);
      return {
        schemaVersion: 2,
        type: 'turn',
        state: payload.type === 'task_complete' ? 'completed' : payload.type === 'task_interrupted' ? 'interrupted' : 'failed',
        turnId,
        time: item.timestamp || '',
      };
    }
    if (payload.type === 'user_message') {
      return userMessage(payload.message || '', item, '', localImageAttachments(payload.local_images));
    }
    if (payload.type === 'agent_reasoning') {
      const body = sanitizeDisplayText(payload.text || payload.message || '');
      return summary('reasoning', '正在分析请求', item, body ? { body } : {});
    }
    if (payload.type === 'agent_message') {
      if (payload.phase === 'final_answer') return finalMessage(payload.message || '', item, payload);
      const progress = summaryForPhase(payload.phase, item, payload.message || '');
      return progress && sourceKey(payload) ? { ...progress, id: sourceKey(payload), sourceKey: sourceKey(payload) } : progress;
    }
    if (payload.type === 'sub_agent_activity' || payload.type === 'subAgentActivity') {
      const subagent = subagentPrivacy.normalize(payload);
      if (!subagent) return null;
      const statusText = {
        enabled: '已启用',
        closed: '已关闭',
        failed: '执行失败',
        interrupted: '已中断',
      }[subagent.status];
      return summary('subagent', `${subagent.name} ${statusText}`, item, {
        subagent,
        sourceKey: sourceKey(payload),
      });
    }
    if (payload.type === 'view_image_tool_call' || payload.type === 'imageView' || payload.type === 'image_view') {
      return toolSummary(payload, item);
    }
    return null;
  }

  function normalizeResponseItem(item) {
    const payload = item.payload || {};
    if (payload.type === 'agent_message') return null;
    if (payload.type === 'reasoning') {
      const body = reasoningSummaryBody(payload);
      return summary('reasoning', '正在分析请求', item, {
        ...(body ? { body } : {}),
        state: activityState(payload),
        sourceKey: sourceKey(payload),
      });
    }
    if (payload.type === 'plan' || payload.type === 'todo-list' || payload.type === 'todoList'
      || payload.type === 'planImplementation' || payload.type === 'proposed-plan') {
      const body = planBody(payload);
      return summary('plan', '已更新执行计划', item, {
        ...(body ? { body } : {}),
        state: activityState(payload),
        sourceKey: sourceKey(payload),
        ...(payload.stepCounts ? { stepCounts: payload.stepCounts, hasExplanation: payload.hasExplanation === true } : {}),
      });
    }
    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const turnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id || '');
        return userMessage(extractMessageText(payload.content), item, turnId);
      }
      if (payload.role !== 'assistant') return null;
      if (payload.phase === 'final_answer') return finalMessage(extractMessageText(payload.content), item, payload);
      const progress = summaryForPhase(payload.phase, item, extractMessageText(payload.content));
      return progress && sourceKey(payload) ? { ...progress, id: sourceKey(payload), sourceKey: sourceKey(payload) } : progress;
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'web_search_call'
      || payload.type === 'local_shell_call' || payload.type === 'commandExecution' || payload.type === 'fileChange'
      || payload.type === 'mcpToolCall' || payload.type === 'dynamicToolCall' || payload.type === 'webSearch'
      || payload.type === 'imageView' || payload.type === 'imageGeneration' || payload.type === 'sleep'
      || payload.type === 'enteredReviewMode' || payload.type === 'exitedReviewMode'
      || payload.type === 'contextCompaction' || payload.type === 'permissionRequest'
      || payload.type === 'userInputResponse' || payload.type === 'mcpServerElicitation'
      || payload.type === 'automaticApprovalReview' || payload.type === 'error'
      || payload.type === 'notice' || payload.type === 'turnDiff' || payload.type === 'unknown') {
      return toolSummary(payload, item);
    }
    if (payload.app_server_item === true) {
      // New App Server variants remain visible as a generic lifecycle row.
      // toolSummary deliberately excludes arguments, output, paths and body.
      const installedTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
        'imageView', 'imageGeneration', 'sleep', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction']);
      return toolSummary(installedTypes.has(payload.type) ? payload : {
        type: 'unknown', id: payload.id, publicType: safePublicType(payload.type), lifecycle_state: payload.lifecycle_state,
      }, item);
    }
    return null;
  }

  function normalize(item = {}) {
    if (session.isSubagent === true) return null;
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'turn_context') {
      turnState = reduceTurnEvent(turnState, item);
      return null;
    }
    const normalized = item.type === 'event_msg'
      ? normalizeEventMessage(item)
      : item.type === 'response_item'
        ? normalizeResponseItem(item)
        : null;
    if (normalized && normalized.type === 'summary' && !normalized.turnId) {
      const explicitTurnId = String(item.payload?.internal_chat_message_metadata_passthrough?.turn_id || '');
      const turnId = explicitTurnId || turnState.activeTurnId;
      if (turnId) return { ...normalized, turnId };
    }
    return normalized;
  }

  return {
    normalize,
  };
}

module.exports = {
  createSessionNormalizer,
};
