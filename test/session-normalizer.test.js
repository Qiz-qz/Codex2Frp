'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECRET_ARGUMENT,
  SECRET_BODY,
  SECRET_OUTPUT,
  SECRET_PROMPT,
  SYNTHETIC_IMAGE_DIR,
  appServerItem,
  assertNoSecretCanaries,
  responseMessage,
  sessionItem,
  subagentActivity,
} = require('./fixtures/session-events');
const { createSessionNormalizer } = require('../lib/events/session-normalizer');

function createNormalizer(options) {
  return createSessionNormalizer(options);
}

test('installed command actions classify file exploration outside generic shell', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'read-one', status: 'completed', command: 'Get-Content a', cwd: 'E:\\',
    commandActions: [{ type: 'read', command: 'Get-Content a', name: 'a', path: 'E:\\a' }],
    app_server_item: true,
  } });
  assert.equal(event.toolKind, 'file');
  assert.equal(event.sourceKey, 'read-one');
});

test('installed tool items project structured safe metadata without raw contents', () => {
  const normalizer = createSessionNormalizer();
  const command = normalizer.normalize({ type:'response_item', payload:{
    type:'commandExecution', id:'cmd', status:'completed', command:'SECRET_COMMAND', cwd:'C:/SECRET',
    commandActions:[{ type:'run', command:'SECRET_COMMAND' }], durationMs:1250, exitCode:0, background:true,
    aggregatedOutput:'SECRET_OUTPUT', arguments:{ token:'SECRET_ARGUMENT' }
  }});
  const mcp = normalizer.normalize({ type:'response_item', payload:{
    type:'mcpToolCall', id:'mcp', status:'completed', server:'browser', tool:'open', durationMs:250,
    arguments:{ token:'SECRET_ARGUMENT' }, result:{ content:'SECRET_OUTPUT' }
  }});
  const dynamic = normalizer.normalize({ type:'response_item', payload:{
    type:'dynamicToolCall', id:'dyn', status:'completed', namespace:'public.tools', tool:'run', durationMs:500,
    arguments:{ token:'SECRET_ARGUMENT' }, contentItems:[{ text:'SECRET_OUTPUT' }]
  }});
  assert.deepEqual({ operation:command.operation, durationMs:command.durationMs, exitCode:command.exitCode, background:command.background },
    { operation:'run', durationMs:1250, exitCode:0, background:true });
  assert.deepEqual({ server:mcp.server, tool:mcp.tool, durationMs:mcp.durationMs }, { server:'browser', tool:'open', durationMs:250 });
  assert.deepEqual({ namespace:dynamic.namespace, tool:dynamic.tool, durationMs:dynamic.durationMs }, { namespace:'public.tools', tool:'run', durationMs:500 });
  for (const event of [command,mcp,dynamic]) for (const field of ['body','arguments','output','payload','result','contentItems']) assert.equal(Object.hasOwn(event,field),false);
});

test('keeps main-task user and final text while removing HTML comments outside fenced code', () => {
  const normalizer = createNormalizer();
  const user = normalizer.normalize(responseMessage(
    'user',
    '',
    '公开请求\n<!-- internal user note -->\n```html\n<!-- keep code example -->\n```',
  ));
  const final = normalizer.normalize(responseMessage(
    'assistant',
    'final_answer',
    '公开回复\n<!-- internal final note -->',
  ));

  assert.equal(user.type, 'message');
  assert.equal(user.role, 'user');
  assert.equal(user.text.includes('internal user note'), false);
  assert.equal(user.text.includes('<!-- keep code example -->'), true);
  assert.equal(final.type, 'message');
  assert.equal(final.role, 'assistant');
  assert.equal(final.phase, 'final_answer');
  assert.equal(final.text, '公开回复');
});

test('hides standalone Codex UI directives only from assistant messages', () => {
  const normalizer = createNormalizer();
  const final = normalizer.normalize(responseMessage(
    'assistant',
    'final_answer',
    '已提交。\n::git-commit{cwd="E:\\\\repo"}\n```text\n::git-push{cwd="E:\\\\example" branch="main"}\n```',
  ));
  const user = normalizer.normalize(responseMessage(
    'user',
    '',
    '请解释 ::git-commit{cwd="E:\\\\repo"}',
  ));

  assert.equal(final.text, '已提交。\n```text\n::git-push{cwd="E:\\\\example" branch="main"}\n```');
  assert.equal(user.text, '请解释 ::git-commit{cwd="E:\\\\repo"}');
});

test('response and event copies upsert one cleaned user message with attachments', () => {
  const normalizer = createNormalizer({ session: { isSubagent: false } });
  const response = normalizer.normalize({
    type: 'response_item', timestamp: '2026-07-10T10:00:00.000Z',
    payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '# Files mentioned by the user:\n## a.png: C:/private/a.png\n## My request for Codex:\n查看图片' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ] },
  });
  const event = normalizer.normalize({
    type: 'event_msg', timestamp: '2026-07-10T10:00:00.001Z',
    payload: { type: 'user_message', message: '查看图片', local_images: ['C:/private/a.png'] },
  });

  assert.equal(response.text, '查看图片');
  assert.equal(event.text, '查看图片');
  assert.equal(response.sourceKey, event.sourceKey);
  assert.deepEqual(event.attachments.map(item => item.name), ['a.png']);
  assert.equal(JSON.stringify(response).includes('base64'), false);
});

test('turn reducer distinguishes active-turn steer, next-turn queue, and idle input', () => {
  const normalizer = createNormalizer();
  normalizer.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-main' }));

  const steer = normalizer.normalize(responseMessage('user', '', '当前轮补充', 'turn-main'));
  const duplicateEvent = normalizer.normalize(sessionItem('event_msg', {
    type: 'user_message',
    message: '当前轮补充',
  }));
  const queued = normalizer.normalize(responseMessage('user', '', '下一轮排队', 'turn-next'));
  normalizer.normalize(sessionItem('event_msg', { type: 'task_complete', turn_id: 'turn-main' }));
  const idle = normalizer.normalize(responseMessage('user', '', '空闲输入', 'turn-idle'));

  assert.equal(steer.delivery, 'steer');
  assert.equal(steer.turnId, 'turn-main');
  assert.equal(duplicateEvent.sourceKey, steer.sourceKey);
  assert.equal(queued.delivery, 'queued');
  assert.equal(queued.turnId, 'turn-next');
  assert.equal(idle.delivery, 'initial');
});

test('keeps sanitized main-task progress summaries as structured process bodies', () => {
  const normalizer = createNormalizer();
  normalizer.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-progress' }));
  const commentary = normalizer.normalize(responseMessage(
    'assistant', 'commentary', '**Inspecting protocol**\n<!-- hidden marker -->', 'turn-progress',
  ));
  const planning = normalizer.normalize(responseMessage(
    'assistant', 'planning', '**Planning API24 emulator testing**', 'turn-progress',
  ));
  const reasoning = normalizer.normalize(sessionItem('response_item', {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: '**Evaluating compatibility**\n<!-- hidden reasoning marker -->' }],
  }));

  assert.deepEqual(
    [commentary.summaryKind, planning.summaryKind, reasoning.summaryKind],
    ['commentary', 'plan', 'reasoning'],
  );
  assert.deepEqual(
    [commentary.text, planning.text, reasoning.text],
    ['正在处理请求', '已更新执行计划', '正在分析请求'],
  );
  assert.equal(commentary.body, '**Inspecting protocol**');
  assert.equal(planning.body, '**Planning API24 emulator testing**');
  assert.equal(reasoning.body, '**Evaluating compatibility**');
  assert.deepEqual(
    [commentary.turnId, planning.turnId, reasoning.turnId],
    ['turn-progress', 'turn-progress', 'turn-progress'],
  );
  assert.equal(JSON.stringify([commentary, planning, reasoning]).includes('hidden'), false);
});

test('summarizes tool calls without exposing arguments or outputs', () => {
  const normalizer = createNormalizer();
  const call = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-safe',
    arguments: JSON.stringify({ command: SECRET_ARGUMENT }),
  }));
  const output = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call_output',
    call_id: 'call-safe',
    output: SECRET_OUTPUT,
  }));

  assert.equal(call.type, 'summary');
  assert.equal(call.summaryKind, 'tool');
  assert.equal(call.toolKind, 'command');
  assert.equal(call.text, '已运行命令');
  assert.equal(output, null);
  assertNoSecretCanaries(assert, [call, output]);
});

test('drops collaboration messages, collaboration call bodies, unknown items, and child-session content', () => {
  const normalizer = createNormalizer();
  const collaborationMessage = normalizer.normalize(sessionItem('response_item', {
    type: 'agent_message',
    author: 'agent-a',
    recipient: 'agent-b',
    content: SECRET_BODY,
  }));
  const collaborationCall = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call',
    name: 'spawn_agent',
    call_id: 'call-agent',
    arguments: JSON.stringify({ message: SECRET_BODY }),
  }));
  const unknown = normalizer.normalize(sessionItem('event_msg', {
    type: 'future_internal_event',
    message: SECRET_BODY,
  }));
  const childNormalizer = createNormalizer({ session: { isSubagent: true } });
  const childFinal = childNormalizer.normalize(responseMessage('assistant', 'final_answer', SECRET_BODY));

  assert.equal(collaborationMessage, null);
  assert.equal(collaborationCall, null);
  assert.equal(unknown, null);
  assert.equal(childFinal, null);
  assertNoSecretCanaries(assert, [collaborationMessage, collaborationCall, unknown, childFinal]);
});

test('projects subagent activity as privacy-safe structured summaries', () => {
  const normalizer = createNormalizer();
  const started = normalizer.normalize(subagentActivity('started'));

  assert.equal(started.type, 'summary');
  assert.equal(started.summaryKind, 'subagent');
  assert.equal(started.subagent.name, 'private-secret-agent-path');
  assert.equal(started.subagent.status, 'enabled');
  assert.deepEqual(started.subagent.aggregate, {
    enabled: 1,
    closed: 0,
    failed: 0,
    interrupted: 0,
  });
  assertNoSecretCanaries(assert, started);
});

test('normalizes imageView with exact turn, attachment metadata, and image count', () => {
  const normalizer = createNormalizer();
  normalizer.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-other' }));
  const filePath = `${SYNTHETIC_IMAGE_DIR}\\viewed-one.png`;
  const image = normalizer.normalize(appServerItem('imageView', {
    id: 'image-view-1',
    path: filePath,
    lifecycle_state: 'succeeded',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-image' },
  }));

  assert.equal(image.type, 'summary');
  assert.equal(image.summaryKind, 'tool');
  assert.equal(image.toolKind, 'imageView');
  assert.equal(image.turnId, 'turn-image');
  assert.equal(image.count, 1);
  assert.equal(image.attachments.length, 1);
  assert.equal(image.attachments[0].name, 'viewed-one.png');
  assert.equal(image.attachments[0].filePath, filePath);
});

test('normalizes legacy view_image_tool_call as one multi-image activity', () => {
  const normalizer = createNormalizer();
  normalizer.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-images' }));
  const paths = [
    `${SYNTHETIC_IMAGE_DIR}\\first.png`,
    `${SYNTHETIC_IMAGE_DIR}\\second.jpg`,
  ];
  const image = normalizer.normalize(sessionItem('event_msg', {
    type: 'view_image_tool_call',
    id: 'legacy-view-images',
    imagePaths: paths,
  }));

  assert.equal(image.toolKind, 'imageView');
  assert.equal(image.turnId, 'turn-images');
  assert.equal(image.count, 2);
  assert.deepEqual(image.attachments.map(item => item.filePath), paths);
});

test('normalizes imageGeneration separately from viewed images', () => {
  const normalizer = createNormalizer();
  const savedPath = `${SYNTHETIC_IMAGE_DIR}\\generated.webp`;
  const generated = normalizer.normalize(appServerItem('imageGeneration', {
    id: 'image-generation-1',
    savedPath,
    status: 'completed',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-generation' },
  }));

  assert.equal(generated.toolKind, 'imageGeneration');
  assert.equal(generated.turnId, 'turn-generation');
  assert.equal(generated.state, 'succeeded');
  assert.equal(generated.count, 1);
  assert.equal(generated.attachments[0].filePath, savedPath);
});

test('normalizes current imageGeneration src and marks terminal errors failed', () => {
  const normalizer = createNormalizer();
  const generatedPath = `${SYNTHETIC_IMAGE_DIR}\\generated-from-src.png`;
  const generated = normalizer.normalize(appServerItem('imageGeneration', {
    id: 'image-generation-src',
    src: generatedPath,
    lifecycle_state: 'succeeded',
  }));
  const terminalError = normalizer.normalize(appServerItem('error', {
    id: 'error-terminal',
    message: 'safe failure',
    lifecycle_state: 'succeeded',
  }));
  const retryingError = normalizer.normalize(appServerItem('error', {
    id: 'error-retry',
    message: 'safe retry',
    willRetry: true,
    lifecycle_state: 'succeeded',
  }));

  assert.equal(generated.attachments[0].filePath, generatedPath);
  assert.equal(terminalError.state, 'failed');
  assert.equal(terminalError.text, '执行出现错误');
  assert.equal(retryingError.state, 'running');
  assert.equal(retryingError.text, '连接异常，正在重试');
});

test('drops app-server collaboration tool contents instead of treating them as generic tools', () => {
  const normalizer = createNormalizer();
  const collaboration = normalizer.normalize(appServerItem('collabAgentToolCall', {
    id: 'collab-private-1',
    tool: 'spawn_agent',
    prompt: SECRET_PROMPT,
    body: SECRET_BODY,
    arguments: SECRET_ARGUMENT,
    output: SECRET_OUTPUT,
    receiverThreadIds: ['raw-private-child'],
  }));

  assert.equal(collaboration, null);
  assertNoSecretCanaries(assert, collaboration);
});
