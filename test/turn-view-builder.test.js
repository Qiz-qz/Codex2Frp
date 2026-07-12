'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTurnViews } = require('../lib/events/turn-view-builder');
const { EventReconciler } = require('../lib/events/reconciler');

const THREAD = '11111111-2222-4333-8444-555555555555';

test('builder groups one process card and final answer per main turn', () => {
  const turns = buildTurnViews([
    { type: 'message', role: 'user', text: 'do it', time: '2026-01-01T00:00:00Z' },
    { type: 'turn', state: 'started', turnId: 'turn-1', time: '2026-01-01T00:00:01Z' },
    { type: 'summary', summaryKind: 'plan', text: '已更新执行计划', body: '**Planning**\n<!-- -->', time: '2026-01-01T00:00:02Z' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令', time: '2026-01-01T00:00:03Z' },
    { type: 'message', role: 'assistant', phase: 'final_answer', text: 'done', turnId: 'turn-1', time: '2026-01-01T00:00:04Z' },
    { type: 'turn', state: 'completed', turnId: 'turn-1', time: '2026-01-01T00:00:05Z' },
  ], THREAD);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, 'turn-1');
  assert.equal(turns[0].user.text, 'do it');
  assert.equal(turns[0].process.activities.length, 2);
  assert.equal(turns[0].process.activities[0].kind, 'plan');
  assert.equal(turns[0].process.activities[1].kind, 'shell');
  assert.equal(turns[0].final.text, 'done');
  assert.equal(turns[0].state, 'completed');
});

test('subagent projection includes only safe lifecycle name and state', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-2' },
    {
      type: 'summary', summaryKind: 'subagent', text: 'worker_a 已启用',
      body: 'SECRET_CHILD_BODY',
      subagent: { name: 'worker_a', status: 'enabled', aggregate: { enabled: 1 } },
    },
  ], THREAD);
  const serialized = JSON.stringify(turns);
  assert.equal(serialized.includes('SECRET_CHILD_BODY'), false);
  assert.deepEqual(turns[0].process.activities[0].subagent, {
    name: 'worker_a',
    action: 'enabled',
    state: 'running',
  });
});

test('unknown normalized records fail closed', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-3' },
    { type: 'future-secret', body: 'DO_NOT_SHOW' },
  ], THREAD);
  assert.equal(JSON.stringify(turns).includes('DO_NOT_SHOW'), false);
  assert.equal(turns[0].process.activities.length, 0);
});

test('image view and generation activities preserve count and attachments', () => {
  const viewedAttachments = [
    { name: 'first.png', filePath: 'E:\\protocol-fixtures\\first.png' },
    { name: 'second.jpg', filePath: 'E:\\protocol-fixtures\\second.jpg' },
  ];
  const generatedAttachments = [
    { name: 'generated.webp', filePath: 'E:\\protocol-fixtures\\generated.webp' },
  ];
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-images' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'imageView', turnId: 'turn-images',
      text: '已查看 2 张图像', count: 2, attachments: viewedAttachments,
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'imageGeneration', turnId: 'turn-images',
      text: '已生成 1 张图像', count: 1, attachments: generatedAttachments,
    },
  ], THREAD);

  assert.deepEqual(turns[0].process.activities.map(activity => activity.kind), ['image', 'image']);
  assert.deepEqual(turns[0].process.activities.map(activity => activity.count), [2, 1]);
  assert.deepEqual(
    turns[0].process.activities[0].attachments.map(attachment => attachment.name),
    ['first.png', 'second.jpg'],
  );
  assert.equal(turns[0].process.activities[1].attachments[0].name, 'generated.webp');
  assert.equal(turns[0].process.counts.image, 2);
});

test('builder exposes compact summaries and safe chronological details', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-details' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', turnId: 'turn-details',
      id: 'command-1', state: 'succeeded', text: '已运行命令',
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'file', turnId: 'turn-details',
      id: 'file-1', state: 'succeeded', text: '已更新 2 个文件', count: 2,
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', turnId: 'turn-details',
      id: 'command-2', state: 'failed', text: '命令执行失败',
    },
  ], THREAD);

  const process = turns[0].process;
  assert.deepEqual(process.activities.map(item => item.kind), ['shell', 'file']);
  assert.equal(process.activities[0].title, '已运行 2 条命令 · 1 条失败');
  assert.deepEqual(process.detailActivities.map(item => item.id), ['command-1', 'file-1', 'command-2']);
  assert.equal(process.detailCount, 3);
});

test('builder assigns distinct fallback ids to aggregated chronological details', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-fallback-ids' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令' },
  ], THREAD);

  assert.deepEqual(
    turns[0].process.detailActivities.map(item => item.id),
    ['turn-fallback-ids-activity-1', 'turn-fallback-ids-activity-2', 'turn-fallback-ids-activity-3'],
  );
});

test('builder replaces active reasoning and removes it when the turn becomes terminal', () => {
  const active = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-reasoning' },
    {
      type: 'summary', summaryKind: 'reasoning', turnId: 'turn-reasoning',
      id: 'reasoning-1', state: 'running', text: '正在分析', body: '第一条',
    },
    {
      type: 'summary', summaryKind: 'reasoning', turnId: 'turn-reasoning',
      id: 'reasoning-2', state: 'running', text: '正在分析', body: '第二条',
    },
  ], THREAD);
  assert.equal(active[0].process.activities.filter(item => item.kind === 'reasoning').length, 1);
  assert.equal(Object.hasOwn(active[0].process.detailActivities[0], 'body'), false);

  const terminal = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-reasoning' },
    {
      type: 'summary', summaryKind: 'reasoning', turnId: 'turn-reasoning',
      id: 'reasoning-1', state: 'running', text: '正在分析', body: '第一条',
    },
    { type: 'turn', state: 'failed', turnId: 'turn-reasoning' },
  ], THREAD);
  assert.equal(terminal[0].process.activities.some(item => item.kind === 'reasoning'), false);
  assert.equal(terminal[0].process.detailActivities.some(item => item.kind === 'reasoning'), false);
  assert.equal(terminal[0].process.detailCount, 0);
});

test('final promotion removes only matching commentary identity', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-promotion' },
    { type: 'summary', summaryKind: 'commentary', id: 'message-1', turnId: 'turn-promotion', text: 'Working' },
    { type: 'summary', summaryKind: 'commentary', id: 'message-2', turnId: 'turn-promotion', text: 'Unrelated' },
    { type: 'message', role: 'assistant', phase: 'final_answer', id: 'message-1', turnId: 'turn-promotion', text: 'Done' },
  ], THREAD);
  assert.equal(turns[0].final.text, 'Done');
  assert.equal(turns[0].process.activities.some(item => item.kind === 'commentary'), true);
  assert.equal(turns[0].process.detailActivities.some(item => item.id === 'message-1'), false);
  assert.equal(turns[0].process.detailActivities.some(item => item.id === 'message-2'), true);
});

test('real reconciler normalization preserves agent identity for selective final promotion', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'pipeline-agent-identity' });
  for (const [sequence, id, phase, text] of [
    [1, 'agent-1', 'commentary', 'Working'], [2, 'agent-2', 'commentary', 'Still relevant'],
    [3, 'agent-1', 'final_answer', 'Done'],
  ]) {
    await reconciler.ingestRpcNotification({ sequence, method: sequence === 3 ? 'item/completed' : 'item/started', params: {
      turnId: 'turn-pipeline', item: { type: 'agentMessage', id, phase, text },
    } });
  }
  const turns = buildTurnViews(reconciler.snapshot().events, THREAD);
  assert.equal(turns[0].final.text, 'Done');
  assert.deepEqual(turns[0].process.detailActivities.filter(item => item.kind === 'commentary').map(item => item.id), ['agent-2']);
});

test('agent commentary deltas promote by installed itemId without removing unrelated commentary', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'pipeline-agent-delta-identity' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'item/agentMessage/delta', params: { turnId: 'turn-delta', itemId: 'agent-x', phase: 'commentary', delta: 'Work ' } });
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'item/agentMessage/delta', params: { turnId: 'turn-delta', itemId: 'agent-x', phase: 'commentary', delta: 'continues' } });
  await reconciler.ingestRpcNotification({ sequence: 3, method: 'item/started', params: { turnId: 'turn-delta', item: { type: 'agentMessage', id: 'agent-y', phase: 'commentary', text: 'Unrelated' } } });
  await reconciler.ingestRpcNotification({ sequence: 4, method: 'item/completed', params: { turnId: 'turn-delta', item: { type: 'agentMessage', id: 'agent-x', phase: 'final_answer', text: 'Done' } } });
  const turn = buildTurnViews(reconciler.snapshot().events, THREAD)[0];
  assert.equal(turn.final.text, 'Done');
  assert.deepEqual(turn.process.detailActivities.filter(item => item.kind === 'commentary').map(item => item.id), ['agent-y']);
  assert.equal(turn.process.detailActivities.some(item => item.id === 'agent-x'), false);
  assert.equal(turn.process.activities.filter(item => item.kind === 'commentary').length, 1);
});

test('reconciler metadata reaches strictly projected final activity DTOs', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'pipeline-safe-metadata' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/plan/updated', params: { turnId: 'turn-meta', explanation: 'x', plan: [{ step: 'secret', status: 'completed' }] } });
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'turn/diff/updated', params: { turnId: 'turn-meta', diff: 'diff --git a/private b/private\nnew file mode 100644\n' } });
  await reconciler.ingestRpcNotification({ sequence: 3, method: 'guardianWarning', params: { turnId: 'turn-meta', message: 'private' } });
  await reconciler.ingestRpcNotification({ sequence: 4, method: 'vendor/newThing', params: { turnId: 'turn-meta', itemId: 'vendor-1', nested: { token: 'secret' } } });
  const details = buildTurnViews(reconciler.snapshot().events, THREAD)[0].process.detailActivities;
  assert.deepEqual(details.find(item => item.kind === 'plan').stepCounts, { pending: 0, inProgress: 0, completed: 1 });
  assert.deepEqual(details.find(item => item.kind === 'diff').fileCounts, { total: 1, added: 1, deleted: 0, modified: 0 });
  assert.equal(details.find(item => item.kind === 'notice').noticeKind, 'guardianWarning');
  assert.equal(details.find(item => item.kind === 'unknown').publicType, 'vendor/newThing');
  assert.doesNotMatch(JSON.stringify(details), /private|secret|token|nested/);
});

test('turn DTO preserves safe execution metadata while dropping raw and subagent fields', () => {
  const turns = buildTurnViews([
    { type:'turn', state:'started', turnId:'turn-safe' },
    { type:'summary', summaryKind:'tool', toolKind:'mcp', id:'mcp-safe', turnId:'turn-safe', text:'MCP', state:'succeeded',
      server:'browser', tool:'open', namespace:'public.tools', operation:'openPage', durationMs:1250, exitCode:0, background:true,
      body:'BODY_SECRET', arguments:'ARG_SECRET', output:'OUT_SECRET', payload:'PAYLOAD_SECRET' },
    { type:'summary', summaryKind:'subagent', id:'sub-safe', turnId:'turn-safe', text:'worker', state:'running',
      server:'SECRET', tool:'SECRET', namespace:'SECRET', operation:'SECRET', durationMs:1, exitCode:1, background:true,
      subagent:{ name:'worker', status:'enabled', prompt:'PROMPT_SECRET' } }
  ], THREAD);
  const details = turns[0].process.detailActivities;
  assert.deepEqual(details.find(item => item.id === 'mcp-safe'), {
    id:'mcp-safe', kind:'mcp', state:'succeeded', title:'MCP', server:'browser', tool:'open', namespace:'public.tools',
    operation:'openPage', durationMs:1250, exitCode:0, background:true
  });
  assert.deepEqual(details.find(item => item.id === 'sub-safe').subagent, { name:'worker', action:'enabled', state:'running' });
  assert.equal(JSON.stringify(details).includes('SECRET'), false);
});
