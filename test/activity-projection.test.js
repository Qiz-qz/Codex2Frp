'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendProjectedActivity } = require('../lib/events/activity-projection');

test('durable activities aggregate by kind and variant while details preserve order', () => {
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

  assert.deepEqual(process.activities.map(item => item.kind), ['shell', 'file']);
  assert.equal(process.activities[0].count, 2);
  assert.equal(process.activities[0].failedCount, 1);
  assert.equal(process.activities[0].title, '已运行 2 条命令 · 1 条失败');
  assert.deepEqual(process.detailActivities.map(item => item.id), ['c1', 'f1', 'c2']);
  assert.equal(process.detailCount, 3);
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
        url: 'https://cdn.example/safe.png', thumbnailUrl: '/codex/attachment/opaque_capability',
        path: 'ATTACHMENT_PATH_CANARY', filePath: 'ATTACHMENT_FILE_CANARY',
        dataUrl: 'data:image/png;base64,ATTACHMENT_DATA_CANARY',
        raw: 'ATTACHMENT_RAW_CANARY',
        arguments: 'ATTACHMENT_ARGUMENTS_CANARY', output: 'ATTACHMENT_OUTPUT_CANARY',
      },
      { name: 'token.png', url: 'https://cdn.example/token.png?token=TOKEN_CANARY' },
      { name: 'fragment.png', url: 'https://cdn.example/fragment.png#FRAGMENT_CANARY' },
      { name: 'userinfo.png', url: 'https://user:pass@cdn.example/userinfo.png' },
      { name: 'data.png', url: 'data:image/png;base64,URL_DATA_CANARY' },
      { name: 'capability.png', url: 'http://phone.local/codex/attachment/opaque_capability' },
    ],
  });

  const activity = process.detailActivities[0];
  assert.deepEqual(Object.keys(activity).sort(), [
    'attachments', 'count', 'id', 'kind', 'state', 'subagent', 'title', 'variant',
  ]);
  assert.deepEqual(activity.subagent, { name: 'worker', action: 'enabled', state: 'running' });
  assert.deepEqual(activity.attachments[0], {
    name: 'safe.png', mime: 'image/png', mimeType: 'image/png', size: 42, count: 1,
    url: 'https://cdn.example/safe.png', thumbnailUrl: '/codex/attachment/opaque_capability',
  });
  assert.equal(activity.attachments.find(item => item.name === 'token.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'fragment.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'userinfo.png').url, undefined);
  assert.equal(activity.attachments.find(item => item.name === 'data.png').url, undefined);
  assert.equal(
    activity.attachments.find(item => item.name === 'capability.png').url,
    'http://phone.local/codex/attachment/opaque_capability',
  );
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
    exitCode: 0, background: true, body: 'BODY_SECRET', arguments: 'ARG_SECRET', output: 'OUT_SECRET', payload: 'PAYLOAD_SECRET',
  });
  appendProjectedActivity(process, {
    id: 'subagent', kind: 'subagent', state: 'running', title: 'worker', operation: 'SECRET',
    server: 'SECRET', tool: 'SECRET', namespace: 'SECRET', durationMs: 2, exitCode: 1, background: true,
    subagent: { name: 'worker', action: 'enabled', state: 'running', prompt: 'PROMPT_SECRET' },
  });
  assert.deepEqual(process.detailActivities[0], {
    id: 'metadata', kind: 'mcp', state: 'succeeded', title: 'MCP', operation: 'openPage',
    server: 'browser', tool: 'open', namespace: 'public.tools', durationMs: 1250, exitCode: 0, background: true,
  });
  assert.deepEqual(process.detailActivities[1], {
    id: 'subagent', kind: 'subagent', state: 'running', title: 'worker',
    subagent: { name: 'worker', action: 'enabled', state: 'running' },
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
    attachments: [{ name: 'result.png', url: 'https://cdn.example/result.png' }],
  });

  assert.deepEqual(process.activities[0].attachments, [
    { name: 'result.png', url: 'https://cdn.example/result.png' },
  ]);
});

test('adjacent image views group but separated image views create stable segments', () => {
  const process = { turnId: 'turn-images', activities: [], detailActivities: [], detailCount: 0, counts: {} };
  appendProjectedActivity(process, { id: 'a', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'b', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'shell', kind: 'shell', state: 'succeeded', count: 1 });
  appendProjectedActivity(process, { id: 'c', kind: 'image', variant: 'imageView', state: 'succeeded', count: 1 });
  assert.deepEqual(process.activities.map(item => item.id), ['turn-images-summary-image:imageView-1', 'turn-images-summary-shell', 'turn-images-summary-image:imageView-2']);
  assert.deepEqual(process.activities.map(item => item.title), ['已查看 2 张图像', process.activities[1].title, '已查看一张图像']);
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
