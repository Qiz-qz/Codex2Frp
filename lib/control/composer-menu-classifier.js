'use strict';

const KINDS = new Set(['plugin', 'subagent', 'add', 'filePicker', 'mode', 'unknown']);

function normalized(value) {
  return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_:/.-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function safeValues(source = {}) {
  const data = source.dataAttributes && typeof source.dataAttributes === 'object'
    ? source.dataAttributes
    : source.dataset && typeof source.dataset === 'object' ? source.dataset : {};
  return {
    explicitKind: String(source.kind || '').trim(),
    group: normalized(source.group || source.header || source.section),
    action: normalized(source.action || source.actionId || source.actionIdentity || source.command),
    role: normalized(source.ariaRole || source.role),
    aria: normalized(source.ariaLabel),
    pluginId: normalized(source.pluginId || data.pluginId || data.plugin),
    dataKind: normalized(data.kind || data.itemKind || data.itemType || data.action || data.actionId),
    label: normalized(source.label || source.text),
  };
}

function kindFromStable(value) {
  if (!value) return '';
  if (/\b(subagents?|sub agents?|spawn agent|create agent|agent spawn)\b/.test(value)) return 'subagent';
  if (/\b(plugins?|extensions?)\b/.test(value)) return 'plugin';
  if (/\b(file picker|pick file|attach file|choose file|files? and folders?|upload file)\b/.test(value)) return 'filePicker';
  if (/\b(work mode|plan mode|goal mode|mode selector|select mode)\b/.test(value)) return 'mode';
  if (/\b(add|add reference|add context|mention)\b/.test(value)) return 'add';
  return '';
}

function kindFromGroup(value) {
  if (!value) return '';
  if (/\b(subagents?|sub agents?)\b|子代理/.test(value)) return 'subagent';
  if (/\bplugins?\b|插件/.test(value)) return 'plugin';
  return '';
}

function kindFromText(value) {
  if (!value) return '';
  if (/\b(files? and folders?|choose (?:a )?file|attach (?:a )?file)\b|文件和文件夹|选择文件|添加附件/.test(value)) return 'filePicker';
  if (/\b(subagents?|spawn agent)\b|子代理/.test(value)) return 'subagent';
  if (/\bplugins?\b|插件/.test(value)) return 'plugin';
  if (/\b(plan|goal) mode\b|计划(?:模式)?|目标(?:设置|模式)?/.test(value)) return 'mode';
  return '';
}

function classifyMenuItem(source = {}) {
  const values = safeValues(source);
  let kind = '';
  if (KINDS.has(values.explicitKind)) kind = values.explicitKind;
  if (values.pluginId) kind = 'plugin';
  if (!kind) kind = kindFromStable(values.action);
  if (!kind) kind = kindFromStable(values.dataKind);
  if (!kind) kind = kindFromGroup(values.group);
  if (!kind && ['menuitem', 'option', 'button'].includes(values.role)) kind = kindFromStable(values.aria);
  const textKind = kindFromText(values.label || values.aria);
  if (!kind || kind === 'add' && ['filePicker', 'mode'].includes(textKind)) kind = textKind || kind;
  if (!KINDS.has(kind)) kind = 'unknown';
  return { kind, executable: kind !== 'unknown' };
}

function isExecutableMenuItem(value = {}) {
  const kind = KINDS.has(value.kind) ? value.kind : classifyMenuItem(value).kind;
  return kind !== 'unknown';
}

function publishableMenuItems(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => {
    const kind = KINDS.has(item && item.kind) ? item.kind : classifyMenuItem(item).kind;
    return kind !== 'unknown';
  });
}

module.exports = {
  classifyMenuItem,
  isExecutableMenuItem,
  publishableMenuItems,
};
