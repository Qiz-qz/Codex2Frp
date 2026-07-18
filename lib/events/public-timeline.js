'use strict';

const { sanitizeDisplayText } = require('./display-text');
const { sanitizePublicAttachments } = require('./activity-projection');
const {
  MAX_DISPLAY_DETAIL_CHARS,
  MAX_DISPLAY_DETAILS,
  MAX_DISPLAY_DETAILS_TOTAL_CHARS,
  safeDisplayDetail,
  safeDisplayDetails,
} = require('./display-detail');

const PUBLIC_KINDS = new Set([
  'commentary', 'reasoningSummary', 'plan', 'command', 'file', 'image', 'approval',
  'userInput', 'web', 'mcp', 'dynamicTool', 'review', 'compaction', 'subagent',
  'plugin', 'notice', 'error', 'finalAnswer',
]);
const NARRATIVE_KINDS = new Set(['commentary', 'reasoningSummary', 'plan']);
const PUBLIC_SOURCES = new Set(['file', 'rpc', 'rehydrate']);
const MAX_PUBLIC_NARRATIVE_CHARS = 12000;
const MAX_TITLE_CHARS = 512;
const SAFE_CHANGE_KINDS = new Set(['added', 'deleted', 'modified', 'renamed', 'created', 'removed']);

function safeFileLabel(value) {
  const label = sanitizeDisplayText(value).trim().slice(0, 512);
  if (!label || /^[A-Za-z]:[\\/]/.test(label) || /^[/\\]/.test(label)
    || /(^|[\\/])\.\.([\\/]|$)/.test(label) || /^file:/i.test(label)) return '';
  return label;
}

function safePresentationToken(value) {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_.:/-]{1,64}$/.test(token) && !token.includes(':/') ? token : '';
}

function publicKindFor(event = {}) {
  const summaryKind = String(event.summaryKind || '');
  if (summaryKind === 'commentary') return 'commentary';
  if (summaryKind === 'reasoningSummary') return 'reasoningSummary';
  if (summaryKind === 'reasoning' && event.phase === 'reasoning_summary') return 'reasoningSummary';
  if (summaryKind === 'plan') return 'plan';
  if (summaryKind === 'subagent') return 'subagent';
  if (summaryKind === 'plugin') return 'plugin';
  if (summaryKind !== 'tool') return '';

  const toolKind = String(event.toolKind || '').toLowerCase();
  if (toolKind === 'command') return 'command';
  if (toolKind === 'file') return 'file';
  if (['image', 'imageview', 'imagegeneration'].includes(toolKind)) return 'image';
  if (toolKind === 'approval') return 'approval';
  if (toolKind === 'userinput') return 'userInput';
  if (toolKind === 'search' || toolKind === 'web') return 'web';
  if (toolKind === 'mcp') return 'mcp';
  if (toolKind === 'dynamictool') return 'dynamicTool';
  if (toolKind === 'review') return 'review';
  if (toolKind === 'compaction') return 'compaction';
  if (toolKind === 'plugin') return 'plugin';
  if (toolKind === 'notice') return 'notice';
  if (toolKind === 'error') return 'error';
  return '';
}

function publicNarrativeFor(event = {}, kind = publicKindFor(event)) {
  if (!NARRATIVE_KINDS.has(kind)) return undefined;
  const narrative = sanitizeDisplayText(event.body).slice(0, MAX_PUBLIC_NARRATIVE_CHARS);
  return narrative || undefined;
}

function publicState(value, fallback = 'succeeded') {
  const state = String(value || '').toLowerCase();
  if (state === 'pending' || state === 'running' || state === 'succeeded' || state === 'failed'
    || state === 'cancelled' || state === 'unknown') return state;
  if (state === 'started' || state === 'inprogress' || state === 'in_progress') return 'running';
  if (state === 'completed') return 'succeeded';
  if (state === 'interrupted' || state === 'canceled') return 'cancelled';
  return fallback;
}

function publicPhaseFor(event, kind) {
  if (kind === 'commentary') return 'commentary';
  if (kind === 'reasoningSummary') return 'reasoning_summary';
  if (kind === 'plan') return 'plan';
  if (kind === 'finalAnswer') return 'final_answer';
  return 'activity';
}

function stableTimelineId(event, sequence, kind, turnId) {
  // ID-less desktop narratives receive a synthetic reconciler eventId for feed
  // ordering and provenance.  That hash is not the installed item's canonical
  // identity: treating it as one prevents the later response_item `id` from
  // replacing the duplicate event_msg representation of the same visible row.
  // Operations may still use eventId because they do not participate in this
  // narrowly bounded narrative twin reconciliation.
  const sourceId = String((NARRATIVE_KINDS.has(kind)
    ? event.id
    : (event.id || event.eventId)) || '').trim();
  return sourceId || `${String(turnId || 'turn')}-timeline-${sequence}-${kind}`;
}

function projectPublicTimelineEntry(event = {}, options = {}) {
  let kind = publicKindFor(event);
  const isFinal = event.type === 'message' && event.role === 'assistant' && event.phase === 'final_answer';
  if (isFinal) kind = 'finalAnswer';
  if (!PUBLIC_KINDS.has(kind)) return null;

  const sourceSequence = Number(event.sequence ?? event.order);
  const sequence = Number.isFinite(sourceSequence) ? sourceSequence : Number(options.sequence) || 0;
  const id = stableTimelineId(event, sequence, kind, options.turnId || event.turnId);
  const source = PUBLIC_SOURCES.has(event.source) ? event.source : 'projected';
  const sourceOrdinalValue = Number(event.sourceOrdinal ?? options.ordinal);
  const ordinal = Number.isSafeInteger(sourceOrdinalValue) && sourceOrdinalValue > 0
    ? sourceOrdinalValue
    : Number(options.sequence) || 1;
  const entry = {
    id,
    sequence,
    kind,
    phase: publicPhaseFor(event, kind),
    state: publicState(event.state, isFinal ? 'succeeded' : 'succeeded'),
    provenance: { source, eventId: String(event.eventId || event.id || id), ordinal },
  };
  const publicNarrative = publicNarrativeFor(event, kind);
  if (publicNarrative) entry.publicNarrative = publicNarrative;
  const title = sanitizeDisplayText(event.text).slice(0, MAX_TITLE_CHARS);
  if (title) entry.title = title;
  if (Number.isFinite(event.count) && event.count >= 0) entry.count = Math.floor(event.count);
  if (Number.isFinite(event.durationMs) && event.durationMs >= 0) {
    entry.durationMs = Math.floor(event.durationMs);
  }
  const toolKind = String(event.toolKind || '').toLowerCase();
  const variant = safePresentationToken(event.variant || (kind === 'image' && toolKind === 'imageview'
    ? 'imageView'
    : kind === 'image' && toolKind === 'imagegeneration' ? 'imageGeneration' : ''));
  const operation = safePresentationToken(event.operation);
  const operationKind = String(event.operationKind || '').toLowerCase();
  const displayDetail = safeDisplayDetail(event.displayDetail);
  const suppliedDisplayDetails = Object.hasOwn(event, 'displayDetails');
  const displayDetails = safeDisplayDetails(event.displayDetails);
  const server = safePresentationToken(event.server);
  const tool = safePresentationToken(event.tool);
  const namespace = safePresentationToken(event.namespace);
  const surfaceKind = event.surfaceKind === 'computerUse' ? 'computerUse' : '';
  if (variant) entry.variant = variant;
  if (operation) entry.operation = operation;
  if ((kind === 'command' || kind === 'file') && operationKind === kind) {
    entry.operationKind = operationKind;
  }
  if (displayDetails.length > 1 && kind === 'command') {
    entry.displayDetails = displayDetails;
    entry.count = displayDetails.length;
  } else if (displayDetail && (kind === 'command' || kind === 'file' || kind === 'web')) {
    entry.displayDetail = displayDetail;
  } else if (suppliedDisplayDetails) {
    delete entry.count;
  }
  if (server && kind === 'mcp') entry.server = server;
  if (tool && (kind === 'mcp' || kind === 'dynamicTool')) entry.tool = tool;
  if (namespace && kind === 'dynamicTool') entry.namespace = namespace;
  if (surfaceKind && kind === 'mcp') entry.surfaceKind = surfaceKind;
  if (Number.isInteger(event.exitCode)) entry.exitCode = event.exitCode;
  if (typeof event.background === 'boolean') entry.background = event.background;
  if (kind === 'file') {
    const fileLabel = safeFileLabel(event.fileLabel);
    if (fileLabel) entry.fileLabel = fileLabel;
    const changeKind = String(event.changeKind || '').toLowerCase();
    if (SAFE_CHANGE_KINDS.has(changeKind)) entry.changeKind = changeKind;
  }
  if (kind === 'image' && Array.isArray(event.attachments)) {
    const attachments = sanitizePublicAttachments(event.attachments);
    if (attachments.length) entry.attachments = attachments;
  }
  if (kind === 'subagent' && event.subagent && typeof event.subagent === 'object') {
    const name = sanitizeDisplayText(event.subagent.name).trim().slice(0, 64);
    const state = String(event.subagent.state || '').toLowerCase();
    if (name && ['running', 'completed', 'failed', 'interrupted'].includes(state)) {
      entry.subagent = { name, state };
    }
  }
  return entry;
}

function projectPublicTimelineEntries(event = {}, options = {}) {
  const entry = projectPublicTimelineEntry(event, options);
  if (!entry) return [];
  if (!Array.isArray(entry.displayDetails) || entry.displayDetails.length < 2) return [entry];
  const outerId = entry.id;
  return entry.displayDetails.map((displayDetail, index) => {
    const sourceOrdinal = index + 1;
    const child = {
      ...entry,
      id: `${outerId}:detail:${sourceOrdinal}`,
      count: 1,
      sourceOrdinal,
      displayDetail,
      provenance: { ...entry.provenance, eventId: outerId },
    };
    delete child.displayDetails;
    return child;
  });
}

function orderPublicTimeline(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && typeof entry === 'object')
    .slice()
    .sort((left, right) => left.sequence - right.sequence
      || left.provenance.ordinal - right.provenance.ordinal
      || Number(left.sourceOrdinal || 0) - Number(right.sourceOrdinal || 0));
}

module.exports = {
  MAX_PUBLIC_NARRATIVE_CHARS,
  MAX_DISPLAY_DETAIL_CHARS,
  MAX_DISPLAY_DETAILS,
  MAX_DISPLAY_DETAILS_TOTAL_CHARS,
  orderPublicTimeline,
  publicKindFor,
  projectPublicTimelineEntry,
  projectPublicTimelineEntries,
  publicNarrativeFor,
  safeFileLabel,
  safeDisplayDetail,
  safeDisplayDetails,
  safePresentationToken,
};
