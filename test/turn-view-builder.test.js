'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTurnViews } = require('../lib/events/turn-view-builder');
const { EventReconciler } = require('../lib/events/reconciler');
const { createSessionNormalizer } = require('../lib/events/session-normalizer');
const { getPrivateAttachmentSource, setPrivateAttachmentSource } = require('../lib/events/private-attachment-source');

const THREAD = '11111111-2222-4333-8444-555555555555';

test('generic tool lifecycle never creates a desktop-invisible public activity', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-generic-tool' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'tool', text: '已调用工具',
      turnId: 'turn-generic-tool', eventId: 'wait-call' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'dynamicTool', text: '语义工具',
      namespace: 'public.tools', tool: 'semantic', turnId: 'turn-generic-tool', eventId: 'semantic-tool' },
  ], THREAD)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.kind), ['dynamicTool']);
  assert.deepEqual(turn.segments.map(segment => segment.kind), ['dynamicTool']);
  assert.equal(JSON.stringify(turn).includes('已调用工具'), false);
});

test('attachment-only user message creates a visible turn presentation', () => {
  const turn = buildTurnViews([
    { type: 'message', role: 'user', text: '', sourceKey: 'attachment-only',
      attachments: [{ name: 'only-image.png', url: '/codex/attachment/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] },
  ], THREAD)[0];

  assert.equal(turn.user.text, '');
  assert.deepEqual(turn.user.attachments.map(item => item.name), ['only-image.png']);
});

test('pure internal environment context never enters public turn history', () => {
  const internalText = [
    '<environment_context>',
    '  <current_date>2026-07-16</current_date>',
    '  <subagents>',
    '    <agent>operation_group_audit: Epicurus</agent>',
    '  </subagents>',
    '</environment_context>',
  ].join('\n');
  assert.deepEqual(buildTurnViews([
    { type: 'message', role: 'user', text: internalText, sourceKey: 'internal-environment' },
  ], THREAD), []);

  const realBulletShape = [
    '<environment_context>',
    '  <cwd>E:/workspace</cwd>',
    '  <shell>powershell</shell>',
    '  <current_date>2026-07-16</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>E:/workspace</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>',
    '  <subagents>',
    '    - redacted_task: RedactedAgent',
    '  </subagents>',
    '</environment_context>',
  ].join('\n');
  assert.deepEqual(buildTurnViews([
    { type: 'message', role: 'user', text: realBulletShape, sourceKey: 'internal-environment-real-shape' },
  ], THREAD), [], 'TurnView applies the same strict predicate to the real bullet-list shape');

  const ordinary = buildTurnViews([
    { type: 'message', role: 'user', text: '请解释 environment_context 是什么。', sourceKey: 'ordinary-user' },
  ], THREAD);
  assert.equal(ordinary[0].user.text, '请解释 environment_context 是什么。',
    'an ordinary user message mentioning the context name remains public');

  const goal = buildTurnViews([
    { type: 'message', role: 'user', text: [
      '<codex_internal_context source="goal">',
      '<objective>继续完成目标</objective>',
      '</codex_internal_context>',
    ].join('\n'), sourceKey: 'goal-context' },
  ], THREAD);
  assert.match(goal[0].user.text, /source="goal"/,
    'goal context remains available to the client goal presentation semantics');

  assert.equal(buildTurnViews([
    { type: 'message', role: 'user', text: `${internalText}\n这是用户主动附加的正文。`, sourceKey: 'quoted-user' },
  ], THREAD)[0].user.text, `${internalText}\n这是用户主动附加的正文。`,
  'a user-authored message containing an environment example is not broadly deleted');

  for (const text of [
    '<environment_context>请解释这个标签</environment_context>',
    '<environment_context>\n  <example>用户提供的 XML 示例</example>\n</environment_context>',
  ]) {
    assert.equal(buildTurnViews([
      { type: 'message', role: 'user', text, sourceKey: `ordinary-envelope-${text.length}` },
    ], THREAD)[0].user.text, text,
    'a complete root-shaped user example without the Codex schema remains public');
  }
});

test('web search keeps only its safe expandable query detail', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-web-detail' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'search', text: '已搜索网页',
      displayDetail: 'site:example.test current schema', output: 'PRIVATE_RESULT',
      turnId: 'turn-web-detail', eventId: 'web-search' },
  ], THREAD)[0];

  assert.equal(turn.timeline[0].displayDetail, 'site:example.test current schema');
  assert.equal(turn.segments[0].items[0].displayDetail, 'site:example.test current schema');
  assert.equal(turn.process.detailActivities[0].displayDetail, 'site:example.test current schema');
  assert.doesNotMatch(JSON.stringify(turn), /PRIVATE_RESULT/);
});

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

test('completed turn and process expose the exact lifecycle duration used by the desktop', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-duration', time: '2026-07-14T23:32:24.323Z' },
    { type: 'message', role: 'assistant', phase: 'final_answer', text: 'done', turnId: 'turn-duration', time: '2026-07-14T23:38:58.300Z' },
    { type: 'turn', state: 'completed', turnId: 'turn-duration', time: '2026-07-14T23:38:58.398Z' },
  ], THREAD);

  assert.equal(turns[0].durationMs, 394075);
  assert.equal(turns[0].process.durationMs, 394075);
});

test('turn duration is omitted unless both lifecycle timestamps form a safe nonnegative interval', () => {
  const invalid = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-negative', time: '2026-07-14T23:38:58.398Z' },
    { type: 'turn', state: 'completed', turnId: 'turn-negative', time: '2026-07-14T23:32:24.323Z' },
    { type: 'turn', state: 'started', turnId: 'turn-missing-end', time: '2026-07-14T23:32:24.323Z' },
  ], THREAD);

  for (const turn of invalid) {
    assert.equal(Object.hasOwn(turn, 'durationMs'), false);
    assert.equal(Object.hasOwn(turn.process, 'durationMs'), false);
  }
});

test('rehydrated history reconstructs the same duration from persisted lifecycle timestamps', () => {
  const entries = [
    { item: { type: 'event_msg', timestamp: '2026-07-14T23:32:24.323Z', payload: { type: 'task_started', turn_id: 'turn-history-duration' } }, nextOffset: 1 },
    { item: { type: 'event_msg', timestamp: '2026-07-14T23:38:58.398Z', payload: { type: 'task_complete', turn_id: 'turn-history-duration' } }, nextOffset: 2 },
  ];
  const reconciler = new EventReconciler({ serverInstanceId: 'history-duration' });

  reconciler.rehydrate(entries);
  const first = buildTurnViews(reconciler.snapshot().events, THREAD)[0];
  reconciler.rehydrate(entries);
  const second = buildTurnViews(reconciler.snapshot().events, THREAD)[0];

  assert.equal(first.durationMs, 394075);
  assert.equal(first.process.durationMs, 394075);
  assert.equal(second.durationMs, first.durationMs);
  assert.equal(second.process.durationMs, first.process.durationMs);
});

test('authoritative turn diff is a separate desktop card and never duplicates process operations', async () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'turn-diff-view' });
  await reconciler.ingestRpcNotification({ sequence: 1, method: 'turn/started', params: {
    turn: { id: 'turn-diff-view' },
  } });
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'turn/diff/updated', params: {
    turnId: 'turn-diff-view',
    diff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n',
  } });
  const turn = buildTurnViews(reconciler.snapshot().events, 'thread-diff-view')[0];
  assert.deepEqual(turn.turnDiff, reconciler.snapshot().events.find(event => event.toolKind === 'diff').turnDiff);
  assert.equal(turn.timeline.some(entry => entry.kind === 'file'), false);
  assert.equal(turn.process.detailActivities.some(activity => activity.kind === 'diff'), false);
});

test('each initial or steer user message opens one stable presentation segment on the same protocol turn', () => {
  const protocolTurnId = 'turn-steer-presentations';
  const runningEvents = [
    { type: 'message', role: 'user', text: '原始任务', delivery: 'initial', eventId: 'user-initial' },
    { type: 'turn', state: 'started', turnId: protocolTurnId, eventId: 'turn-start' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '初始说明',
      turnId: protocolTurnId, eventId: 'commentary-initial' },
    { type: 'message', role: 'user', text: '补充引导一', delivery: 'steer', turnId: protocolTurnId,
      eventId: 'user-steer-1' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '引导一后的说明',
      turnId: protocolTurnId, eventId: 'commentary-steer-1' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令',
      turnId: protocolTurnId, eventId: 'command-steer-1' },
    { type: 'message', role: 'user', text: '补充引导二', delivery: 'steer', turnId: protocolTurnId,
      eventId: 'user-steer-2' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '引导二后的说明',
      turnId: protocolTurnId, eventId: 'commentary-steer-2' },
    { type: 'message', role: 'assistant', phase: 'final_answer', text: '完成', turnId: protocolTurnId,
      eventId: 'final-steer-2' },
  ];
  const runningTurns = buildTurnViews(runningEvents, THREAD);

  assert.equal(runningTurns.length, 3);
  assert.deepEqual(runningTurns.map(turn => turn.state), ['running', 'running', 'running']);
  assert.deepEqual(runningTurns.map(turn => turn.process.state), ['running', 'running', 'running']);
  assert.equal(runningTurns[0].process.detailActivities.some(activity => activity.kind === 'commentary'), true);
  assert.deepEqual(runningTurns[1].process.detailActivities.map(activity => activity.kind), ['commentary', 'shell']);

  const turns = buildTurnViews([
    ...runningEvents,
    { type: 'turn', state: 'completed', turnId: protocolTurnId, eventId: 'turn-complete' },
  ], THREAD);

  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map(turn => turn.turnId), [protocolTurnId, protocolTurnId, protocolTurnId]);
  assert.deepEqual(turns.map(turn => turn.presentationId), ['user-initial', 'user-steer-1', 'user-steer-2']);
  assert.equal(new Set(turns.map(turn => turn.presentationId)).size, 3);
  assert.deepEqual(turns.map(turn => turn.user.text), ['原始任务', '补充引导一', '补充引导二']);
  assert.deepEqual(
    turns.map(turn => turn.timeline.filter(entry => entry.kind === 'commentary')
      .map(entry => entry.publicNarrative)),
    [['初始说明'], ['引导一后的说明'], ['初始说明', '引导一后的说明', '引导二后的说明']],
  );
  assert.deepEqual(turns[1].process.detailActivities.map(activity => activity.kind), ['commentary', 'shell']);
  assert.deepEqual(turns[2].segments.map(segment => segment.kind),
    ['commentary', 'commentary', 'command', 'commentary']);
  assert.deepEqual(turns[2].process.detailActivities.map(activity => activity.kind),
    ['commentary', 'commentary', 'shell', 'commentary']);
  assert.equal(turns[2].process.detailCount, 4);
  assert.equal(turns[2].final.text, '完成');
  assert.deepEqual(turns.map(turn => turn.state), ['completed', 'completed', 'completed']);
});

test('task_started before the first current user record does not create an empty duplicate presentation', () => {
  const turnId = 'turn-current-first-user';
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId, eventId: 'turn-start' },
    { type: 'message', role: 'user', text: '真实首条任务', delivery: 'initial', turnId,
      eventId: 'first-user' },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理', body: '进展', turnId,
      eventId: 'commentary' },
    { type: 'message', role: 'assistant', phase: 'final_answer', text: '完成', turnId,
      eventId: 'final' },
    { type: 'turn', state: 'completed', turnId, eventId: 'turn-complete' },
  ], THREAD);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.text, '真实首条任务');
  assert.equal(turns[0].user.showGuidedBadge, false);
  assert.equal(turns[0].final.text, '完成');
});

test('paired raw user representations form one steer presentation and merge safe file metadata', () => {
  const turnId = 'turn-paired-user-presentation';
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId },
    { type: 'message', role: 'user', text: '检查附件', delivery: 'steer', turnId,
      sourceKey: 'paired-user-source', attachments: [{ name: 'spec.txt' }] },
    { type: 'message', role: 'user', text: '检查附件', delivery: 'queued', turnId: '',
      sourceKey: 'paired-user-source', attachments: [{ name: 'image.png' }] },
    { type: 'summary', summaryKind: 'commentary', text: '正在处理请求', body: '附件已读取',
      turnId, eventId: 'commentary-after-pair' },
  ], THREAD);

  assert.equal(turns.length, 1, 'the current first user message fills the running shell without a desktop-invisible duplicate');
  assert.equal(turns.filter(turn => turn.user?.text === '检查附件').length, 1);
  const userTurn = turns.find(turn => turn.user?.text === '检查附件');
  assert.equal(userTurn.turnId, turnId);
  assert.equal(userTurn.presentationId, 'paired-user-source');
  assert.deepEqual(userTurn.user.attachments.map(item => item.name), ['spec.txt', 'image.png']);
  assert.deepEqual(userTurn.timeline.map(entry => entry.publicNarrative), ['附件已读取']);
  assert.equal(JSON.stringify(userTurn).includes('C:/'), false);
});

test('user presentation preserves two capability attachments with one basename and different private sources', () => {
  const firstPath = 'E:\\ProtocolFixtures\\first\\same.png';
  const secondPath = 'E:\\ProtocolFixtures\\second\\same.png';
  const attachments = [
    setPrivateAttachmentSource({ name: 'same.png', url: '/codex/attachment/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, firstPath),
    setPrivateAttachmentSource({ name: 'same.png', url: '/codex/attachment/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, secondPath),
  ];
  const turn = buildTurnViews([
    { type: 'message', role: 'user', text: '比较图片', sourceKey: 'same-basename-user', attachments },
  ], THREAD)[0];

  assert.equal(turn.user.attachments.length, 2);
  assert.deepEqual(turn.user.attachments.map(item => item.url), attachments.map(item => item.url));
  assert.deepEqual(turn.user.attachments.map(getPrivateAttachmentSource), [firstPath, secondPath]);
  assert.equal(JSON.stringify(turn).includes('ProtocolFixtures'), false);
});

test('running commentary stays in an ordered public timeline while final stays in main messages', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-timeline', order: 1, eventId: 'turn-start' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary', body: 'Inspecting current schema',
      text: '正在处理请求', state: 'running', turnId: 'turn-timeline', order: 2, eventId: 'commentary-1',
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '正在运行命令', state: 'running',
      turnId: 'turn-timeline', order: 3, eventId: 'command-1', body: 'TOOL_BODY_PRIVATE',
      arguments: 'TOOL_ARGUMENTS_PRIVATE', output: 'TOOL_OUTPUT_PRIVATE', payload: 'TOOL_PAYLOAD_PRIVATE',
    },
    {
      type: 'message', role: 'assistant', phase: 'final_answer', text: 'done', id: 'final-1',
      turnId: 'turn-timeline', order: 4, eventId: 'final-event-1',
    },
  ], THREAD);

  assert.deepEqual(turns[0].timeline.map(entry => entry.kind), ['commentary', 'command']);
  assert.deepEqual(turns[0].timeline.map(entry => entry.sequence), [2, 3]);
  assert.equal(turns[0].timeline[0].publicNarrative, 'Inspecting current schema');
  assert.deepEqual(turns[0].timeline[0].provenance, {
    source: 'projected', eventId: 'commentary-1', ordinal: 2,
  });
  assert.equal(turns[0].final.text, 'done');
  assert.equal(turns[0].timeline.some(entry => entry.kind === 'finalAnswer'), false);
  assert.deepEqual(turns[0].segments.map(segment => segment.kind), ['commentary', 'command']);
  assert.doesNotMatch(JSON.stringify(turns[0].timeline), /TOOL_(?:BODY|ARGUMENTS|OUTPUT|PAYLOAD)_PRIVATE/);
});

test('desktop duplicate commentary representations collapse only while adjacent', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-desktop-duplicate' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Visible desktop checkpoint', text: '正在处理请求',
      turnId: 'turn-desktop-duplicate', order: 2,
    },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Visible desktop checkpoint', text: '正在处理请求', id: 'msg-canonical',
      turnId: 'turn-desktop-duplicate', order: 3,
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', text: '已运行命令',
      id: 'command-boundary', turnId: 'turn-desktop-duplicate', order: 4,
    },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Visible desktop checkpoint', text: '正在处理请求',
      turnId: 'turn-desktop-duplicate', order: 5,
    },
  ], THREAD)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.kind), ['commentary', 'command', 'commentary']);
  assert.deepEqual(turn.timeline.map(entry => entry.publicNarrative || ''), [
    'Visible desktop checkpoint', '', 'Visible desktop checkpoint',
  ]);
  assert.deepEqual(turn.segments.map(segment => [segment.kind, segment.items.length]), [
    ['commentary', 1], ['command', 1], ['commentary', 1],
  ]);
});

test('raw installed commentary twins normalize to one canonical desktop narrative', () => {
  const normalizer = createSessionNormalizer();
  const raw = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-raw-desktop-twin' } },
    {
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'Visible installed checkpoint' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message', id: 'msg-installed-canonical', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Visible installed checkpoint' }],
      },
    },
  ];
  const normalized = raw.map(item => normalizer.normalize(item)).filter(Boolean);
  const turn = buildTurnViews(normalized, THREAD)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.id), ['msg-installed-canonical']);
  assert.deepEqual(turn.timeline.map(entry => entry.publicNarrative), ['Visible installed checkpoint']);
});

test('reconciled installed commentary twins keep synthetic provenance but one desktop narrative', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'reconciled-desktop-twin' });
  reconciler.ingestFileEntries([
    {
      item: {
        type: 'event_msg', _stableOrder: 1,
        payload: { type: 'task_started', turn_id: 'turn-reconciled-desktop-twin' },
      },
      nextOffset: 1,
    },
    {
      item: {
        type: 'event_msg', _stableOrder: 2,
        payload: { type: 'agent_message', phase: 'commentary', message: 'Visible reconciled checkpoint' },
      },
      nextOffset: 2,
    },
    {
      item: {
        type: 'response_item', _stableOrder: 3,
        payload: {
          type: 'message', id: 'msg-reconciled-canonical', role: 'assistant', phase: 'commentary',
          content: [{ type: 'output_text', text: 'Visible reconciled checkpoint' }],
        },
      },
      nextOffset: 3,
    },
  ]);

  const snapshot = reconciler.snapshot();
  const commentary = snapshot.events.filter(event => event.summaryKind === 'commentary');
  assert.equal(commentary.length, 1, 'reconciler replaces the fallback before publishing a snapshot');
  assert.equal(commentary[0].id, 'msg-reconciled-canonical');
  assert.match(commentary[0].eventId, /^[a-f0-9]{64}$/,
    'canonical content keeps the fallback event identity so realtime clients upsert in place');

  const turn = buildTurnViews(snapshot.events, THREAD)[0];
  assert.deepEqual(turn.timeline.map(entry => entry.id), ['msg-reconciled-canonical']);
  assert.deepEqual(turn.timeline.map(entry => entry.publicNarrative), ['Visible reconciled checkpoint']);
  assert.deepEqual(turn.timeline.map(entry => entry.provenance.source), ['file']);
  assert.deepEqual(turn.timeline.map(entry => entry.provenance.eventId), [commentary[0].eventId]);
});

test('desktop narrative dedupe prefers either canonical order but preserves independent canonical messages', () => {
  const canonicalFirst = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-canonical-first' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Same visible text', id: 'msg-canonical-first', turnId: 'turn-canonical-first', order: 1,
    },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Same visible text', turnId: 'turn-canonical-first', order: 2,
    },
  ], THREAD)[0];
  assert.deepEqual(canonicalFirst.timeline.map(entry => entry.id), ['msg-canonical-first']);

  const independentCanonical = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-independent-canonical' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'User intentionally repeated this', id: 'msg-independent-one',
      turnId: 'turn-independent-canonical', order: 1,
    },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'User intentionally repeated this', id: 'msg-independent-two',
      turnId: 'turn-independent-canonical', order: 2,
    },
  ], THREAD)[0];
  assert.deepEqual(independentCanonical.timeline.map(entry => entry.id), [
    'msg-independent-one', 'msg-independent-two',
  ]);

  const independentFallbacks = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-independent-fallbacks' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Two real fallback rows', turnId: 'turn-independent-fallbacks', order: 1,
    },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Two real fallback rows', turnId: 'turn-independent-fallbacks', order: 2,
    },
  ], THREAD)[0];
  assert.equal(independentFallbacks.timeline.length, 2,
    'same-text fallback rows remain distinct without a canonical twin');

  const differentKinds = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-different-narrative-kinds' },
    {
      type: 'summary', summaryKind: 'commentary', phase: 'commentary',
      body: 'Shared visible wording', turnId: 'turn-different-narrative-kinds', order: 1,
    },
    {
      type: 'summary', summaryKind: 'plan', phase: 'plan',
      body: 'Shared visible wording', id: 'plan-canonical',
      turnId: 'turn-different-narrative-kinds', order: 2,
    },
  ], THREAD)[0];
  assert.deepEqual(differentKinds.timeline.map(entry => entry.kind), ['commentary', 'plan']);
});

test('unmarked legacy reasoning cannot enter the public desktop timeline', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-private-reasoning' },
    {
      type: 'summary', summaryKind: 'reasoning', body: 'PRIVATE_UNMARKED_REASONING',
      id: 'reasoning-unmarked', turnId: 'turn-private-reasoning', order: 1,
    },
    {
      type: 'summary', summaryKind: 'reasoning', phase: 'reasoning_summary',
      body: 'Visible marked summary', id: 'reasoning-marked', turnId: 'turn-private-reasoning', order: 2,
    },
  ], THREAD)[0];
  assert.deepEqual(turn.timeline.map(entry => entry.id), ['reasoning-marked']);
  assert.equal(JSON.stringify(turn.timeline).includes('PRIVATE_UNMARKED_REASONING'), false);
});

test('timeline exposes only allowlisted public narratives and safe lifecycle metadata', () => {
  const privateCanary = 'PRIVATE_TIMELINE_CANARY';
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-private-timeline' },
    {
      type: 'summary', summaryKind: 'reasoning', phase: 'reasoning_summary', body: 'Visible reasoning summary',
      text: '正在分析请求', turnId: 'turn-private-timeline', id: 'reasoning-public',
    },
    {
      type: 'summary', summaryKind: 'plan', phase: 'plan', body: 'Run focused tests',
      text: '已更新执行计划', turnId: 'turn-private-timeline', id: 'plan-public',
    },
    {
      type: 'summary', summaryKind: 'subagent', text: 'worker running', body: privateCanary,
      turnId: 'turn-private-timeline', id: 'subagent-public',
      subagent: { name: 'worker', state: 'running', prompt: privateCanary, output: privateCanary },
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'imageView', text: 'Viewed image',
      turnId: 'turn-private-timeline', id: 'image-public', count: 1,
      attachments: [{ name: 'safe.png', filePath: `E:\\private\\${privateCanary}.png` }],
    },
  ], THREAD)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.kind), ['reasoningSummary', 'plan', 'subagent', 'image']);
  assert.equal(turn.timeline[0].publicNarrative, 'Visible reasoning summary');
  assert.equal(turn.timeline[1].publicNarrative, 'Run focused tests');
  assert.equal(Object.hasOwn(turn.timeline[2], 'publicNarrative'), false);
  assert.deepEqual(turn.timeline[2].subagent, { name: 'worker', state: 'running' });
  assert.equal(Object.hasOwn(turn.timeline[3], 'publicNarrative'), false);
  assert.doesNotMatch(JSON.stringify(turn.timeline), new RegExp(privateCanary));
  assert.equal(JSON.stringify(turn.timeline).includes('filePath'), false);
});

test('equal source sequences preserve their original visible order', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-equal-order' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', text: 'first', id: 'z-first', order: 7 },
    { type: 'summary', summaryKind: 'tool', toolKind: 'file', text: 'second', id: 'a-second', order: 7 },
  ], THREAD)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.id), ['z-first', 'a-second']);
});

test('reconciler feed preserves equal-sequence source order through timeline projection', () => {
  const reconciler = new EventReconciler({ serverInstanceId: 'pipeline-equal-source-order' });
  reconciler.ingestFileEntries([
    { item: { type: 'response_item', _stableOrder: 7, payload: {
      type: 'commandExecution', id: 'z-first', lifecycle_state: 'running',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-equal-pipeline' },
    } }, nextOffset: 7 },
    { item: { type: 'response_item', _stableOrder: 7, payload: {
      type: 'commandExecution', id: 'a-second', lifecycle_state: 'running',
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-equal-pipeline' },
    } }, nextOffset: 7 },
  ]);

  const snapshot = reconciler.snapshot();
  assert.deepEqual(snapshot.events.map(event => event.id), ['z-first', 'a-second']);
  assert.deepEqual(snapshot.events.map(event => event.sourceOrdinal), [1, 2]);
  const timeline = buildTurnViews(snapshot.events, THREAD)[0].timeline;
  assert.deepEqual(timeline.map(entry => entry.id), ['z-first', 'a-second']);
  assert.deepEqual(timeline.map(entry => entry.provenance.ordinal), [1, 2]);
});

test('desktop command details and safe tool tokens agree across snapshot, history timeline, and grouped items', () => {
  const turnId = 'turn-desktop-operation-details';
  const raw = [
    { type: 'event_msg', _stableOrder: 1, payload: { type: 'task_started', turn_id: turnId } },
    { type: 'response_item', _stableOrder: 2, payload: {
      type: 'commandExecution', id: 'command-a', status: 'completed', command: 'rg -n alpha src',
      exitCode: 0, background: false,
      cwd: 'E:\\PRIVATE_CWD_A', aggregatedOutput: 'PRIVATE_OUTPUT_A', arguments: { token: 'PRIVATE_ARGUMENT_A' },
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: 'response_item', _stableOrder: 3, payload: {
      type: 'commandExecution', id: 'command-b', status: 'completed',
      commandActions: [{ type: 'run', command: 'Get-Content README.md' }],
      cwd: 'E:\\PRIVATE_CWD_B', result: { content: 'PRIVATE_RESULT_B' },
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: 'response_item', _stableOrder: 4, payload: {
      type: 'message', id: 'commentary-boundary', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Visible boundary' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: 'response_item', _stableOrder: 5, payload: {
      type: 'commandExecution', id: 'command-c', status: 'completed', command: 'node --test focused.test.js',
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: 'event_msg', _stableOrder: 6, payload: {
      type: 'mcp_tool_call_end', call_id: 'mcp-safe',
      invocation: { server: 'browser', tool: 'open', arguments: {
        title: 'MCP', secret: 'PRIVATE_MCP_ARGUMENT',
      } },
      result: { Ok: { content: 'PRIVATE_MCP_RESULT', _meta: {
        'codex/toolSurface': { kind: 'computerUse', app: 'PRIVATE_APP_PATH' },
      } } },
    } },
    { type: 'response_item', _stableOrder: 7, payload: {
      type: 'dynamicToolCall', id: 'dynamic-safe', status: 'completed', namespace: 'public.tools', tool: 'inspect',
      arguments: { secret: 'PRIVATE_DYNAMIC_ARGUMENT' }, contentItems: [{ text: 'PRIVATE_DYNAMIC_OUTPUT' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: 'event_msg', _stableOrder: 8, payload: {
      type: 'sub_agent_activity', event_id: 'subagent-safe', kind: 'started', agent_path: '/root/safe_worker',
      prompt: 'PRIVATE_SUBAGENT_PROMPT', output: 'PRIVATE_SUBAGENT_OUTPUT', displayDetail: 'PRIVATE_SUBAGENT_DETAIL',
    } },
  ].map((item, index) => ({ item, nextOffset: index + 1 }));
  const reconciler = new EventReconciler({ serverInstanceId: 'desktop-operation-details' });
  reconciler.rehydrate(raw);

  const snapshot = reconciler.snapshot();
  const commandEvents = snapshot.events.filter(event => event.toolKind === 'command');
  assert.deepEqual(commandEvents.map(event => event.displayDetail), [
    'rg -n alpha src', 'Get-Content README.md', 'node --test focused.test.js',
  ]);
  const mcpEvent = snapshot.events.find(event => event.toolKind === 'mcp');
  const dynamicEvent = snapshot.events.find(event => event.toolKind === 'dynamicTool');
  assert.deepEqual({ server: mcpEvent.server, tool: mcpEvent.tool, surfaceKind: mcpEvent.surfaceKind },
    { server: 'browser', tool: 'open', surfaceKind: 'computerUse' });
  assert.deepEqual({ namespace: dynamicEvent.namespace, tool: dynamicEvent.tool },
    { namespace: 'public.tools', tool: 'inspect' });

  const turn = buildTurnViews(snapshot.events, THREAD)[0];
  assert.deepEqual(turn.segments.map(segment => [segment.kind, segment.count]), [
    ['command', 2], ['commentary', 1], ['command', 1], ['mcp', 1], ['dynamicTool', 1], ['subagent', 1],
  ]);
  assert.deepEqual(turn.timeline.filter(entry => entry.kind === 'command').map(entry => entry.displayDetail),
    commandEvents.map(event => event.displayDetail));
  assert.equal(turn.timeline.find(entry => entry.kind === 'mcp').surfaceKind, 'computerUse');
  assert.equal(turn.segments.find(segment => segment.kind === 'mcp').items[0].surfaceKind, 'computerUse');
  assert.equal(turn.process.activities.find(activity => activity.kind === 'mcp').surfaceKind, 'computerUse');
  assert.equal(JSON.stringify(turn).includes('PRIVATE_APP_PATH'), false);
  assert.deepEqual({ exitCode: turn.timeline[0].exitCode, background: turn.timeline[0].background },
    { exitCode: 0, background: false });
  assert.deepEqual(turn.segments.filter(segment => segment.kind === 'command')
    .map(segment => segment.items.map(item => item.displayDetail)), [
    ['rg -n alpha src', 'Get-Content README.md'], ['node --test focused.test.js'],
  ]);
  assert.equal(turn.segments[0].items[0].exitCode, 0);
  assert.equal(turn.segments[0].items[0].background, false);
  assert.deepEqual(turn.process.detailActivities.filter(activity => activity.kind === 'shell')
    .map(activity => activity.displayDetail), [
    'rg -n alpha src', 'Get-Content README.md', 'node --test focused.test.js',
  ]);
  assert.deepEqual({ server: turn.segments[3].items[0].server, tool: turn.segments[3].items[0].tool },
    { server: 'browser', tool: 'open' });
  assert.deepEqual({ namespace: turn.segments[4].items[0].namespace, tool: turn.segments[4].items[0].tool },
    { namespace: 'public.tools', tool: 'inspect' });
  assert.doesNotMatch(JSON.stringify({ snapshot, turn }),
    /PRIVATE_CWD|PRIVATE_OUTPUT|PRIVATE_ARGUMENT|PRIVATE_RESULT|PRIVATE_MCP|PRIVATE_DYNAMIC|PRIVATE_SUBAGENT/);
});

test('multi exec details become stable singular timeline, process, and segment children', () => {
  const turnId = 'turn-multi-exec-details';
  const raw = [
    { type: 'event_msg', _stableOrder: 1, payload: { type: 'task_started', turn_id: turnId } },
    { type: 'response_item', _stableOrder: 2, payload: {
      type: 'custom_tool_call', id: 'outer-multi-exec', call_id: 'outer-multi-exec-call',
      name: 'exec', status: 'completed',
      input: 'const results = await Promise.all([tools.shell_command({command: "Get-Date"}), tools.shell_command({command: "Get-Date"}), tools.shell_command({command: "Get-Location"})]); results.forEach(text);',
      output: 'PRIVATE_MULTI_OUTPUT', arguments: { secret: 'PRIVATE_MULTI_ARGUMENT' },
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
  ].map((item, index) => ({ item, nextOffset: index + 1 }));
  const reconciler = new EventReconciler({ serverInstanceId: 'multi-exec-details' });
  reconciler.rehydrate(raw);

  const snapshot = reconciler.snapshot();
  const outer = snapshot.events.find(event => event.id === 'outer-multi-exec');
  assert.deepEqual(outer.displayDetails, ['Get-Date', 'Get-Date', 'Get-Location']);
  assert.equal(outer.displayDetail, undefined);
  assert.equal(outer.count, 3);

  const turn = buildTurnViews(snapshot.events, THREAD)[0];
  const expectedIds = [
    'outer-multi-exec:detail:1', 'outer-multi-exec:detail:2', 'outer-multi-exec:detail:3',
  ];
  assert.deepEqual(turn.timeline.map(entry => entry.id), expectedIds);
  assert.deepEqual(turn.timeline.map(entry => entry.displayDetail), ['Get-Date', 'Get-Date', 'Get-Location']);
  assert.deepEqual(turn.timeline.map(entry => entry.sourceOrdinal), [1, 2, 3]);
  assert.deepEqual(turn.timeline.map(entry => entry.count), [1, 1, 1]);
  assert.ok(turn.timeline.every(entry => !Object.hasOwn(entry, 'displayDetails')));
  assert.ok(turn.timeline.every(entry => entry.provenance.eventId === 'outer-multi-exec'));

  assert.equal(turn.segments.length, 1);
  assert.equal(turn.segments[0].kind, 'command');
  assert.equal(turn.segments[0].count, 3);
  assert.deepEqual(turn.segments[0].items.map(item => item.id), expectedIds);
  assert.deepEqual(turn.segments[0].items.map(item => item.sourceOrdinal), [1, 2, 3]);
  assert.deepEqual(turn.process.detailActivities.map(activity => activity.id), expectedIds);
  assert.deepEqual(turn.process.detailActivities.map(activity => activity.displayDetail),
    ['Get-Date', 'Get-Date', 'Get-Location']);
  assert.deepEqual(turn.process.detailActivities.map(activity => activity.sourceOrdinal), [1, 2, 3]);
  assert.equal(turn.process.activities[0].count, 3);
  assert.doesNotMatch(JSON.stringify({ snapshot, turn }), /PRIVATE_MULTI/);
});

test('arbitrary invalid raw display detail arrays fail closed without claiming nested children', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-invalid-multi-array' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', id: 'invalid-outer',
      state: 'succeeded', text: '已运行命令', count: 2,
      displayDetails: ['Get-Date', { command: 'PRIVATE_OBJECT_COMMAND', workdir: 'PRIVATE_OBJECT_CWD' }],
    },
  ], THREAD)[0];

  assert.equal(turn.timeline.length, 1);
  assert.equal(turn.timeline[0].id, 'invalid-outer');
  assert.equal(turn.timeline[0].displayDetail, undefined);
  assert.equal(turn.timeline[0].displayDetails, undefined);
  assert.equal(turn.timeline[0].count, undefined);
  assert.equal(turn.segments[0].count, 1);
  assert.equal(turn.process.detailActivities[0].count, undefined);
  assert.doesNotMatch(JSON.stringify(turn), /PRIVATE_OBJECT|\[object Object\]/);
});

test('multi command children obey visible commentary adjacency boundaries', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-multi-adjacency' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', id: 'outer-before',
      state: 'succeeded', text: '已运行命令', count: 2, displayDetails: ['before-1', 'before-2'],
    },
    {
      type: 'summary', summaryKind: 'commentary', id: 'visible-boundary', state: 'succeeded',
      text: '正在处理请求', body: 'Visible boundary', phase: 'commentary',
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', id: 'outer-after',
      state: 'succeeded', text: '已运行命令', count: 2, displayDetails: ['after-1', 'after-2'],
    },
  ], THREAD)[0];

  assert.deepEqual(turn.segments.map(segment => [segment.kind, segment.count]), [
    ['command', 2], ['commentary', 1], ['command', 2],
  ]);
  assert.deepEqual(turn.segments[0].items.map(item => item.id),
    ['outer-before:detail:1', 'outer-before:detail:2']);
  assert.deepEqual(turn.segments[2].items.map(item => item.id),
    ['outer-after:detail:1', 'outer-after:detail:2']);
  assert.deepEqual(turn.process.activities.map(activity => [activity.kind, activity.count]), [
    ['shell', 2], ['commentary', 1], ['shell', 2],
  ]);
});

test('real nested exec shapes preserve narrative boundaries, replace patch lifecycle, and omit unknown rows', () => {
  const turnId = 'turn-real-nested-exec-shapes';
  const metadata = { internal_chat_message_metadata_passthrough: { turn_id: turnId } };
  const mappedInput = 'const cmds=[{command:"Get-Date"},{command:"Get-Location"}];'
    + 'const results=await Promise.all(cmds.map(command=>tools.shell_command(command)));'
    + 'results.forEach((result,index)=>{text(`item ${index+1}`);text(result);});';
  const deferredInput = 'const first=await tools.shell_command({command:"git status"});'
    + 'const second=await tools.shell_command({command:"git diff"});'
    + 'text("first");text(first);text("second");text(second);';
  const patchInput = 'const patch="*** Begin Patch\\n*** Update File: E:/PRIVATE_LIFECYCLE/file.js\\n@@\\n-SECRET_OLD\\n+SECRET_NEW\\n*** End Patch";text(await tools.apply_patch(patch));';
  const raw = [
    { type: 'event_msg', _stableOrder: 1, payload: { type: 'task_started', turn_id: turnId } },
    { type: 'response_item', _stableOrder: 2, payload: {
      type: 'custom_tool_call', id: 'mapped-before', name: 'exec', status: 'completed', input: mappedInput, ...metadata,
    } },
    { type: 'response_item', _stableOrder: 3, payload: {
      type: 'message', id: 'visible-boundary', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Visible narrative boundary' }], ...metadata,
    } },
    { type: 'response_item', _stableOrder: 4, payload: {
      type: 'custom_tool_call', id: 'deferred-after', name: 'exec', status: 'completed', input: deferredInput, ...metadata,
    } },
    { type: 'response_item', _stableOrder: 5, payload: {
      type: 'custom_tool_call', id: 'patch-lifecycle', name: 'exec', status: 'in_progress', input: patchInput, ...metadata,
    } },
    { type: 'response_item', _stableOrder: 6, payload: {
      type: 'custom_tool_call', id: 'unknown-omitted', name: 'exec', status: 'completed',
      input: 'const result=await tools.future_tool({secret:"PRIVATE_UNKNOWN"});text(result);', ...metadata,
    } },
    { type: 'response_item', _stableOrder: 7, payload: {
      type: 'custom_tool_call', id: 'patch-lifecycle', name: 'exec', status: 'completed', input: patchInput, ...metadata,
    } },
  ].map((item, index) => ({ item, nextOffset: index + 1 }));
  const reconciler = new EventReconciler({ serverInstanceId: 'real-nested-exec-shapes' });
  reconciler.rehydrate(raw);

  const snapshot = reconciler.snapshot();
  assert.equal(snapshot.events.some(event => event.id === 'unknown-omitted'), false);
  assert.equal(snapshot.events.filter(event => event.id === 'patch-lifecycle:file:1').length, 1);
  const patch = snapshot.events.find(event => event.id === 'patch-lifecycle:file:1');
  assert.deepEqual({ toolKind: patch.toolKind, state: patch.state, count: patch.count },
    { toolKind: 'file', state: 'succeeded', count: 1 });
  assert.equal(patch.displayDetail, '+1 -1');
  assert.equal(patch.fileLabel, 'file.js');

  const turn = buildTurnViews(snapshot.events, THREAD)[0];
  assert.deepEqual(turn.segments.map(segment => [segment.kind, segment.count]), [
    ['command', 2], ['commentary', 1], ['operation', 3],
  ]);
  assert.deepEqual({ commandCount: turn.segments[2].commandCount, fileCount: turn.segments[2].fileCount },
    { commandCount: 2, fileCount: 1 });
  assert.deepEqual(turn.timeline.map(entry => entry.id), [
    'mapped-before:detail:1', 'mapped-before:detail:2', 'visible-boundary',
    'deferred-after:detail:1', 'deferred-after:detail:2', 'patch-lifecycle:file:1',
  ]);
  assert.deepEqual(turn.process.detailActivities.map(activity => activity.kind),
    ['shell', 'shell', 'commentary', 'shell', 'shell', 'file']);
  assert.equal(turn.process.detailActivities.some(activity => activity.id === 'unknown-omitted'), false);
  assert.doesNotMatch(JSON.stringify({ snapshot, turn }),
    /PRIVATE_|SECRET_|Begin Patch|Update File|future_tool|已运行命令.*unknown/);
});

test('public narrative is sanitized and bounded independently of generic bodies', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-bounded-narrative' },
    {
      type: 'summary', summaryKind: 'commentary', text: 'progress', id: 'bounded-commentary',
      body: `${'x'.repeat(12050)}\n<!-- PRIVATE_COMMENT_CANARY -->`,
    },
  ], THREAD)[0];

  assert.equal(turn.timeline[0].publicNarrative.length, 12000);
  assert.doesNotMatch(JSON.stringify(turn.timeline), /PRIVATE_COMMENT_CANARY|"body"/);
});

test('timeline carries only desktop-safe expandable detail metadata', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-safe-detail' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'command', id: 'command-safe',
      text: 'Run focused tests', durationMs: 125, arguments: 'ARGUMENT_SECRET', output: 'OUTPUT_SECRET',
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'file', id: 'file-safe',
      text: 'Edited file', fileLabel: 'lib/server.js', changeKind: 'modified',
      path: 'E:\\private\\server.js', payload: 'PAYLOAD_SECRET',
    },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'file', id: 'file-private',
      text: 'Edited another file', fileLabel: 'E:\\private\\secret.js', changeKind: 'modified',
    },
  ], THREAD)[0];

  assert.equal(turn.timeline[0].durationMs, 125);
  assert.equal(turn.timeline[1].fileLabel, 'lib/server.js');
  assert.equal(turn.timeline[1].changeKind, 'modified');
  assert.equal(Object.hasOwn(turn.timeline[2], 'fileLabel'), false);
  assert.doesNotMatch(JSON.stringify(turn.timeline), /ARGUMENT_SECRET|OUTPUT_SECRET|PAYLOAD_SECRET|E:\\\\private/);
});

test('real fileChange normalization reaches timeline and segments as safe presentation metadata', () => {
  const normalizer = require('../lib/events/session-normalizer').createSessionNormalizer();
  normalizer.normalize({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-file-pipeline' } });
  const normalized = normalizer.normalize({ type: 'response_item', payload: {
    type: 'fileChange', id: 'file-change-real', status: 'completed',
    changes: [{ path: 'E:\\private\\workspace\\src\\server.js', kind: { type: 'update' }, diff: 'PRIVATE_DIFF' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-file-pipeline' },
  } });
  const turn = buildTurnViews([normalized], THREAD)[0];

  assert.equal(turn.timeline[0].fileLabel, 'server.js');
  assert.equal(turn.timeline[0].changeKind, 'modified');
  assert.equal(turn.segments[0].items[0].fileLabel, 'server.js');
  assert.equal(turn.segments[0].items[0].changeKind, 'modified');
  assert.doesNotMatch(JSON.stringify(turn), /E:\\\\private|PRIVATE_DIFF/);
});

test('paged process activities retain safe file identity and change kind', () => {
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-file-process-detail' },
    {
      type: 'summary', summaryKind: 'tool', toolKind: 'file', id: 'file-detail-safe',
      text: 'Edited file', fileLabel: 'entry/src/main/ets/pages/Index.ets',
      changeKind: 'modified', displayDetail: '+2 -1',
    },
  ], THREAD)[0];

  assert.equal(turn.process.detailActivities[0].fileLabel, 'entry/src/main/ets/pages/Index.ets');
  assert.equal(turn.process.detailActivities[0].changeKind, 'modified');
  assert.equal(turn.process.detailActivities[0].displayDetail, '+2 -1');
});

test('subagent projection includes only safe lifecycle name and state', () => {
  const turns = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-2' },
    {
      type: 'summary', summaryKind: 'subagent', text: 'worker_a 正在执行',
      body: 'SECRET_CHILD_BODY',
      subagent: { name: 'worker_a', state: 'running', aggregate: { running: 1 } },
    },
  ], THREAD);
  const serialized = JSON.stringify(turns);
  assert.equal(serialized.includes('SECRET_CHILD_BODY'), false);
  assert.deepEqual(turns[0].process.activities[0].subagent, {
    name: 'worker_a',
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
  assert.deepEqual(process.activities.map(item => item.kind), ['shell', 'file', 'shell']);
  assert.equal(process.activities[0].title, '已运行 1 条命令');
  assert.equal(process.activities[2].title, '已运行 1 条命令 · 1 条失败');
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
  assert.equal(turns[0].timeline.some(item => item.id === 'message-1'), false);
  assert.equal(turns[0].timeline.some(item => item.id === 'message-2'), true);
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
  await reconciler.ingestRpcNotification({ sequence: 2, method: 'turn/diff/updated', params: { turnId: 'turn-meta', diff: 'diff --git a/src/public.js b/src/public.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/public.js\n@@ -0,0 +1 @@\n+safe\n' } });
  await reconciler.ingestRpcNotification({ sequence: 3, method: 'guardianWarning', params: { turnId: 'turn-meta', message: 'private' } });
  await reconciler.ingestRpcNotification({ sequence: 4, method: 'vendor/newThing', params: { turnId: 'turn-meta', itemId: 'vendor-1', nested: { token: 'secret' } } });
  const turn = buildTurnViews(reconciler.snapshot().events, THREAD)[0];
  const details = turn.process.detailActivities;
  assert.deepEqual(details.find(item => item.kind === 'plan').stepCounts, { pending: 0, inProgress: 0, completed: 1 });
  assert.equal(details.some(item => item.kind === 'diff'), false);
  assert.deepEqual(turn.turnDiff.files.map(item => item.fileLabel), ['src/public.js']);
  assert.equal(details.find(item => item.kind === 'notice').noticeKind, 'guardianWarning');
  assert.equal(details.find(item => item.kind === 'unknown').publicType, 'vendor/newThing');
  assert.doesNotMatch(JSON.stringify(turn), /private|secret|token|nested/);
});

test('turn DTO preserves safe execution metadata while dropping raw and subagent fields', () => {
  const turns = buildTurnViews([
    { type:'turn', state:'started', turnId:'turn-safe' },
    { type:'summary', summaryKind:'tool', toolKind:'mcp', id:'mcp-safe', turnId:'turn-safe', text:'MCP', state:'succeeded',
      server:'browser', tool:'open', namespace:'public.tools', operation:'openPage', durationMs:1250, exitCode:0, background:true,
      body:'BODY_SECRET', arguments:'ARG_SECRET', output:'OUT_SECRET', payload:'PAYLOAD_SECRET' },
    { type:'summary', summaryKind:'subagent', id:'sub-safe', turnId:'turn-safe', text:'worker', state:'running',
      server:'SECRET', tool:'SECRET', namespace:'SECRET', operation:'SECRET', durationMs:1, exitCode:1, background:true,
      subagent:{ name:'worker', state:'running', prompt:'PROMPT_SECRET' } }
  ], THREAD);
  const details = turns[0].process.detailActivities;
  assert.deepEqual(details.find(item => item.id === 'mcp-safe'), {
    id:'mcp-safe', kind:'mcp', state:'succeeded', title:'MCP', server:'browser', tool:'open', namespace:'public.tools',
    operation:'openPage', durationMs:1250, exitCode:0, background:true
  });
  assert.deepEqual(details.find(item => item.id === 'sub-safe').subagent, { name:'worker', state:'running' });
  assert.equal(JSON.stringify(details).includes('SECRET'), false);
});
