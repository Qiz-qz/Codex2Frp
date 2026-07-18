'use strict';

const { sanitizeDisplayText } = require('./display-text');
const { sanitizePublicAttachments } = require('./activity-projection');
const { safeDisplayDetail, safeFileLabel, safePresentationToken } = require('./public-timeline');

const GROUPABLE_KINDS = new Set([
  'command', 'file', 'image', 'web', 'mcp', 'dynamicTool', 'review', 'compaction',
  'subagent', 'plugin',
]);
const NARRATIVE_KINDS = new Set(['commentary', 'reasoningSummary', 'plan']);
const CHANGE_KINDS = new Set(['added', 'deleted', 'modified', 'renamed', 'created', 'removed']);
const OPERATION_KINDS = new Set(['command', 'file']);

function contribution(entry) {
  return Number.isFinite(entry.count) ? Math.max(1, Math.floor(entry.count)) : 1;
}

function safeState(value) {
  const state = String(value || '').toLowerCase();
  return ['pending', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(state)
    ? state
    : 'unknown';
}

function safeSubagent(value) {
  if (!value || typeof value !== 'object') return null;
  const name = sanitizeDisplayText(value.name).trim().slice(0, 64);
  const state = String(value.state || '').toLowerCase();
  if (!name || !['running', 'completed', 'failed', 'interrupted'].includes(state)) return null;
  return { name, state };
}

function safeItem(entry) {
  const item = {
    id: String(entry.id || ''), state: safeState(entry.state),
    ...(OPERATION_KINDS.has(entry.kind) ? { _operationKind: entry.kind } : {}),
  };
  if (entry.kind === 'subagent') {
    const subagent = safeSubagent(entry.subagent);
    return subagent ? { ...item, subagent } : null;
  }
  const title = sanitizeDisplayText(entry.title).slice(0, 512);
  if (title) item.title = title;
  if (NARRATIVE_KINDS.has(entry.kind)) {
    const narrative = sanitizeDisplayText(entry.publicNarrative).slice(0, 12000);
    if (narrative) item.publicNarrative = narrative;
  }
  if (Number.isFinite(entry.durationMs) && entry.durationMs >= 0) {
    item.durationMs = Math.floor(entry.durationMs);
  }
  const operation = safePresentationToken(entry.operation);
  if (operation) item.operation = operation;
  const operationKind = String(entry.operationKind || '').toLowerCase();
  if (OPERATION_KINDS.has(entry.kind) && operationKind === entry.kind) item.operationKind = operationKind;
  const displayDetail = safeDisplayDetail(entry.displayDetail);
  if (displayDetail && (entry.kind === 'command' || entry.kind === 'file' || entry.kind === 'web')) {
    item.displayDetail = displayDetail;
  }
  const server = safePresentationToken(entry.server);
  const tool = safePresentationToken(entry.tool);
  const namespace = safePresentationToken(entry.namespace);
  const surfaceKind = entry.surfaceKind === 'computerUse' ? 'computerUse' : '';
  if (server && entry.kind === 'mcp') item.server = server;
  if (tool && (entry.kind === 'mcp' || entry.kind === 'dynamicTool')) item.tool = tool;
  if (namespace && entry.kind === 'dynamicTool') item.namespace = namespace;
  if (surfaceKind && entry.kind === 'mcp') item.surfaceKind = surfaceKind;
  if (Number.isInteger(entry.exitCode)) item.exitCode = entry.exitCode;
  if (typeof entry.background === 'boolean') item.background = entry.background;
  if (Number.isSafeInteger(entry.sourceOrdinal) && entry.sourceOrdinal > 0) {
    item.sourceOrdinal = entry.sourceOrdinal;
  }
  if (entry.kind === 'file') {
    const fileLabel = safeFileLabel(entry.fileLabel);
    if (fileLabel) item.fileLabel = fileLabel;
    const changeKind = String(entry.changeKind || '').toLowerCase();
    if (CHANGE_KINDS.has(changeKind)) item.changeKind = changeKind;
  }
  if (entry.kind === 'image' && Array.isArray(entry.attachments)) {
    const attachments = sanitizePublicAttachments(entry.attachments);
    if (attachments.length) item.attachments = attachments;
  }
  return item;
}

function segmentState(items) {
  const states = new Set(items.map(item => safeState(item.state)));
  if (states.has('running')) return 'running';
  if (states.has('pending')) return 'pending';
  if (states.has('failed')) return 'failed';
  if (states.has('cancelled')) return 'cancelled';
  if (states.has('unknown')) return 'unknown';
  return 'succeeded';
}

function refreshSegment(segment) {
  segment.count = segment.items.reduce((total, item) => total + item._contribution, 0);
  segment.state = segmentState(segment.items);
  if (segment.kind === 'operation') {
    segment.commandCount = segment.items
      .filter(item => item._operationKind === 'command')
      .reduce((total, item) => total + item._contribution, 0);
    segment.fileCount = segment.items
      .filter(item => item._operationKind === 'file')
      .reduce((total, item) => total + item._contribution, 0);
  }
}

function publicItems(items) {
  return items.map(({ _contribution, _operationKind, ...item }) => ({
    ...item,
    ...(_operationKind ? { operationKind: _operationKind } : {}),
  }));
}

function presentationFor(entry) {
  const variant = safePresentationToken(entry.variant);
  const groupingVariant = entry.kind === 'image' ? variant : '';
  return {
    key: `${OPERATION_KINDS.has(entry.kind) ? 'operation' : entry.kind}\n${groupingVariant}`,
    ...(variant ? { variant } : {}),
  };
}

function segmentVisibleTimeline(entries) {
  const segments = [];
  const knownOperations = new Map();

  for (const source of Array.isArray(entries) ? entries : []) {
    if (!source || typeof source !== 'object' || !source.kind || !source.id) continue;
    const entry = { ...source };
    const sanitizedItem = safeItem(entry);
    if (!sanitizedItem) continue;
    const presentation = presentationFor(entry);
    const operationKey = GROUPABLE_KINDS.has(entry.kind) ? `${entry.kind}\n${entry.id}` : '';
    const known = operationKey ? knownOperations.get(operationKey) : null;
    if (known) {
      const segment = segments[known.segmentIndex];
      const previous = segment.items[known.itemIndex];
      segment.items[known.itemIndex] = {
        ...previous,
        ...sanitizedItem,
        _contribution: Number.isFinite(entry.count) ? contribution(entry) : previous._contribution,
      };
      if (!segment.variant && presentation.variant) segment.variant = presentation.variant;
      refreshSegment(segment);
      continue;
    }

    const item = { ...sanitizedItem, _contribution: contribution(entry) };
    const previous = segments[segments.length - 1];
    let segment;
    if (GROUPABLE_KINDS.has(entry.kind) && previous
      && previous._presentationKey === presentation.key && previous.expandable) {
      segment = previous;
      segment.items.push(item);
      if (OPERATION_KINDS.has(entry.kind) && segment.kind !== entry.kind) segment.kind = 'operation';
    } else {
      segment = {
        id: `visible-segment-${entry.kind}-${entry.id}`,
        kind: entry.kind,
        ...('variant' in presentation ? { variant: presentation.variant } : {}),
        _presentationKey: presentation.key,
        count: 0,
        state: item.state,
        expandable: GROUPABLE_KINDS.has(entry.kind),
        items: [item],
      };
      segments.push(segment);
    }
    refreshSegment(segment);
    if (operationKey) {
      knownOperations.set(operationKey, {
        segmentIndex: segments.indexOf(segment), itemIndex: segment.items.length - 1,
      });
    }
  }

  return segments.map(({ _presentationKey, ...segment }) => ({
    ...segment,
    items: publicItems(segment.items),
  }));
}

module.exports = {
  GROUPABLE_KINDS,
  segmentVisibleTimeline,
};
