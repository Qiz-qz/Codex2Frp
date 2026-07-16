'use strict';

const { sanitizeDisplayText } = require('./display-text');
const { appendProjectedActivity } = require('./activity-projection');
const { orderPublicTimeline, projectPublicTimelineEntries, safeDisplayDetail } = require('./public-timeline');
const { segmentVisibleTimeline } = require('./visible-segmenter');
const { sanitizeTurnDiff } = require('./turn-diff-store');
const { isStrictInternalUserContext } = require('./internal-environment-context');
const {
  copyPrivateAttachmentSource,
  getPrivateAttachmentSource,
  privateAttachmentIdentity,
  setPrivateAttachmentSource,
} = require('./private-attachment-source');

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
  if (toolKind === 'error') return 'error';
  if (toolKind === 'unknown') return 'unknown';
  if (toolKind === 'dynamictool') return 'dynamicTool';
  return '';
}

function subagentProjection(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').trim();
  const state = String(value.state || '');
  if (!name || !['running', 'completed', 'failed', 'interrupted'].includes(state)) return null;
  return { name, state };
}

function presentationIdentity(user, turnId, index) {
  const userId = String(user && user.id || '').trim();
  if (userId) return userId;
  return `${turnId || 'unscoped'}-presentation-${index + 1}`;
}

function createTurn(threadId, id, user, index) {
  const turnId = String(id || `turn-${index + 1}`);
  return {
    turnId,
    presentationId: presentationIdentity(user, turnId, index),
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
    timeline: [],
  };
}

function safeUserAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const name = sanitizeDisplayText(attachment.name).trim();
  if (!name) return null;
  const safe = { name };
  for (const field of ['mime', 'mimeType', 'url']) {
    if (typeof attachment[field] === 'string' && attachment[field].trim()) safe[field] = attachment[field];
  }
  return copyPrivateAttachmentSource(attachment, safe);
}

function mergeUserAttachments(previous = [], incoming = []) {
  const result = [];
  const indices = new Map();
  for (const [ordinal, attachment] of [
    ...previous.map((item, index) => [index, item]),
    ...incoming.map((item, index) => [index, item]),
  ]) {
    const safe = safeUserAttachment(attachment);
    const key = safe && privateAttachmentIdentity(safe, ordinal);
    if (!safe) continue;
    const existingIndex = indices.get(key);
    if (existingIndex !== undefined) {
      const previousSource = getPrivateAttachmentSource(result[existingIndex]);
      const incomingSource = getPrivateAttachmentSource(safe);
      result[existingIndex] = setPrivateAttachmentSource(
        { ...result[existingIndex], ...safe }, incomingSource || previousSource,
      );
      continue;
    }
    indices.set(key, result.length);
    result.push(safe);
    if (result.length >= 20) break;
  }
  return result;
}

function canonicalUserEvent(event = {}) {
  return event.delivery === 'steer' && Boolean(String(event.turnId || '').trim());
}

function coalescePairedUserEvents(events) {
  const result = [];
  const indices = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const isUser = event && event.type === 'message' && event.role === 'user';
    const identity = isUser ? String(event.eventId || event.id || event.sourceKey || '').trim() : '';
    if (!identity || !indices.has(identity)) {
      if (identity) indices.set(identity, result.length);
      result.push(event);
      continue;
    }
    const index = indices.get(identity);
    const previous = result[index];
    const preferred = canonicalUserEvent(previous) && !canonicalUserEvent(event) ? previous : event;
    const supplement = preferred === event ? previous : event;
    const attachments = mergeUserAttachments(previous.attachments, event.attachments);
    result[index] = {
      ...supplement,
      ...preferred,
      text: String(preferred.text || supplement.text || ''),
      turnId: String(preferred.turnId || supplement.turnId || ''),
      delivery: String(preferred.delivery || supplement.delivery || ''),
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return result;
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

function lifecycleTimestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestampMs = Date.parse(value);
  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}

function lifecycleDurationMs(startedAtMs, completedAtValue) {
  const completedAtMs = lifecycleTimestampMs(completedAtValue);
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(completedAtMs)) return null;
  const durationMs = completedAtMs - startedAtMs;
  return Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null;
}

function applyDuration(turn, durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return turn;
  turn.durationMs = durationMs;
  turn.process.durationMs = durationMs;
  return turn;
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
  const message = {
    role: 'user',
    label: '你',
    text: sanitizeDisplayText(event.text),
    time: event.time || '',
    threadId,
  };
  const id = String(event.eventId || event.id || event.sourceKey || '').trim();
  if (id) message.id = id;
  if (Array.isArray(event.attachments) && event.attachments.length > 0) {
    message.attachments = mergeUserAttachments([], event.attachments);
  }
  return message;
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

function isProjectedFallbackTimelineEntry(entry, turnId) {
  return Boolean(entry && entry.id === `${turnId}-timeline-${entry.sequence}-${entry.kind}`);
}

function dedupeAdjacentDesktopNarratives(entries, turnId) {
  const deduped = [];
  for (const entry of entries) {
    const previous = deduped[deduped.length - 1];
    const sameVisibleNarrative = previous &&
      ['commentary', 'reasoningSummary', 'plan'].includes(entry.kind) &&
      previous.kind === entry.kind &&
      Boolean(entry.publicNarrative) &&
      previous.publicNarrative === entry.publicNarrative;
    const previousFallback = isProjectedFallbackTimelineEntry(previous, turnId);
    const currentFallback = isProjectedFallbackTimelineEntry(entry, turnId);
    if (sameVisibleNarrative && previousFallback !== currentFallback) {
      // Installed Codex can emit one desktop-visible message twice: first as a
      // sequence-only event and then as the canonical item with a stable id.
      // Prefer the canonical identity, but never dedupe across an intervening
      // visible operation or collapse two independently identified messages.
      if (previousFallback) deduped[deduped.length - 1] = entry;
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function buildTurnViews(events, threadId = '') {
  const turns = [];
  const protocolPresentations = new Map();
  const protocolStartedAtMs = new Map();
  let current = null;
  let pendingUser = null;

  function registerPresentation(turn) {
    const turnId = String(turn && turn.turnId || '');
    const presentations = protocolPresentations.get(turnId) || [];
    presentations.push(turn);
    protocolPresentations.set(turnId, presentations);
    return turn;
  }

  function finalizeProtocol(turnId, state, completedAt = '') {
    const durationMs = lifecycleDurationMs(protocolStartedAtMs.get(String(turnId || '')), completedAt);
    for (const turn of protocolPresentations.get(String(turnId || '')) || []) {
      turn.state = state;
      finalizeProcess(turn.process, state);
      applyDuration(turn, durationMs);
    }
  }

  function ensureCurrent(id = '') {
    if (!current) {
      current = createTurn(threadId, id, pendingUser, turns.length);
      pendingUser = null;
      turns.push(registerPresentation(current));
    }
    return current;
  }

  for (const [eventIndex, event] of coalescePairedUserEvents(events).entries()) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'message' && event.role === 'user') {
      if (isStrictInternalUserContext(event.text)) continue;
      const message = userMessage(event, threadId);
      if (!message.text && (!Array.isArray(message.attachments) || message.attachments.length === 0)) continue;
      if (event.delivery === 'steer') {
        const protocolTurnId = String(event.turnId || current && current.turnId || '');
        current = null;
        pendingUser = message;
        if (protocolTurnId) {
          const turn = ensureCurrent(protocolTurnId);
          turn.state = 'running';
          turn.process.state = 'running';
        }
        continue;
      }
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
        const startedAtMs = lifecycleTimestampMs(event.time);
        const protocolTurnId = String(event.turnId || '');
        if (protocolTurnId && Number.isSafeInteger(startedAtMs) && !protocolStartedAtMs.has(protocolTurnId)) {
          protocolStartedAtMs.set(protocolTurnId, startedAtMs);
        }
        if (current && current.turnId !== String(event.turnId || '') && !current.final) {
          finalizeProtocol(current.turnId, 'completed');
        }
        if (!current || current.turnId !== String(event.turnId || '')) current = null;
        const turn = ensureCurrent(event.turnId);
        turn.state = 'running';
        turn.process.state = 'running';
      } else {
        const turn = ensureCurrent(event.turnId);
        finalizeProtocol(turn.turnId, state, event.time);
        current = null;
      }
      continue;
    }
    if (event.type === 'summary') {
      const kind = activityKind(event);
      if (!kind) continue;
      const turn = ensureCurrent(event.turnId);
      if (kind === 'diff') {
        const turnDiff = sanitizeTurnDiff(event.turnDiff);
        if (turnDiff && turnDiff.fileCount > 0) turn.turnDiff = turnDiff;
        else if (turnDiff) delete turn.turnDiff;
        continue;
      }
      const timelineEntries = projectPublicTimelineEntries(event, {
        sequence: eventIndex + 1,
        ordinal: eventIndex + 1,
        turnId: turn.turnId,
      });
      turn.timeline.push(...timelineEntries);
      const activityEntries = timelineEntries.length > 0 ? timelineEntries : [null];
      for (const timelineEntry of activityEntries) {
        const projectedChild = Number.isSafeInteger(timelineEntry?.sourceOrdinal) && timelineEntry.sourceOrdinal > 0;
        const activity = {
          id: String((projectedChild ? timelineEntry.id : event.id)
            || `${turn.turnId}-activity-${turn.process.detailActivities.length + 1}`),
          kind,
          state: String(timelineEntry?.state || event.state || 'succeeded'),
          title: sanitizeDisplayText(timelineEntry?.title || event.text) || '活动',
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
          activity.title = `${subagent.name} ${event.subagent.state}`;
        } else {
          if (kind === 'shell' || kind === 'file' || kind === 'web') {
            const displayDetail = safeDisplayDetail(timelineEntry?.displayDetail || event.displayDetail);
            if (displayDetail) activity.displayDetail = displayDetail;
          }
          for (const field of ['operation', 'server', 'tool', 'namespace']) {
            const value = timelineEntry?.[field] ?? event[field];
            if (typeof value === 'string') activity[field] = value;
          }
          if (Number.isFinite(event.durationMs)) activity.durationMs = event.durationMs;
          if (Number.isInteger(event.exitCode)) activity.exitCode = event.exitCode;
          if (typeof event.background === 'boolean') activity.background = event.background;
          if (Number.isSafeInteger(timelineEntry?.sourceOrdinal) && timelineEntry.sourceOrdinal > 0) {
            activity.sourceOrdinal = timelineEntry.sourceOrdinal;
          }
        }
        const activityCount = timelineEntry ? timelineEntry.count : event.count;
        if (Number.isFinite(activityCount)) activity.count = Math.max(0, Number(activityCount));
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
          activity.attachments = event.attachments.map(attachment => (
            copyPrivateAttachmentSource(attachment, { ...attachment })
          ));
        }
        projectTurnActivity(turn.process, activity);
        turn.process.counts[kind] = Number(turn.process.counts[kind] || 0) + 1;
      }
      continue;
    }
    if (event.type === 'message' && event.role === 'assistant' && event.phase === 'final_answer') {
      const message = finalMessage(event, threadId);
      if (!message.text) continue;
      const turn = ensureCurrent(event.turnId);
      turn.final = message;
      const promotedId = String(event.id || '');
      removeMatchingCommentary(turn.process, promotedId);
      if (promotedId) {
        turn.timeline = turn.timeline.filter(entry => !(entry.kind === 'commentary' && entry.id === promotedId));
      }
    }
  }

  if (pendingUser) turns.push(createTurn(threadId, '', pendingUser, turns.length));
  for (const turn of turns) {
    turn.timeline = dedupeAdjacentDesktopNarratives(orderPublicTimeline(turn.timeline), turn.turnId);
    turn.segments = segmentVisibleTimeline(turn.timeline);
  }
  return turns;
}

module.exports = {
  buildTurnViews,
};
