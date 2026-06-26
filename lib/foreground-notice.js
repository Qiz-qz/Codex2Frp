'use strict';

function terminalStatusKey(status = {}) {
  const threadId = String(status.threadId || status.sessionFile || '').trim();
  const turnId = String(status.turnId || status.completedAt || status.updatedAt || status.startedAt || '').trim();
  const state = String(status.status || '').trim();
  const text = String(status.error || status.final || status.preview || '').slice(0, 120);
  return `${threadId}:${state}:${turnId}:${text}`;
}

function isInterruptedStatus(status = {}) {
  const text = String(status.error || status.final || status.preview || status.message || '').toLowerCase();
  return /interrupt|interrupted|abort|aborted|cancel|cancelled|stop|stopped|turn_aborted|终止|中断|取消/.test(text);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}min ${seconds}s` : `${seconds}s`;
}

function normalizeThreadTitle(value, fallback = '当前线程') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function createForegroundNoticeForStatus(status = {}) {
  if (!status || (status.status !== 'complete' && status.status !== 'error')) return null;
  const interrupted = status.status === 'error' && isInterruptedStatus(status);
  const finalStatus = status.status === 'complete' ? 'complete' : interrupted ? 'interrupted' : 'error';
  const duration = formatDuration(status.durationMs);
  const message = finalStatus === 'complete'
    ? `Codex 任务已完成${duration ? `，用时 ${duration}` : ''}。`
    : finalStatus === 'interrupted'
      ? `Codex 任务已终止${duration ? `，运行 ${duration}` : ''}。`
      : `Codex 任务失败${duration ? `，运行 ${duration}` : ''}。`;
  return {
    eventKey: terminalStatusKey(status),
    status: finalStatus,
    tone: finalStatus === 'complete' ? 'status' : 'error',
    title: finalStatus === 'complete' ? '任务完成' : finalStatus === 'interrupted' ? '任务已终止' : '任务失败',
    message,
    threadId: String(status.threadId || '').trim(),
    threadTitle: normalizeThreadTitle(status.threadTitle || status.title || status.name),
    durationMs: Math.max(0, Number(status.durationMs || 0)),
    at: new Date().toISOString(),
  };
}

function getRuntimeStatus(thread = {}) {
  const status = String(thread.runtimeStatus || thread.status || '').toLowerCase().trim();
  if (status) return status;
  return thread.runtimeActive ? 'running' : 'idle';
}

function getRuntimeTurnId(thread = {}) {
  return String(thread.runtimeTurnId || thread.turnId || '').trim();
}

function getRuntimeAt(thread = {}, fallback) {
  return String(thread.runtimeCompletedAt || thread.runtimeUpdatedAt || thread.runtimeStartedAt || thread.updatedAt || thread.createdAt || fallback || new Date().toISOString());
}

function getRuntimeDurationMs(thread = {}, now) {
  const started = Date.parse(thread.runtimeStartedAt || '');
  if (!Number.isFinite(started)) return 0;
  const ended = Date.parse(thread.runtimeCompletedAt || now || '');
  if (!Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

function threadEventKey(thread = {}, runtimeStatus, at) {
  const threadId = String(thread.id || thread.threadId || '').trim();
  const turnId = getRuntimeTurnId(thread);
  return `${threadId}:${runtimeStatus}:${turnId || at || ''}`;
}

function isInterruptedThread(thread = {}) {
  if (String(thread.runtimeTerminalKind || '').toLowerCase() === 'interrupted') return true;
  const text = String(thread.runtimeError || thread.runtimeFinalText || thread.error || thread.final || thread.preview || thread.message || '').toLowerCase();
  return /interrupt|interrupted|abort|aborted|cancel|cancelled|stop|stopped|turn_aborted|终止|中断|取消/.test(text);
}

function createThreadNotice(thread = {}, runtimeStatus, options = {}) {
  const threadId = String(thread.id || thread.threadId || '').trim();
  if (!threadId) return null;
  const at = getRuntimeAt(thread, options.now);
  const durationMs = getRuntimeDurationMs(thread, options.now);
  const duration = formatDuration(durationMs);
  const threadTitle = normalizeThreadTitle(thread.name || thread.title || thread.threadTitle || threadId);
  const base = {
    eventKey: threadEventKey(thread, runtimeStatus, at),
    threadId,
    threadTitle,
    durationMs,
    at,
  };

  if (runtimeStatus === 'running') {
    return {
      ...base,
      status: 'running',
      tone: 'status',
      title: '任务开始',
      message: `“${threadTitle}”开始执行。`,
    };
  }

  if (runtimeStatus === 'complete') {
    return {
      ...base,
      status: 'complete',
      tone: 'status',
      title: '任务完成',
      message: `“${threadTitle}”已完成${duration ? `，用时 ${duration}` : ''}。`,
    };
  }

  if (runtimeStatus === 'error') {
    const interrupted = isInterruptedThread(thread);
    return {
      ...base,
      status: interrupted ? 'interrupted' : 'error',
      tone: 'error',
      title: interrupted ? '任务终止' : '任务失败',
      message: `“${threadTitle}”${interrupted ? '已终止' : '失败'}${duration ? `，用时 ${duration}` : ''}。`,
    };
  }

  return null;
}

function shouldEmitThreadNotice(previousThread, currentThread) {
  const currentStatus = getRuntimeStatus(currentThread);
  if (currentStatus !== 'running' && currentStatus !== 'complete' && currentStatus !== 'error') return false;
  if (!previousThread) return true;

  const previousStatus = getRuntimeStatus(previousThread);
  if (previousStatus !== currentStatus) return true;

  const previousTurnId = getRuntimeTurnId(previousThread);
  const currentTurnId = getRuntimeTurnId(currentThread);
  if (currentTurnId && previousTurnId !== currentTurnId) return true;

  if (currentStatus === 'complete' || currentStatus === 'error') {
    const previousCompletedAt = String(previousThread.runtimeCompletedAt || '');
    const currentCompletedAt = String(currentThread.runtimeCompletedAt || '');
    return !!currentCompletedAt && previousCompletedAt !== currentCompletedAt;
  }

  return false;
}

function createForegroundNoticesForThreadSnapshots(previousThreads = [], currentThreads = [], options = {}) {
  const previousById = new Map();
  for (const thread of previousThreads || []) {
    const id = String(thread && (thread.id || thread.threadId) || '').trim();
    if (id) previousById.set(id, thread);
  }

  const notices = [];
  for (const thread of currentThreads || []) {
    const id = String(thread && (thread.id || thread.threadId) || '').trim();
    if (!id) continue;
    const runtimeStatus = getRuntimeStatus(thread);
    if (!shouldEmitThreadNotice(previousById.get(id), thread)) continue;
    const notice = createThreadNotice(thread, runtimeStatus, options);
    if (notice) notices.push(notice);
  }
  return notices;
}

module.exports = {
  createForegroundNoticeForStatus,
  createForegroundNoticesForThreadSnapshots,
  terminalStatusKey,
};
