'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { sanitizeAssistantDisplayText, sanitizeDisplayText } = require('./display-text');
const { createSubagentPrivacy } = require('./subagent-privacy');
const { getPrivateEnvelopeAttachments, parseUserMessageEnvelope } = require('./user-message-envelope');
const { classifyDesktopActivity, safePublicType } = require('./desktop-activity-classifier');
const { safeDisplayDetail, safeDisplayDetails } = require('./public-timeline');
const {
  MAX_EXEC_IMAGES,
  extractExactApplyPatch,
  extractShellCommands,
  extractStaticImageViewPaths,
  isExactApplyPatchWrapper,
} = require('./exec-command-detail');
const { isVerifiedImageDataUrl } = require('./image-content');
const { isStrictInternalUserContext } = require('./internal-environment-context');
const {
  getPrivateAttachmentSource,
  privateAttachmentIdentity,
  setPrivateAttachmentSource,
} = require('./private-attachment-source');
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
  'wait',
  'wait_agent',
  'collabagenttoolcall',
]);

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif)(?:[?#].*)?$/i;
function commandExecutionDisplayDetail(payload = {}) {
  const direct = safeDisplayDetail(payload.command);
  if (direct) return direct;
  const commands = [];
  const seen = new Set();
  for (const action of Array.isArray(payload.commandActions) ? payload.commandActions : []) {
    const command = safeDisplayDetail(action && action.command);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
  }
  return safeDisplayDetail(commands.join('; '));
}

function customExecDisplayDetails(payload = {}) {
  return safeDisplayDetails(extractShellCommands(payload.input));
}

function functionCallCommandDisplayDetail(payload = {}) {
  const args = parseToolArguments(payload);
  return safeDisplayDetail(typeof args.command === 'string' ? args.command : '');
}

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
  return String(payload.id || payload.event_id || payload.eventId || payload.call_id || payload.callId || payload.requestId ||
    payload.itemId || payload.taskId || payload.handoffId || '').trim();
}

function privateLocalImageAttachment(sourceValue) {
  const source = String(sourceValue || '').trim();
  if (!source || !path.isAbsolute(source) || !IMAGE_EXTENSION.test(source)) return null;
  return setPrivateAttachmentSource({
    name: path.basename(source) || 'image',
    mime: 'image/*',
    mimeType: 'image/*',
  }, source);
}

function verifiedImageContentCount(value, trustedOutput = false) {
  if (!Array.isArray(value)) return 0;
  const images = value.filter(item => item && typeof item === 'object' && item.type === 'input_image');
  if (!images.length || images.length > MAX_EXEC_IMAGES) return 0;
  const valid = trustedOutput
    ? true
    : images.every(item => isVerifiedImageDataUrl(item.image_url));
  return valid ? images.length : 0;
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

function extractPublicUserMessageText(content) {
  if (typeof content === 'string') return isStrictInternalUserContext(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => item && (item.text || item.message || ''))
    .filter(text => text && !isStrictInternalUserContext(text))
    .join('\n');
}

function patchChangeKind(value) {
  const kind = String(value && typeof value === 'object' ? value.type : value || '').toLowerCase();
  if (kind === 'add' || kind === 'added' || kind === 'create' || kind === 'created') return 'added';
  if (kind === 'delete' || kind === 'deleted' || kind === 'remove' || kind === 'removed') return 'deleted';
  if (kind === 'update' || kind === 'modified' || kind === 'modify') {
    return value && typeof value === 'object' && value.move_path ? 'renamed' : 'modified';
  }
  return '';
}

function safeChangedFileLabel(value, repositoryRelative = false) {
  const source = String(value || '').trim().replace(/\\/g, '/');
  if (!source || source.includes('\0')) return '';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) && !/^[A-Za-z]:\//.test(source)) return '';
  const label = repositoryRelative && !/^(?:[A-Za-z]:)?\//.test(source)
    && !source.split('/').includes('..')
    ? sanitizeDisplayText(source).slice(0, 512)
    : sanitizeDisplayText(path.posix.basename(source)).slice(0, 256);
  return safeDisplayDetail(label) === '<redacted command>' ? '' : label;
}

function safeFileChangeLabel(change = {}) {
  const kind = patchChangeKind(change.kind);
  const source = kind === 'renamed' && change.kind && typeof change.kind === 'object'
    ? change.kind.move_path
    : change.path;
  const normalized = String(source || '').trim().replace(/\\/g, '/');
  const repositoryRelative = normalized && !/^(?:[A-Za-z]:)?\//.test(normalized);
  return safeChangedFileLabel(normalized, repositoryRelative);
}

function fileDiffDisplayDetail(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * 1024 * 1024
    || !/^@@(?:\s|$)/m.test(value)) return '';
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  for (const line of value.split(/\r?\n/)) {
    if (/^@@(?:\s|$)/.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) deleted += 1;
  }
  return safeDisplayDetail(`+${added} -${deleted}`);
}

function fileOperation(changeKind) {
  if (changeKind === 'added' || changeKind === 'created') return 'create';
  if (changeKind === 'deleted' || changeKind === 'removed') return 'delete';
  if (changeKind === 'renamed') return 'rename';
  return 'edit';
}

function fileSummaryRows(payload = {}, item) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const baseId = sourceKey(payload);
  if (!baseId || changes.length === 0) return [];
  const state = activityState(payload);
  const rows = [];
  for (const [index, change] of changes.slice(0, 256).entries()) {
    if (!change || typeof change !== 'object') continue;
    const fileLabel = safeFileChangeLabel(change);
    const changeKind = patchChangeKind(change.kind);
    if (!fileLabel || !changeKind) continue;
    const id = `${baseId}:file:${index + 1}`;
    const displayDetail = fileDiffDisplayDetail(change.diff);
    rows.push(summary('tool', state === 'running' ? '正在更新文件' : state === 'failed' ? '文件更新失败' : '已更新文件', item, {
      state, sourceKey: id, id, toolKind: 'file', operationKind: 'file',
      operation: fileOperation(changeKind), count: 1, fileLabel, changeKind,
      ...(displayDetail ? { displayDetail } : {}),
    }));
  }
  return rows;
}

function exactApplyPatchChanges(input, direct = false) {
  const patchText = direct && typeof input === 'string' ? input : extractExactApplyPatch(input);
  if (!patchText) return [];
  const lines = patchText.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return [];
  const changes = [];
  let current = null;
  const commit = () => {
    if (!current) return;
    changes.push({
      path: current.path,
      kind: current.movePath
        ? { type: 'update', move_path: current.movePath }
        : { type: current.action === 'Add' ? 'add' : current.action === 'Delete' ? 'delete' : 'update' },
      diff: `@@\n${current.lines.join('\n')}`,
    });
  };
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      commit();
      current = { action: header[1], path: header[2], movePath: '', lines: [] };
      continue;
    }
    if (!current) return [];
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && current.action === 'Update' && !current.movePath) {
      current.movePath = move[1];
      continue;
    }
    if (line.startsWith('*** ')) return [];
    current.lines.push(line);
  }
  commit();
  return changes;
}

function exactApplyPatchSummaryRows(payload = {}, item) {
  if (payload.type !== 'custom_tool_call' || !['exec', 'apply_patch'].includes(payload.name)) return [];
  const changes = exactApplyPatchChanges(payload.input, payload.name === 'apply_patch');
  return changes.length ? fileSummaryRows({ ...payload, type: 'fileChange', changes }, item) : [];
}

function filePresentation(payload = {}) {
  if (Array.isArray(payload.changes) && payload.changes.length) {
    const change = payload.changes[0] || {};
    return {
      fileLabel: safeChangedFileLabel(change.path),
      changeKind: patchChangeKind(change.kind),
    };
  }
  const diff = typeof payload.diff === 'string' ? payload.diff : '';
  const match = diff.match(/^diff --git a\/(.+?) b\/(.+?)\r?$/m);
  return match ? { fileLabel: safeChangedFileLabel(match[2], true), changeKind: 'modified' } : {};
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

function inlineImageAttachments(values) {
  if (!Array.isArray(values)) return [];
  const attachments = [];
  for (const value of values) {
    const dataUrl = typeof value === 'string'
      ? value
      : String(value && (value.image_url || value.dataUrl) || '');
    if (!isVerifiedImageDataUrl(dataUrl)) continue;
    const mime = (dataUrl.match(/^data:([^;,]+)/i) || [])[1] || 'image/*';
    attachments.push({
      name: `image-${attachments.length + 1}`,
      mime,
      mimeType: mime,
      dataUrl,
    });
    if (attachments.length >= 20) break;
  }
  return attachments;
}

function messageContentImageAttachments(content) {
  if (!Array.isArray(content)) return [];
  return inlineImageAttachments(content.filter(item => item && item.type === 'input_image'));
}

function safeUserAttachments(attachmentNames = [], attachments = [], envelopeAttachments = []) {
  const result = [];
  const indices = new Map();
  const namedAttachments = envelopeAttachments.length
    ? envelopeAttachments
    : attachmentNames.map(name => ({ name }));
  for (const [ordinal, attachment] of [
    ...namedAttachments.map((item, index) => [index, item]),
    ...attachments.map((item, index) => [index, item]),
  ]) {
    const name = String(attachment && attachment.name || '').trim();
    if (!name) continue;
    const safe = { name };
    for (const field of ['mime', 'mimeType', 'url', 'dataUrl']) {
      if (typeof attachment[field] === 'string' && attachment[field].trim()) safe[field] = attachment[field];
    }
    const privateSource = String(attachment && (
      attachment.filePath || attachment.path || getPrivateAttachmentSource(attachment)
    ) || '');
    const candidate = setPrivateAttachmentSource(safe, privateSource);
    const key = privateAttachmentIdentity(candidate, ordinal);
    const existingIndex = indices.get(key);
    if (existingIndex !== undefined) {
      const merged = { ...result[existingIndex], ...candidate };
      result[existingIndex] = setPrivateAttachmentSource(merged,
        privateSource || getPrivateAttachmentSource(result[existingIndex]));
      continue;
    }
    indices.set(key, result.length);
    result.push(candidate);
    if (result.length >= 20) break;
  }
  return result.slice(0, 20);
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
  if (normalized === 'commentary') return summary('commentary', '正在处理请求', item, { ...extra, phase: 'commentary' });
  if (normalized === 'planning' || normalized === 'plan') {
    return summary('plan', '已更新执行计划', item, { ...extra, phase: 'plan' });
  }
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
  const exactName = typeof payload.name === 'string' ? payload.name : '';
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
  if (type === 'turnDiff') return summary('tool', 'Files changed', item,
    { ...common, toolKind: 'diff', fileCounts: payload.fileCounts, turnDiff: payload.turnDiff,
      ...filePresentation(payload) });
  if (type === 'unknown') return summary('tool', 'Unsupported activity', item, { ...common, toolKind: 'unknown', publicType: payload.publicType });
  if (type === 'web_search_call' || type === 'webSearch' || rawName.includes('search')) {
    return summary('tool', state === 'running' ? '正在搜索网页' : '已完成网页搜索', item,
      { ...common, toolKind: 'search', operation: safeToken(payload.action?.type || payload.operation || 'search'), ...execution });
  }
  if (type === 'custom_tool_call' && exactName === 'exec') {
    const displayDetails = customExecDisplayDetails(payload);
    if (displayDetails.length > 0) {
      const presentation = displayDetails.length === 1
        ? { displayDetail: displayDetails[0] }
        : { displayDetails, count: displayDetails.length };
      return summary('tool', state === 'running' ? '正在运行命令' : state === 'failed' ? '命令执行失败' : '已运行命令', item,
        { ...common, toolKind: 'command', operation: 'run', ...execution, ...presentation });
    }
    if (isExactApplyPatchWrapper(payload.input)) {
      const rows = exactApplyPatchSummaryRows(payload, item);
      if (rows.length) return rows[0];
      return summary('tool', state === 'running' ? '正在更新文件' : state === 'failed' ? '文件更新失败' : '已更新文件', item,
        { ...common, toolKind: 'file', count: 1, ...execution });
    }
    return null;
  }
  if (type === 'commandExecution' || type === 'local_shell_call' || rawName === 'shell_command'
    || rawName === 'exec_command' || rawName === 'exec') {
    const installed = type === 'commandExecution' ? classifyDesktopActivity(payload) : null;
    const displayDetail = type === 'commandExecution'
      ? commandExecutionDisplayDetail(payload)
      : functionCallCommandDisplayDetail(payload);
    const presentation = displayDetail ? { displayDetail } : {};
    if (installed && installed.kind === 'file') {
      return summary('tool', state === 'running' ? 'Exploring files' : state === 'failed' ? 'File exploration failed' : 'Explored files', item,
        { ...common, toolKind: 'file', operation: safeToken(payload.commandActions?.[0]?.type || 'read'), ...execution, ...presentation });
    }
    return summary('tool', state === 'running' ? '正在运行命令' : state === 'failed' ? '命令执行失败' : '已运行命令', item,
      { ...common, toolKind: 'command', operation: safeToken(payload.commandActions?.[0]?.type || payload.operation || 'run'), ...execution, ...presentation });
  }
  if (type === 'fileChange' || rawName === 'apply_patch') {
    const rows = fileSummaryRows(payload, item);
    if (rows.length) return rows[0];
    const count = Array.isArray(payload.changes) ? Math.max(1, payload.changes.length) : 1;
    return summary('tool', state === 'running' ? '正在更新文件' : state === 'failed' ? '文件更新失败' : `已更新 ${count} 个文件`, item,
      { ...common, toolKind: 'file', count, ...filePresentation(payload) });
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
    return summary('tool', payload.willRetry === true ? '连接异常，正在重试' : '执行出现错误', item,
      { ...common, toolKind: 'error', state: errorState, willRetry: payload.willRetry === true,
        ...(body ? { body } : {}) });
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
  const trustedImageOutputs = options.trustedImageOutputs instanceof WeakSet
    ? options.trustedImageOutputs : null;
  const correlationOnlyPayloads = options.correlationOnlyPayloads instanceof WeakSet
    ? options.correlationOnlyPayloads : null;
  const subagentPrivacy = options.subagentPrivacy || createSubagentPrivacy();
  let turnState = createTurnState();
  let adjacentUserMessage = null;
  let recentUserSequence = 0;
  const pendingListAgentCalls = new Set();
  const listedAgentStates = new Map();
  const pendingExecImageCalls = new Map();

  function imageCallKey(payload = {}) {
    const callId = String(payload.call_id || '').trim();
    const explicitTurnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id || '').trim();
    const turnId = explicitTurnId || String(turnState.activeTurnId || '').trim();
    return callId && turnId ? `${turnId}\0${callId}` : '';
  }

  function rememberExecImageCall(payload = {}) {
    if (payload.type !== 'custom_tool_call' || payload.name !== 'exec') return;
    const key = imageCallKey(payload);
    if (!key) return;
    const imagePaths = extractStaticImageViewPaths(payload.input);
    if (imagePaths) pendingExecImageCalls.set(key, imagePaths);
    else pendingExecImageCalls.delete(key);
    while (pendingExecImageCalls.size > 256) {
      pendingExecImageCalls.delete(pendingExecImageCalls.keys().next().value);
    }
  }

  function execImageOutput(payload, item) {
    if (payload.type !== 'custom_tool_call_output') return null;
    const callId = String(payload.call_id || '').trim();
    const key = imageCallKey(payload);
    const imagePaths = pendingExecImageCalls.get(key);
    if (!imagePaths) return null;
    pendingExecImageCalls.delete(key);
    const count = verifiedImageContentCount(payload.output,
      Boolean(trustedImageOutputs && trustedImageOutputs.has(payload.output)));
    if (count < 1 || count !== imagePaths.length) return null;
    const attachments = imagePaths.map(privateLocalImageAttachment).filter(Boolean);
    if (attachments.length !== imagePaths.length) return null;
    const identities = new Set(attachments.map((attachment, ordinal) => privateAttachmentIdentity(attachment, ordinal)));
    if (identities.size !== attachments.length) return null;
    return summary('tool', `已查看 ${count} 张图像`, item, {
      toolKind: 'imageView', state: 'succeeded', sourceKey: callId, id: callId, count, attachments,
    });
  }

  function listAgentTerminalState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    if (Object.hasOwn(value, 'completed')) return 'completed';
    if (Object.hasOwn(value, 'errored') || Object.hasOwn(value, 'failed')) return 'failed';
    if (Object.hasOwn(value, 'interrupted') || Object.hasOwn(value, 'cancelled') || Object.hasOwn(value, 'canceled')) {
      return 'interrupted';
    }
    return '';
  }

  function listAgentLifecycleRows(item = {}) {
    const payload = item.payload || {};
    if (item.type !== 'response_item') return null;
    if (payload.type === 'function_call' && payload.name === 'list_agents') {
      const callId = String(payload.call_id || payload.id || '').trim();
      if (callId) pendingListAgentCalls.add(callId);
      return [];
    }
    if (payload.type !== 'function_call_output') return null;
    const callId = String(payload.call_id || '').trim();
    if (!callId || !pendingListAgentCalls.delete(callId)) return null;
    const output = typeof payload.output === 'string' ? payload.output : '';
    if (!output || output.length > 4 * 1024 * 1024) return [];
    let parsed;
    try { parsed = JSON.parse(output); } catch { return []; }
    const agents = Array.isArray(parsed && parsed.agents) ? parsed.agents.slice(0, 256) : [];
    const rows = [];
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object') continue;
      const identity = String(agent.agent_name || '').trim();
      if (!identity || identity === '/root' || identity === 'root') continue;
      const terminal = listAgentTerminalState(agent.agent_status);
      if (!terminal) {
        if (typeof agent.agent_status === 'string') listedAgentStates.set(identity, 'running');
        continue;
      }
      if (listedAgentStates.get(identity) === terminal) continue;
      listedAgentStates.set(identity, terminal);
      const subagent = subagentPrivacy.normalize({
        agent_path: identity,
        task_name: identity.split(/[\\/]+/).filter(Boolean).pop() || '',
        kind: terminal,
      });
      if (!subagent) continue;
      const statusText = terminal === 'completed' ? '已完成' : terminal === 'failed' ? '失败' : '已中断';
      rows.push(summary('subagent', `${subagent.name} ${statusText}`, item, {
        subagent,
        sourceKey: `list-agents:${callId}:${crypto.createHash('sha256').update(identity).digest('hex')}:${terminal}`,
      }));
    }
    return rows;
  }

  function pairedUserSource(text, timestampMs, representation, recordId = '') {
    const stableRecordSource = recordId
      ? `user-record:${crypto.createHash('sha256').update(recordId).digest('hex')}`
      : '';
    const previous = adjacentUserMessage;
    const complementaryPair = previous && previous.text === text
      && previous.paired !== true && previous.representation !== representation;
    if (previous && complementaryPair
      && (!timestampMs || !previous.timestampMs || Math.abs(timestampMs - previous.timestampMs) <= 1500)) {
      adjacentUserMessage = null;
      return previous.sourceKey;
    }
    const sourceKey = stableRecordSource || `user:${timestampMs || Date.now()}:${recentUserSequence++}`;
    adjacentUserMessage = { text, timestampMs, sourceKey, representation, recordId, paired: false };
    return sourceKey;
  }
  function userMessage(textValue, item, turnId = '', attachments = [], representation = '') {
    if (isStrictInternalUserContext(textValue)) return null;
    const parsed = parseUserMessageEnvelope(textValue);
    const text = sanitizeDisplayText(parsed.text);
    const publicAttachments = safeUserAttachments(
      parsed.attachmentNames, attachments, getPrivateEnvelopeAttachments(parsed),
    );
    if (!text && publicAttachments.length === 0) return null;
    const timestampMs = Date.parse(item.timestamp || '') || 0;
    return {
      schemaVersion: 2,
      type: 'message',
      role: 'user',
      text,
      sourceKey: pairedUserSource(text, timestampMs, representation,
        String(item.payload?.client_id || item.payload?.id || '')),
      turnId: String(turnId || ''),
      delivery: classifyUserDelivery(turnState, turnId),
      time: item.timestamp || '',
      ...(publicAttachments.length ? { attachments: publicAttachments } : {}),
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
    if (payload.type === 'task_complete' || payload.type === 'task_failed' ||
      payload.type === 'task_interrupted' || payload.type === 'turn_aborted') {
      const turnId = String(payload.turn_id || turnState.activeTurnId || '');
      turnState = reduceTurnEvent(turnState, item);
      return {
        schemaVersion: 2,
        type: 'turn',
        state: payload.type === 'task_complete' ? 'completed' :
          (payload.type === 'task_interrupted' || payload.type === 'turn_aborted') ? 'interrupted' : 'failed',
        turnId,
        time: item.timestamp || '',
      };
    }
    if (payload.type === 'user_message') {
      return userMessage(payload.message || '', item, '', [
        ...localImageAttachments(payload.local_images),
        ...inlineImageAttachments(payload.images),
      ], 'event_msg');
    }
    if (payload.type === 'mcp_tool_call_end') {
      const invocation = payload.invocation && typeof payload.invocation === 'object' ? payload.invocation : {};
      const args = invocation.arguments && typeof invocation.arguments === 'object' ? invocation.arguments : {};
      const title = sanitizeDisplayText(args.title).trim().slice(0, 512);
      if (!title) return null;
      const token = value => {
        const text = typeof value === 'string' ? value.trim() : '';
        return /^[A-Za-z0-9_.:/-]{1,64}$/.test(text) && !text.includes(':/') ? text : '';
      };
      const secs = Number(payload.duration?.secs);
      const nanos = Number(payload.duration?.nanos);
      const durationMs = Number.isFinite(secs) && secs >= 0 && Number.isFinite(nanos) && nanos >= 0
        ? Math.floor(secs * 1000 + nanos / 1000000)
        : undefined;
      return summary('tool', title, item, {
        toolKind: 'mcp', state: 'succeeded', sourceKey: String(payload.call_id || ''),
        server: token(invocation.server), tool: token(invocation.tool),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    if (payload.type === 'web_search_end') {
      const displayDetail = safeDisplayDetail(payload.query);
      return summary('tool', '已搜索网页', item, {
        toolKind: 'search', state: 'succeeded', sourceKey: String(payload.call_id || ''),
        operation: 'search', ...(displayDetail ? { displayDetail } : {}),
      });
    }
    if (payload.type === 'context_compacted') {
      return summary('tool', '上下文已自动压缩', item, {
        toolKind: 'compaction', variant: 'automatic', state: 'succeeded',
      });
    }
    if (payload.type === 'agent_reasoning') {
      const body = sanitizeDisplayText(payload.text || payload.message || '');
      return summary('reasoning', '正在分析请求', item, { ...(body ? { body } : {}), phase: 'reasoning_summary' });
    }
    if (payload.type === 'agent_message') {
      if (payload.phase === 'final_answer') return finalMessage(payload.message || '', item, payload);
      const progress = summaryForPhase(payload.phase, item, payload.message || '');
      return progress && sourceKey(payload) ? { ...progress, id: sourceKey(payload), sourceKey: sourceKey(payload) } : progress;
    }
    if (payload.type === 'sub_agent_activity' || payload.type === 'subAgentActivity') {
      const subagent = subagentPrivacy.normalize(payload);
      if (!subagent) return null;
      const lifecycleKind = String(payload.kind || payload.activityKind || '').trim().toLowerCase();
      const statusText = lifecycleKind === 'started' || lifecycleKind === 'enabled'
        ? '已开始工作'
        : lifecycleKind === 'interacted' || lifecycleKind === 'running'
          ? '已更新'
          : subagent.state === 'completed' ? '已完成'
            : subagent.state === 'interrupted' ? '已中断' : '失败';
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
    rememberExecImageCall(payload);
    const imageOutput = execImageOutput(payload, item);
    if (imageOutput) return imageOutput;
    if (correlationOnlyPayloads && correlationOnlyPayloads.has(payload)) return null;
    if (payload.type === 'function_call' && payload.name === 'list_agents') return null;
    if (payload.type === 'agent_message') return null;
    if (payload.type === 'reasoning') {
      const body = reasoningSummaryBody(payload);
      return summary('reasoning', '正在分析请求', item, {
        ...(body ? { body } : {}),
        phase: 'reasoning_summary',
        state: activityState(payload),
        sourceKey: sourceKey(payload),
      });
    }
    if (payload.type === 'plan' || payload.type === 'todo-list' || payload.type === 'todoList'
      || payload.type === 'planImplementation' || payload.type === 'proposed-plan') {
      const body = planBody(payload);
      return summary('plan', '已更新执行计划', item, {
        ...(body ? { body } : {}),
        phase: 'plan',
        state: activityState(payload),
        sourceKey: sourceKey(payload),
        ...(payload.stepCounts ? { stepCounts: payload.stepCounts, hasExplanation: payload.hasExplanation === true } : {}),
      });
    }
    if (payload.type === 'message') {
      if (payload.role === 'user') {
        const turnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id || '');
        return userMessage(extractPublicUserMessageText(payload.content), item, turnId,
          messageContentImageAttachments(payload.content), 'response_item');
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
    let resolved = normalized;
    if (resolved && resolved.type === 'summary' && !resolved.turnId) {
      const explicitTurnId = String(item.payload?.internal_chat_message_metadata_passthrough?.turn_id || '');
      const turnId = explicitTurnId || turnState.activeTurnId;
      if (turnId) resolved = { ...resolved, turnId };
    }
    if (resolved && !(resolved.type === 'message' && resolved.role === 'user')) adjacentUserMessage = null;
    return resolved;
  }

  function normalizeMany(item = {}) {
    if (session.isSubagent === true) return [];
    const lifecycleRows = listAgentLifecycleRows(item);
    if (lifecycleRows !== null) {
      const resolvedRows = [];
      for (const row of lifecycleRows) {
        let resolved = row;
        if (resolved && resolved.type === 'summary' && !resolved.turnId) {
          const explicitTurnId = String(item.payload?.internal_chat_message_metadata_passthrough?.turn_id || '');
          const turnId = explicitTurnId || turnState.activeTurnId;
          if (turnId) resolved = { ...resolved, turnId };
        }
        if (resolved) resolvedRows.push(resolved);
      }
      if (resolvedRows.length) adjacentUserMessage = null;
      return resolvedRows;
    }
    if (item.type === 'response_item' && item.payload && item.payload.type === 'fileChange') {
      const rows = fileSummaryRows(item.payload, item);
      const explicitTurnId = String(item.payload.internal_chat_message_metadata_passthrough?.turn_id || '');
      const turnId = explicitTurnId || turnState.activeTurnId;
      if (rows.length) {
        adjacentUserMessage = null;
        return rows.map(row => turnId && !row.turnId ? { ...row, turnId } : row);
      }
    }
    if (item.type === 'response_item' && item.payload) {
      const rows = exactApplyPatchSummaryRows(item.payload, item);
      const explicitTurnId = String(item.payload.internal_chat_message_metadata_passthrough?.turn_id || '');
      const turnId = explicitTurnId || turnState.activeTurnId;
      if (rows.length) {
        adjacentUserMessage = null;
        return rows.map(row => turnId && !row.turnId ? { ...row, turnId } : row);
      }
    }
    const resolved = normalize(item);
    return resolved ? [resolved] : [];
  }

  return {
    normalize,
    normalizeMany,
  };
}

module.exports = {
  createSessionNormalizer,
};
