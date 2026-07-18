'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  decodeProcessDetailCursor,
  pageProcessDetailActivities,
  processDetailRevision,
} = require('../lib/history/process-detail-pagination');
const { buildTurnViews } = require('../lib/events/turn-view-builder');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function functionSource(name) {
  const start = serverSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const signatureEnd = serverSource.indexOf(') {', start);
  const brace = signatureEnd + 2;
  let depth = 0;
  for (let index = brace; index < serverSource.length; index += 1) {
    if (serverSource[index] === '{') depth += 1;
    if (serverSource[index] === '}') {
      depth -= 1;
      if (depth === 0) return serverSource.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function completedTurnSummarizer() {
  return new Function(
    'processDetailRevision',
    `${functionSource('summarizeCompletedHistoryProcess')}\n${functionSource('summarizeCompletedHistoryTurn')}\nreturn summarizeCompletedHistoryTurn;`,
  )(processDetailRevision);
}

function processWithActivities() {
  return {
    turnId: 'turn-long-process',
    state: 'completed',
    detailActivities: [
      { id: 'one', kind: 'shell', title: '第一条', sourceOrdinal: 1 },
      { id: 'two', kind: 'image', title: '第二条', sourceOrdinal: 2, attachments: [{ url: '/codex/attachment/old-handle' }] },
      { id: 'three', kind: 'file', title: '第三条', sourceOrdinal: 3 },
      { id: 'four', kind: 'shell', title: '第四条', sourceOrdinal: 4 },
      { id: 'five', kind: 'image', title: '第五条', sourceOrdinal: 5 },
    ],
  };
}

test('process detail pages retain original source order and opaque cursor continuity', () => {
  const process = processWithActivities();
  const first = pageProcessDetailActivities(process, { limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['one', 'two']);
  assert.equal(first.detailCount, 5);
  assert.equal(first.hasMore, true);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(decodeProcessDetailCursor(first.nextCursor), { revision: first.revision, offset: 2 });

  const second = pageProcessDetailActivities(process, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.id), ['three', 'four']);
  const final = pageProcessDetailActivities(process, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(final.items.map(item => item.id), ['five']);
  assert.equal(final.hasMore, false);
  assert.equal(final.nextCursor, '');
});

test('process detail revision ignores expiring attachment capability URLs', () => {
  const first = processWithActivities();
  const second = processWithActivities();
  second.detailActivities[1].attachments[0].url = '/codex/attachment/refreshed-handle';
  assert.equal(processDetailRevision(first), processDetailRevision(second));
});

test('process detail revision includes visible file identity metadata', () => {
  const first = processWithActivities();
  first.detailActivities[2] = {
    ...first.detailActivities[2], fileLabel: 'src/first.js', changeKind: 'modified',
  };
  const second = processWithActivities();
  second.detailActivities[2] = {
    ...second.detailActivities[2], fileLabel: 'src/second.js', changeKind: 'renamed',
  };
  assert.notEqual(processDetailRevision(first), processDetailRevision(second));
});

test('process detail pagination rejects a stale revision after a visible source update', () => {
  const process = processWithActivities();
  const first = pageProcessDetailActivities(process, { limit: 2 });
  process.detailActivities[2] = { ...process.detailActivities[2], title: '第三条（更新）' };
  assert.throws(
    () => pageProcessDetailActivities(process, { limit: 2, cursor: first.nextCursor }),
    error => error && error.code === 'PROCESS_DETAIL_CURSOR_STALE',
  );
});

test('process detail pagination accepts a numeric before offset without reordering', () => {
  const page = pageProcessDetailActivities(processWithActivities(), { limit: 2, before: 3 });
  assert.deepEqual(page.items.map(item => item.id), ['four', 'five']);
});

test('completed history summary removes duplicate timeline payload while preserving process metadata', () => {
  const summarize = completedTurnSummarizer();
  const detailActivities = Array.from({ length: 80 }, (_, index) => ({
    id: `detail-${index + 1}`,
    kind: index % 3 === 0 ? 'image' : 'shell',
    title: `操作 ${index + 1}`,
    displayDetail: 'x'.repeat(3200),
    sourceOrdinal: index + 1,
    attachments: [{ name: `image-${index + 1}.png`, url: `/codex/attachment/${'a'.repeat(32)}` }],
  }));
  const full = {
    presentationId: 'presentation-long',
    user: { role: 'user', text: '检查长任务' },
    final: { role: 'assistant', text: '已完成' },
    process: {
      turnId: 'turn-long', state: 'completed', summary: '处理过程',
      activities: [{ kind: 'shell', title: '已运行多个命令', count: 80 }],
      detailActivities,
      detailCount: detailActivities.length,
      counts: { shell: 53, image: 27 },
    },
    timeline: detailActivities.map(item => ({ ...item })),
    segments: [{ kind: 'operations', items: detailActivities.map(item => ({ ...item })) }],
  };
  const summary = summarize(full);
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  assert.equal(Object.hasOwn(summary.process, 'detailActivities'), false);
  assert.equal(Object.hasOwn(summary, 'timeline'), false);
  assert.equal(Object.hasOwn(summary, 'segments'), false);
  assert.equal(summary.process.detailCount, 80);
  assert.deepEqual(summary.process.counts, { shell: 53, image: 27 });
  assert.match(summary.process.detailRevision, /^[a-f0-9]{64}$/);
  assert.ok(summaryBytes < fullBytes * 0.25, `summary ${summaryBytes} B should be <25% of full ${fullBytes} B`);
});

test('latest guided presentation owns the complete ordered process detail before summary paging', () => {
  const turnId = 'turn-guided-detail';
  const turns = buildTurnViews([
    { type: 'message', role: 'user', text: '原始任务', delivery: 'initial', eventId: 'user-original' },
    { type: 'turn', state: 'started', turnId, eventId: 'turn-start' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '先检查环境',
      turnId, eventId: 'commentary-original' },
    { type: 'message', role: 'user', text: '补充引导', delivery: 'steer', turnId,
      eventId: 'user-guide' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令',
      displayDetail: 'npm test', turnId, eventId: 'command-guide' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '命令完成后继续核对',
      turnId, eventId: 'commentary-guide' },
    { type: 'turn', state: 'completed', turnId, eventId: 'turn-complete' },
  ], 'thread-guided-detail');
  const owner = turns[turns.length - 1];
  const summarize = completedTurnSummarizer();
  const summary = summarize(owner);
  const first = pageProcessDetailActivities(owner.process, {
    limit: 2, revision: summary.process.detailRevision,
  });
  const second = pageProcessDetailActivities(owner.process, {
    limit: 2, cursor: first.nextCursor, revision: summary.process.detailRevision,
  });

  assert.equal(owner.presentationId, 'user-guide');
  assert.deepEqual(owner.timeline.map(entry => entry.kind), ['commentary', 'command', 'commentary']);
  assert.deepEqual(owner.segments.map(segment => segment.kind), ['commentary', 'command', 'commentary']);
  assert.deepEqual(first.items.concat(second.items).map(activity => activity.kind),
    ['commentary', 'shell', 'commentary']);
  assert.equal(summary.process.detailCount, 3);
  assert.equal(second.hasMore, false);
});

test('history process detail endpoint is read-only, token-protected, and capability-only for images', () => {
  assert.match(functionSource('handleHistoryProcessDetail'), /isAuthorized\(req\)/);
  assert.match(functionSource('handleHistoryProcessDetail'), /cachedHistoryProcessDetail\(route\.threadId, route\.presentationId, revision\)/);
  assert.match(functionSource('handleHistoryProcessDetail'), /HISTORY_PROCESS_DETAIL_CACHE_MISS/);
  assert.doesNotMatch(functionSource('handleHistoryProcessDetail'), /fullHistory:\s*true|parseCodexThreadHistory/);
  assert.match(functionSource('handleHistoryProcessDetail'), /pageProcessDetailActivities/);
  assert.match(functionSource('enrichHistoryProcessDetail'), /enrichAttachmentList\(activity\.attachments, req, \{ inlineData: false \}\)/);
  assert.match(functionSource('enrichHistoryProcessTimeline'), /timeline[\s\S]*segments/,
    'completed detail response restores the same public narrative and operation segments as a running turn');
  assert.match(functionSource('handleHistoryProcessDetail'), /enrichHistoryProcessTimeline\(cached, req\)/);
  assert.match(functionSource('dispatchRequest'), /historyProcessDetailRoute\(pathname\)[\s\S]*handleHistoryProcessDetail[\s\S]*handleV3ApiRequest/);
});

test('summary compaction is opt-in and leaves active-process detail live', () => {
  const body = functionSource('enrichHistoryTurn');
  assert.match(body, /options\.detail === 'summary'/);
  assert.match(body, /isTerminalHistoryProcess/);
  assert.match(functionSource('summarizeCompletedHistoryProcess'), /detailRevision: processDetailRevision/);
  assert.match(functionSource('enrichHistoryAttachments'), /options\.detail === 'summary'\) cacheHistoryProcessDetails\(history\)/);
  assert.match(functionSource('cacheHistoryProcessDetails'), /historyProcessDetailCache\.set/);
});
