'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendProjectedActivity, sanitizePublicAttachments } = require('../lib/events/activity-projection');
const { setPrivateAttachmentSource } = require('../lib/events/private-attachment-source');

test('timeline attachments use the same strict public allowlist', () => {
  const attachments = sanitizePublicAttachments([
    { name: 'safe.png', url: 'https://cdn.example/safe.png', filePath: 'E:\\private\\safe.png' },
    { name: 'token.png', url: 'https://cdn.example/token.png?token=PRIVATE_TOKEN' },
  ]);

  assert.deepEqual(attachments, [{ name: 'safe.png' }, { name: 'token.png' }]);
  assert.doesNotMatch(JSON.stringify(attachments), /private|PRIVATE_TOKEN/i);
});

test('public projection keeps same-basename images distinct when their private sources differ', () => {
  const attachments = sanitizePublicAttachments([
    setPrivateAttachmentSource({ name: 'same.png' }, 'E:\\ProtocolFixtures\\first\\same.png'),
    setPrivateAttachmentSource({ name: 'same.png' }, 'E:\\ProtocolFixtures\\second\\same.png'),
  ]);

  assert.deepEqual(attachments, [{ name: 'same.png' }, { name: 'same.png' }]);
  assert.equal(JSON.stringify(attachments).includes('ProtocolFixtures'), false);
});

test('capability identity preserves case-sensitive opaque handles', () => {
  const attachments = sanitizePublicAttachments([
    { name: 'same.png', url: '/codex/attachment/Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { name: 'same.png', url: '/codex/attachment/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ]);

  assert.equal(attachments.length, 2);
  assert.notEqual(attachments[0].url, attachments[1].url);
});

test('durable activities aggregate only while visibly adjacent and details preserve order', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'c1', kind: 'shell', state: 'succeeded', title: '已运行命令', count: 1,
  });
  appendProjectedActivity(process, {
    id: 'f1', kind: 'file', state: 'succeeded', title: '已更新文件', count: 2,
  });
  appendProjectedActivity(process, {
    id: 'c2', kind: 'shell', state: 'failed', title: '命令执行失败', count: 1,
  });

  assert.deepEqual(process.activities.map(item => item.kind), ['shell', 'file', 'shell']);
  assert.equal(process.activities[0].count, 1);
  assert.equal(process.activities[2].failedCount, 1);
  assert.equal(process.activities[2].title, '已运行 1 条命令 · 1 条失败');
  assert.deepEqual(process.detailActivities.map(item => item.id), ['c1', 'f1', 'c2']);
  assert.equal(process.detailCount, 3);
});

test('paged process details retain safe command text and repository-relative file identity', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'command-detail', kind: 'shell', state: 'succeeded', title: '已运行命令',
    operation: 'run', displayDetail: 'node tests/process-detail-pagination.test.js',
  });
  appendProjectedActivity(process, {
    id: 'file-detail', kind: 'file', state: 'succeeded', title: '已更新文件',
    operation: 'edit', fileLabel: 'lib/history/process-detail-pagination.js',
    changeKind: 'modified', displayDetail: '+4 -1',
  });

  assert.equal(process.detailActivities[0].displayDetail,
    'node tests/process-detail-pagination.test.js');
  assert.deepEqual(process.detailActivities[1], {
    id: 'file-detail', kind: 'file', state: 'succeeded', title: '已更新文件',
    operation: 'edit', fileLabel: 'lib/history/process-detail-pagination.js',
    changeKind: 'modified', displayDetail: '+4 -1',
  });
});

test('process detail file identity rejects absolute and traversal labels', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'absolute', kind: 'file', state: 'succeeded', title: '已更新文件',
    fileLabel: 'Q:\\Fixture\\secret.txt', changeKind: 'modified',
  });
  appendProjectedActivity(process, {
    id: 'traversal', kind: 'file', state: 'succeeded', title: '已更新文件',
    fileLabel: '../secret.txt', changeKind: 'modified',
  });
  assert.equal(Object.hasOwn(process.detailActivities[0], 'fileLabel'), false);
  assert.equal(Object.hasOwn(process.detailActivities[1], 'fileLabel'), false);
});

test('commentary and plan use stable counted titles with terminal suffixes', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'commentary-1', kind: 'commentary', state: 'succeeded', title: '正在处理请求', count: 1,
  });
  appendProjectedActivity(process, {
    id: 'commentary-2', kind: 'commentary', state: 'failed', title: '执行出现错误', count: 2,
  });
  appendProjectedActivity(process, {
    id: 'plan-1', kind: 'plan', state: 'succeeded', title: '已更新执行计划', count: 1,
  });
  appendProjectedActivity(process, {
    id: 'plan-2', kind: 'plan', state: 'cancelled', title: '计划已取消', count: 1,
  });

  const commentary = process.activities.find(item => item.kind === 'commentary');
  const plan = process.activities.find(item => item.kind === 'plan');
  assert.equal(commentary.title, '已更新 3 条进度 · 2 条失败');
  assert.equal(plan.title, '已更新 2 次计划 · 1 条已取消');
});

test('durable variants remain independent and merge only safe image attachments', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'i1', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1,
    attachments: [
      { type: 'image', name: 'one.png', url: '/one', filePath: 'C:\\private\\one.png' },
    ],
  });
  appendProjectedActivity(process, {
    id: 'i2', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1,
    attachments: [
      { type: 'image', name: 'one.png', url: '/one' },
      { type: 'image', name: 'two.png', thumbnailUrl: '/thumb/two' },
    ],
  });
  appendProjectedActivity(process, {
    id: 'g1', kind: 'image', variant: 'imageGeneration', state: 'succeeded', count: 1,
  });

  assert.equal(process.activities.length, 2);
  assert.deepEqual(process.activities.map(item => item.variant), ['imageView', 'imageGeneration']);
  assert.deepEqual(process.activities[0].attachments, [
    { name: 'one.png' },
    { name: 'two.png' },
  ]);
  assert.equal(JSON.stringify(process).includes('C:\\private'), false);
});

test('activity projection strictly allowlists public fields and safe attachment urls', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'safe-activity',
    kind: 'approval',
    variant: 'permission',
    state: 'running',
    title: '等待操作审批',
    body: 'BODY_CANARY',
    count: 2,
    subagent: {
      name: 'worker', action: 'enabled', state: 'running', prompt: 'SUBAGENT_PROMPT_CANARY',
    },
    arguments: 'ARGUMENTS_CANARY',
    output: 'OUTPUT_CANARY',
    payload: 'PAYLOAD_CANARY',
    raw: 'RAW_CANARY',
    path: 'PATH_CANARY',
    filePath: 'FILE_PATH_CANARY',
    dataUrl: 'DATA_URL_CANARY',
    attachments: [
      {
        name: 'safe.png', mime: 'image/png', mimeType: 'image/png', size: 42, count: 1,
        url: 'https://cdn.example/safe.png', thumbnailUrl: '/codex/attachment/0123456789abcdef0123456789abcdef',
        path: 'ATTACHMENT_PATH_CANARY', filePath: 'ATTACHMENT_FILE_CANARY',
        dataUrl: 'data:image/png;base64,ATTACHMENT_DATA_CANARY',
        raw: 'ATTACHMENT_RAW_CANARY',
        arguments: 'ATTACHMENT_ARGUMENTS_CANARY', output: 'ATTACHMENT_OUTPUT_CANARY',
      },
      { name: 'token.png', url: 'https://cdn.example/token.png?token=TOKEN_CANARY' },
      { name: 'fragment.png', url: 'https://cdn.example/fragment.png#FRAGMENT_CANARY' },
      { name: 'userinfo.png', url: 'https://user:pass@cdn.example/userinfo.png' },
      { name: 'data.png', url: 'data:image/png;base64,URL_DATA_CANARY' },
      { name: 'capability.png', url: '/codex/attachment/0123456789abcdef0123456789abcdef' },
      { name: 'foreign-capability.png', url: 'https://evil.example/codex/attachment/0123456789abcdef0123456789abcdef' },
    ],
  });

  const activity = process.detailActivities[0];
  assert.deepEqual(Object.keys(activity).sort(), [
    'attachments', 'count', 'id', 'kind', 'state', 'subagent', 'title', 'variant',
  ]);
  assert.deepEqual(activity.subagent, { name: 'worker', state: 'running' });
  assert.deepEqual(activity.attachments[0], {
    name: 'safe.png', mime: 'image/png', mimeType: 'image/png', size: 42, count: 1,
    thumbnailUrl: '/codex/attachment/0123456789abcdef0123456789abcdef',
  });
  assert.equal(activity.attachments.find(item => item.name === 'token.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'fragment.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'userinfo.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'data.png').url, undefined);
  assert.equal(
    activity.attachments.find(item => item.name === 'capability.png').url,
    '/codex/attachment/0123456789abcdef0123456789abcdef',
  );
  assert.equal(activity.attachments.find(item => item.name === 'foreign-capability.png').url, undefined);
  const serialized = JSON.stringify(process);
  for (const canary of [
    'BODY_CANARY', 'ARGUMENTS_CANARY', 'OUTPUT_CANARY', 'PAYLOAD_CANARY', 'RAW_CANARY', 'PATH_CANARY', 'FILE_PATH_CANARY',
    'DATA_URL_CANARY', 'SUBAGENT_PROMPT_CANARY', 'ATTACHMENT_PATH_CANARY',
    'ATTACHMENT_FILE_CANARY', 'ATTACHMENT_DATA_CANARY', 'ATTACHMENT_RAW_CANARY', 'ATTACHMENT_ARGUMENTS_CANARY',
    'ATTACHMENT_OUTPUT_CANARY', 'TOKEN_CANARY', 'FRAGMENT_CANARY', 'user:pass', 'URL_DATA_CANARY',
  ]) {
    assert.equal(serialized.includes(canary), false, `must not expose ${canary}`);
  }
});

test('activity projection exposes only structured safe execution metadata and none for subagents', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'metadata', kind: 'mcp', state: 'succeeded', title: 'MCP', operation: 'openPage',
    server: 'browser', tool: 'open', namespace: 'public.tools', durationMs: 1250,
    exitCode: 0, background: true, sourceOrdinal: 9, surfaceKind: 'computerUse',
    body: 'BODY_SECRET', arguments: 'ARG_SECRET', output: 'OUT_SECRET', payload: 'PAYLOAD_SECRET',
  });
  appendProjectedActivity(process, {
    id: 'subagent', kind: 'subagent', state: 'running', title: 'worker', operation: 'SECRET',
    server: 'SECRET', tool: 'SECRET', namespace: 'SECRET', durationMs: 2, exitCode: 1, background: true, sourceOrdinal: 9,
    subagent: { name: 'worker', action: 'enabled', state: 'running', prompt: 'PROMPT_SECRET' },
  });
  assert.deepEqual(process.detailActivities[0], {
    id: 'metadata', kind: 'mcp', state: 'succeeded', title: 'MCP', operation: 'openPage',
    server: 'browser', tool: 'open', namespace: 'public.tools', durationMs: 1250, exitCode: 0, background: true,
    sourceOrdinal: 9, surfaceKind: 'computerUse',
  });
  assert.deepEqual(process.detailActivities[1], {
    id: 'subagent', kind: 'subagent', state: 'running', title: 'worker',
    subagent: { name: 'worker', state: 'running' },
  });
  for (const secret of ['BODY_SECRET','ARG_SECRET','OUT_SECRET','PAYLOAD_SECRET','PROMPT_SECRET']) assert.equal(JSON.stringify(process).includes(secret), false);
});

test('late image attachments merge after an attachment-free running update', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'image-running', kind: 'image', variant: 'imageGeneration', state: 'running', count: 1,
  });
  appendProjectedActivity(process, {
    id: 'image-complete', kind: 'image', variant: 'imageGeneration', state: 'succeeded', count: 1,
    attachments: [{ name: 'result.png', url: '/codex/attachment/0123456789abcdef0123456789abcdef' }],
  });

  assert.deepEqual(process.activities[0].attachments, [
    { name: 'result.png', url: '/codex/attachment/0123456789abcdef0123456789abcdef' },
  ]);
});

test('adjacent image views group but separated image views create stable segments', () => {
  const process = { turnId: 'turn-images', activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, { id: 'a', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'b', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'shell', kind: 'shell', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'c', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  assert.deepEqual(process.activities.map(item => item.id), ['turn-images-summary-image:imageView-1', 'turn-images-summary-shell', 'turn-images-summary-image:imageView-2']);
  assert.deepEqual(process.activities.map(item => item.title), ['已查看 2 张图像', process.activities[1].title, '已查看 1 张图像']);
});

test('reasoning remains one transient metadata row without exposing body content', () => {
  const process = { turnId: 'turn-1', activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, {
    id: 'r1', kind: 'reasoning', state: 'running', title: '正在分析', body: '第一条',
  });
  appendProjectedActivity(process, {
    id: 'r2', kind: 'reasoning', state: 'running', title: '正在分析', body: '第二条',
  });

  assert.equal(process.activities.filter(item => item.kind === 'reasoning').length, 1);
  assert.equal(Object.hasOwn(process.activities.find(item => item.kind === 'reasoning'), 'body'), false);
  assert.equal(process.detailActivities.filter(item => item.kind === 'reasoning').length, 1);
  assert.equal(Object.hasOwn(process.detailActivities.find(item => item.kind === 'reasoning'), 'body'), false);
  assert.equal(process.detailCount, 1);
});

test('interactive activities remain independent first-level rows', () => {
  const process = { activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, { id: 'a1', kind: 'approval', state: 'running', title: '等待操作审批' });
  appendProjectedActivity(process, { id: 'a2', kind: 'approval', state: 'succeeded', title: '审批已处理' });

  assert.deepEqual(process.activities.map(item => item.id), ['a1', 'a2']);
  assert.deepEqual(process.detailActivities.map(item => item.id), ['a1', 'a2']);
});

test('legacy activity projection treats visible intervening rows as aggregation boundaries', () => {
  const process = { turnId: 'turn-adjacent', activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, { id: 'c1', kind: 'shell', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'c2', kind: 'shell', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'note', kind: 'commentary', state: 'succeeded', title: 'Next step' });
  appendProjectedActivity(process, { id: 'c3', kind: 'shell', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'c4', kind: 'shell', state: 'succeeded', count: 1 });

  assert.deepEqual(process.activities.map(item => [item.kind, item.count]), [
    ['shell', 2], ['commentary', 1], ['shell', 2],
  ]);
  assert.notEqual(process.activities[0].id, process.activities[2].id);
});
