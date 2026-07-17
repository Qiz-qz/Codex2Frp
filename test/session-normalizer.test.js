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
const { safeDisplayDetail } = require('../lib/events/display-detail');
const { getPrivateAttachmentSource } = require('../lib/events/private-attachment-source');

function createNormalizer(options) {
  return createSessionNormalizer(options);
}

const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('attachment-only desktop user events remain visible without leaking local paths', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({
    type: 'event_msg',
    timestamp: '2026-07-16T00:00:00.000Z',
    payload: {
      type: 'user_message',
      message: '',
      local_images: ['E:\\PRIVATE\\only-image.png'],
    },
  });

  assert.equal(event.type, 'message');
  assert.equal(event.role, 'user');
  assert.equal(event.text, '');
  assert.equal(event.attachments.length, 1);
  assert.equal(event.attachments[0].name, 'only-image.png');
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE/);
});

test('current ChatGPT inline user images survive both desktop message representations', () => {
  for (const item of [
    {
      type: 'event_msg', timestamp: '2026-07-17T00:00:00.000Z',
      payload: { type: 'user_message', message: 'with image', local_images: [], images: [VALID_PNG_DATA_URL] },
    },
    {
      type: 'response_item', timestamp: '2026-07-17T00:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'with image' },
        { type: 'input_image', image_url: VALID_PNG_DATA_URL },
      ] },
    },
  ]) {
    const event = createSessionNormalizer().normalize(item);
    assert.equal(event.role, 'user');
    assert.equal(event.text, 'with image');
    assert.equal(event.attachments.length, 1);
    assert.equal(event.attachments[0].mimeType, 'image/png');
    assert.equal(event.attachments[0].dataUrl, VALID_PNG_DATA_URL);
  }
});

test('list_agents output projects terminal lifecycle only and never agent content', () => {
  const normalizer = createSessionNormalizer();
  const callId = 'agents-call-1';
  assert.deepEqual(normalizer.normalizeMany({ type: 'response_item', payload: {
    type: 'function_call', name: 'list_agents', call_id: callId, arguments: '{}',
  } }), []);
  const rows = normalizer.normalizeMany({ type: 'response_item', payload: {
    type: 'function_call_output', call_id: callId,
    output: JSON.stringify({ agents: [
      { agent_name: '/root', agent_status: 'running', last_task_message: 'ROOT_PRIVATE' },
      { agent_name: '/root/backend_audit', agent_status: { completed: 'FINAL_PRIVATE' },
        last_task_message: 'PROMPT_PRIVATE' },
      { agent_name: '/root/client_audit', agent_status: { errored: 'ERROR_PRIVATE' } },
      { agent_name: '/root/live_audit', agent_status: 'running' },
    ] }),
  } });

  assert.deepEqual(rows.map(row => row.subagent), [
    { name: 'backend_audit', state: 'completed' },
    { name: 'client_audit', state: 'failed' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /ROOT_PRIVATE|FINAL_PRIVATE|PROMPT_PRIVATE|ERROR_PRIVATE|agent_name|last_task_message/);

  const secondCallId = 'agents-call-2';
  normalizer.normalizeMany({ type: 'response_item', payload: {
    type: 'function_call', name: 'list_agents', call_id: secondCallId, arguments: '{}',
  } });
  const unchanged = normalizer.normalizeMany({ type: 'response_item', payload: {
    type: 'function_call_output', call_id: secondCallId,
    output: JSON.stringify({ agents: [
      { agent_name: '/root/backend_audit', agent_status: { completed: 'DIFFERENT_PRIVATE' } },
    ] }),
  } });
  assert.deepEqual(unchanged, []);
});

test('current desktop MCP web and automatic compaction events use semantic visible labels only', () => {
  const normalizer = createSessionNormalizer();
  const mcp = normalizer.normalize({ type: 'event_msg', payload: {
    type: 'mcp_tool_call_end', call_id: 'mcp-visible',
    invocation: {
      server: 'node_repl', tool: 'js',
      arguments: { title: '截取桌面端当前任务', code: 'PRIVATE_CODE', token: 'PRIVATE_TOKEN' },
    },
    result: { content: 'PRIVATE_RESULT' },
    duration: { secs: 2, nanos: 500000000 },
  } });
  const web = normalizer.normalize({ type: 'event_msg', payload: {
    type: 'web_search_end', call_id: 'web-visible', query: 'site:example.test current schema',
    action: { type: 'search', raw: 'PRIVATE_ACTION' },
  } });
  const compaction = normalizer.normalize({ type: 'event_msg', payload: {
    type: 'context_compacted', private: 'PRIVATE_COMPACTION',
  } });

  assert.deepEqual({ text: mcp.text, toolKind: mcp.toolKind, server: mcp.server, tool: mcp.tool,
    durationMs: mcp.durationMs }, {
    text: '截取桌面端当前任务', toolKind: 'mcp', server: 'node_repl', tool: 'js', durationMs: 2500,
  });
  assert.deepEqual({ text: web.text, toolKind: web.toolKind, displayDetail: web.displayDetail }, {
    text: '已搜索网页', toolKind: 'search', displayDetail: 'site:example.test current schema',
  });
  assert.deepEqual({ text: compaction.text, toolKind: compaction.toolKind, variant: compaction.variant }, {
    text: '上下文已自动压缩', toolKind: 'compaction', variant: 'automatic',
  });
  assert.doesNotMatch(JSON.stringify([mcp, web, compaction]), /PRIVATE_/);
});

test('MCP event without a desktop semantic title fails closed', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({ type: 'event_msg', payload: {
    type: 'mcp_tool_call_end', call_id: 'mcp-no-title',
    invocation: { server: 'private_server', tool: 'private_tool', arguments: { code: 'PRIVATE_CODE' } },
    result: { content: 'PRIVATE_RESULT' },
  } });
  assert.equal(event, null);
});

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

test('installed tool items project structured public details without outputs or arguments', () => {
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
  assert.equal(command.displayDetail, 'SECRET_COMMAND');
  assert.deepEqual({ server:mcp.server, tool:mcp.tool, durationMs:mcp.durationMs }, { server:'browser', tool:'open', durationMs:250 });
  assert.deepEqual({ namespace:dynamic.namespace, tool:dynamic.tool, durationMs:dynamic.durationMs }, { namespace:'public.tools', tool:'run', durationMs:500 });
  for (const event of [command,mcp,dynamic]) for (const field of ['body','arguments','output','payload','result','contentItems']) assert.equal(Object.hasOwn(event,field),false);
});

test('installed command display detail is bounded, control-free, and never derived from private execution fields', () => {
  const normalizer = createSessionNormalizer();
  const direct = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'command-direct', status: 'completed',
    command: '  pwsh\u0000 -NoProfile\r\nGet-Date  ',
    cwd: 'C:\\PRIVATE_CWD', aggregatedOutput: SECRET_OUTPUT,
    arguments: { token: SECRET_ARGUMENT }, result: { content: SECRET_OUTPUT },
    commandActions: [{ type: 'run', command: 'ignored fallback' }],
  } });
  const fallback = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'command-fallback', status: 'completed',
    commandActions: [
      { type: 'run', command: 'Get-Item alpha' },
      { type: 'run', command: 'Get-Item beta' },
      { type: 'run', command: 'Get-Item alpha' },
    ],
    cwd: 'D:\\PRIVATE_FALLBACK_CWD', output: SECRET_OUTPUT,
  } });
  const bounded = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'command-bounded', status: 'completed',
    command: `run-${'x'.repeat(2000)}`,
  } });
  const redacted = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'command-redacted', status: 'completed',
    command: 'pwsh --token SECRET_TOKEN_VALUE --authorization Bearer FLAG_SECRET curl -u user:CURL_SECRET https://example.test/path',
  } });
  const headerRedacted = normalizer.normalize({ type: 'response_item', payload: {
    type: 'commandExecution', id: 'command-header-redacted', status: 'completed',
    command: "curl -uuser:SECRET_BASIC -H 'X-API-Key: SECRET_HEADER' --header 'X-Auth-Token: SECRET_AUTH' https://example.test; pwsh -Headers @{ Authorization = 'Bearer SECRET_PS' }",
  } });

  assert.equal(direct.displayDetail, 'pwsh -NoProfile Get-Date');
  assert.equal(fallback.displayDetail, 'Get-Item alpha; Get-Item beta');
  assert.equal(bounded.displayDetail.length, 1024);
  assert.equal(redacted.displayDetail,
    'pwsh --token <redacted> --authorization <redacted> curl -u <redacted> https://example.test/path');
  assert.equal(headerRedacted.displayDetail, '<redacted command>');
  for (const command of [
    "curl -H 'X-API-Key: SECRET WITH SPACE' https://example.test",
    "pwsh -Headers @{ Authorization = 'Bearer SECRET WITH SPACE' }",
    "pwsh -Headers @{ 'X-API-Key' = 'SECRET WITH SPACE' }",
    "curl -H 'Cookie: session=SECRET; other=MORESECRET' https://example.test",
    'curl -H "Authorization: Bearer SECRET" https://example.test',
    "curl -H 'PRIVATE-TOKEN: SECRET' https://example.test",
    "curl -H 'X-Gitlab-Token: SECRET' https://example.test",
    "curl -H 'Api-Key: SECRET' https://example.test",
    "curl -H 'X-Custom-Api-Key: SECRET' https://example.test",
    "curl -d '{\"token\":\"SECRET_JSON\"}' https://example.test",
    "curl -d '{\"api_key\":\"SECRET_JSON_KEY\"}' https://example.test",
    "pwsh -Body @{ token = 'SECRET PS SPACE' }",
    "pwsh -Body @{ client_secret = 'SECRET_CLIENT' }",
    'GITHUB_PAT=SECRET_PAT gh api /user',
    'PRIVATE_KEY=SECRET_PRIVATE_KEY ssh user@example.test',
    "curl -d '{\"access_key\":\"SECRET_ACCESS_KEY\"}' https://example.test",
    'sshpass -p SECRET_SSHPASS ssh user@example.test',
    'curl https://user:pass@example.test/path',
  ]) assert.equal(safeDisplayDetail(command), '<redacted command>');
  assert.equal(safeDisplayDetail('curl --proxy-user user:SECRET_PROXY https://example.test'),
    'curl --proxy-user <redacted> https://example.test');
  assert.equal(safeDisplayDetail('pwsh --token SECRET_TOKEN_VALUE'), 'pwsh --token <redacted>');
  assert.equal(safeDisplayDetail('tool --credential SECRET_CREDENTIAL'), 'tool --credential <redacted>');
  assert.equal(safeDisplayDetail('curl --oauth2-bearer SECRET_OAUTH https://example.test'),
    'curl --oauth2-bearer <redacted> https://example.test');
  const performanceInput = `${'A'.repeat(4095)}=`;
  const performanceStartedAt = Date.now();
  for (let index = 0; index < 2000; index += 1) safeDisplayDetail(performanceInput);
  assert.ok(Date.now() - performanceStartedAt < 1000, 'credential scanning stays bounded for long non-sensitive keys');
  assert.doesNotMatch(direct.displayDetail, /[\u0000-\u001F\u007F]/);
  assert.doesNotMatch(JSON.stringify([direct, fallback, bounded, redacted, headerRedacted]),
    /PRIVATE_CWD|PRIVATE_FALLBACK_CWD|SECRET_TOOL_OUTPUT_CANARY|SECRET_TOOL_ARGUMENT_CANARY|SECRET_TOKEN_VALUE|SECRET_API_VALUE|LOWER_SECRET|HEADER_SECRET|FLAG_SECRET|CURL_SECRET|SECRET_BASIC|SECRET_HEADER|SECRET_AUTH|SECRET_PS|user:pass/);
});

test('current exec wrapper publishes only one direct shell command string literal', () => {
  const normalizer = createSessionNormalizer();
  const direct = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-direct', call_id: 'exec-direct-call', name: 'exec', status: 'completed',
    input: 'const r = await tools.shell_command({ command: "Get-ChildItem -Force", workdir: "E:/workspace", timeout_ms: 10000 }); text(r);',
    output: 'PRIVATE_EXEC_OUTPUT', arguments: { private: 'PRIVATE_EXEC_ARGUMENT' },
  } });
  const escaped = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-escaped', call_id: 'exec-escaped-call', name: 'exec', status: 'completed',
    input: "const r = await tools.shell_command({'command': 'rg -n \\\'hello\\\' entry', timeout_ms: 10000}); text(r);",
  } });
  assert.equal(direct.displayDetail, 'Get-ChildItem -Force');
  assert.equal(escaped.displayDetail, "rg -n 'hello' entry");
  const fullOptions = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-options', call_id: 'exec-options-call', name: 'exec', status: 'completed',
    input: 'const result = await tools.shell_command({command: "Get-Date", justification: "Allowed", login: false, prefix_rule: ["git", "status"], sandbox_permissions: "use_default", timeout_ms: 10000, workdir: "E:/workspace"}); text(result);',
  } });
  assert.equal(fullOptions.displayDetail, 'Get-Date');
  for (const [id, input] of [
    ['template', 'await tools.shell_command({command: `PRIVATE_TEMPLATE`})'],
    ['variable', 'await tools.shell_command({command: PRIVATE_VARIABLE})'],
    ['concat', 'await tools.shell_command({command: "PRIVATE_PREFIX" + PRIVATE_SUFFIX})'],
    ['spread', 'await tools.shell_command({command: "PRIVATE_SPREAD", ...PRIVATE_OPTIONS})'],
    ['duplicate', 'await tools.shell_command({command: "PRIVATE_ONE", command: "PRIVATE_TWO"})'],
    ['computed', "await tools.shell_command({['command']: 'PRIVATE_COMPUTED'})"],
    ['other-tool', 'await tools.apply_patch({command: "PRIVATE_PATCH"})'],
    ['comment', 'await tools.shell_command({command: "PRIVATE_COMMENT" /* ambiguous */})'],
    ['commented-call', '// await tools.shell_command({command: "PRIVATE_COMMENTED_CALL"})'],
    ['string-call', 'const example = \'tools.shell_command({command: "PRIVATE_STRING_CALL"})\'; text(example);'],
    ['template-wrapper', 'const example = `tools.shell_command({command: "PRIVATE_TEMPLATE_CALL"})`; text(example);'],
    ['regex-wrapper', 'const example = /tools\\.shell_command\\(\\{command/; text(example);'],
    ['member-chain', 'await privateObject.tools.shell_command({command: "PRIVATE_MEMBER_CHAIN"})'],
    ['mixed-before', 'await tools.apply_patch("PRIVATE_MIXED_BEFORE"); const r = await tools.shell_command({command: "PRIVATE_COMMAND"}); text(r);'],
    ['mixed-after', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND"}); text(r); await tools.apply_patch("PRIVATE_MIXED_AFTER");'],
    ['nested-tool', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", workdir: tools.apply_patch("PRIVATE_NESTED")}); text(r);'],
    ['computed-other-key', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", ["workdir"]: "PRIVATE_COMPUTED_OTHER"}); text(r);'],
    ['duplicate-other-key', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", timeout_ms: 1, timeout_ms: 2}); text(r);'],
    ['nested-spread', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", prefix_rule: [...PRIVATE_PREFIX]}); text(r);'],
    ['other-variable', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", timeout_ms: PRIVATE_TIMEOUT}); text(r);'],
    ['malformed-prefix', '} const r = await tools.shell_command({command: "PRIVATE_COMMAND"}); text(r);'],
    ['malformed-suffix', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND"}); text(r); {'],
    ['unknown-key', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", private: "PRIVATE_UNKNOWN"}); text(r);'],
    ['missing-await', 'const r = tools.shell_command({command: "PRIVATE_NO_AWAIT"}); text(r);'],
    ['missing-separator', 'const r = await tools.shell_command({command: "PRIVATE_NO_SEPARATOR"}) text(r);'],
    ['wrong-workdir-type', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", workdir: 42}); text(r);'],
    ['wrong-timeout-type', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", timeout_ms: "42"}); text(r);'],
    ['wrong-prefix-type', 'const r = await tools.shell_command({command: "PRIVATE_COMMAND", prefix_rule: ["git", 42]}); text(r);'],
    ['reserved-binding', 'const for = await tools.shell_command({command: "PRIVATE_RESERVED"}); text(for);'],
    ['literal-binding', 'const true = await tools.shell_command({command: "PRIVATE_LITERAL_BINDING"}); text(true);'],
    ['tools-binding', 'const tools = await tools.shell_command({command: "PRIVATE_TOOLS_BINDING"}); text(tools);'],
    ['text-binding', 'const text = await tools.shell_command({command: "PRIVATE_TEXT_BINDING"}); text(text);'],
  ]) {
    const event = normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call', id: `exec-${id}`, call_id: `exec-${id}-call`, name: 'exec', status: 'completed', input,
    } });
    assert.equal(event, null, `${id} exec input is omitted entirely`);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_/);
  }
  for (const name of ['EXEC', 'private.exec', 'tools.exec']) {
    const event = normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call', id: `exec-name-${name}`, call_id: `exec-name-${name}-call`, name, status: 'completed',
      input: 'const r = await tools.shell_command({command: "PRIVATE_INEXACT_NAME"}); text(r);',
    } });
    assert.equal(event.displayDetail, undefined, `${name} cannot publish exec detail`);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_INEXACT_NAME/);
  }
  assert.doesNotMatch(JSON.stringify([direct, escaped, fullOptions]), /PRIVATE_EXEC_OUTPUT|PRIVATE_EXEC_ARGUMENT|E:\/workspace|Allowed|git|status|use_default/);
});

test('strict multi exec wrappers publish bounded ordered display details and preserve duplicates', () => {
  const normalizer = createSessionNormalizer();
  const promise = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-multi-promise', call_id: 'exec-multi-promise-call',
    name: 'exec', status: 'completed',
    input: [
      'const results = await Promise.all([',
      'tools.shell_command({command: "Get-Item alpha", timeout_ms: 1000}),',
      'tools.shell_command({command: "Get-Item alpha", workdir: "E:/PRIVATE_MULTI_CWD"}),',
      'tools.shell_command({command: "pwsh --token PRIVATE_MULTI_TOKEN"})',
      ']); results.forEach(text);',
    ].join(''),
    output: 'PRIVATE_MULTI_OUTPUT', arguments: { token: 'PRIVATE_MULTI_ARGUMENT' },
  } });
  const forOf = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-multi-for-of', name: 'exec', status: 'completed',
    input: 'const rows = await Promise.all([tools.shell_command({command: "Get-Date"}), tools.shell_command({command: "Get-Location"})]); for (const row of rows) text(row);',
  } });
  const sequential = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-multi-sequential', name: 'exec', status: 'completed',
    input: 'const first = await tools.shell_command({command: "git status"}); text(first); const second = await tools.shell_command({command: "git diff"}); text(second);',
  } });

  assert.deepEqual(promise.displayDetails, [
    'Get-Item alpha', 'Get-Item alpha', 'pwsh --token <redacted>',
  ]);
  assert.equal(promise.displayDetail, undefined);
  assert.equal(promise.count, 3);
  assert.deepEqual(forOf.displayDetails, ['Get-Date', 'Get-Location']);
  assert.equal(forOf.count, 2);
  assert.deepEqual(sequential.displayDetails, ['git status', 'git diff']);
  assert.equal(sequential.count, 2);
  assert.doesNotMatch(JSON.stringify([promise, forOf, sequential]),
    /PRIVATE_MULTI_CWD|PRIVATE_MULTI_TOKEN|PRIVATE_MULTI_OUTPUT|PRIVATE_MULTI_ARGUMENT/);
});

test('static command object arrays mapped through shell command publish ordered duplicate details', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-static-map', name: 'exec', status: 'completed',
    input: [
      'const cmds = [',
      '{command: "Get-Date", workdir: "E:/PRIVATE_MAP_CWD", timeout_ms: 10000},',
      '{command: "Get-Date", workdir: "E:/PRIVATE_MAP_CWD", timeout_ms: 10000},',
      '{command: "pwsh --token PRIVATE_MAP_TOKEN", timeout_ms: 10000}',
      '];',
      'const results = await Promise.all(cmds.map(command => tools.shell_command(command)));',
      'results.forEach((result, index) => { text(`device ${index+1}`); text(result); });',
    ].join(''),
    output: 'PRIVATE_MAP_OUTPUT', arguments: { secret: 'PRIVATE_MAP_ARGUMENT' },
  } });

  assert.deepEqual(event.displayDetails, ['Get-Date', 'Get-Date', 'pwsh --token <redacted>']);
  assert.equal(event.count, 3);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_MAP/);
});

test('deferred sequential shell results publish only when consumed once in source order', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-deferred-sequential', name: 'exec', status: 'completed',
    input: [
      'const first = await tools.shell_command({command: "Get-Date", workdir: "E:/PRIVATE_DEFERRED"});',
      'const second = await tools.shell_command({command: "Get-Location", timeout_ms: 10000});',
      'text("first result"); text(first); text("second result"); text(second);',
    ].join(''),
  } });

  assert.deepEqual(event.displayDetails, ['Get-Date', 'Get-Location']);
  assert.equal(event.count, 2);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_DEFERRED|first result|second result/);
});

test('one exact exec pragma may precede an otherwise strict literal shell wrapper', () => {
  const normalizer = createSessionNormalizer();
  const event = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-pragma', name: 'exec', status: 'completed',
    input: '// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\r\n'
      + 'const result = await tools.shell_command({command: "Get-ChildItem -Force", workdir: "E:/PRIVATE_PRAGMA"}); text(result)',
  } });

  assert.equal(event.displayDetail, 'Get-ChildItem -Force');
  assert.equal(event.count, undefined);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_PRAGMA|yield_time|max_output/);
});

test('exact nested apply patch exposes only safe file metadata while unknown custom exec is omitted', () => {
  const normalizer = createSessionNormalizer();
  const patch = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-apply-patch', name: 'exec', status: 'completed',
    input: 'const patch = "*** Begin Patch\\n*** Update File: E:/PRIVATE_PATCH/file.js\\n@@\\n-SECRET_OLD\\n+SECRET_NEW\\n*** End Patch"; text(await tools.apply_patch(patch));',
    output: 'PRIVATE_PATCH_OUTPUT', arguments: 'PRIVATE_PATCH_ARGUMENTS',
  } });
  const unknown = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-unknown-nested', name: 'exec', status: 'completed',
    input: 'const value = await tools.future_tool({payload: "PRIVATE_UNKNOWN"}); text(value);',
  } });

  assert.deepEqual({ toolKind: patch.toolKind, state: patch.state, count: patch.count },
    { toolKind: 'file', state: 'succeeded', count: 1 });
  assert.equal(patch.displayDetail, '+1 -1');
  assert.equal(patch.fileLabel, 'file.js');
  assert.equal(patch.operation, 'edit');
  assert.equal(patch.operationKind, 'file');
  assert.equal(unknown, null);
  assert.doesNotMatch(JSON.stringify([patch, unknown]), /PRIVATE_|SECRET_|Begin Patch|Update File/);
});

test('one exact nested apply patch expands every file section in source order', () => {
  const normalizer = createSessionNormalizer();
  const patchText = [
    '*** Begin Patch',
    '*** Update File: E:/PRIVATE_ROOT/src/one.js',
    '@@',
    '-SECRET_ONE',
    '+replacement',
    '*** Add File: test/two.test.js',
    '+first',
    '+second',
    '+++literal-prefix',
    '*** Delete File: E:/PRIVATE_ROOT/old.js',
    '-SECRET_OLD',
    '*** End Patch',
  ].join('\n') + '\n';
  const rows = normalizer.normalizeMany({ type: 'response_item', payload: {
    type: 'custom_tool_call', id: 'exec-patch-many', name: 'exec', status: 'completed',
    input: `const patch = ${JSON.stringify(patchText)}; text(await tools.apply_patch(patch));`,
  } });

  assert.deepEqual(rows.map(row => [
    row.id, row.fileLabel, row.changeKind, row.operation, row.displayDetail,
  ]), [
    ['exec-patch-many:file:1', 'one.js', 'modified', 'edit', '+1 -1'],
    ['exec-patch-many:file:2', 'test/two.test.js', 'added', 'create', '+3 -0'],
    ['exec-patch-many:file:3', 'old.js', 'deleted', 'delete', '+0 -1'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_ROOT|SECRET_|Begin Patch|Update File|Add File|Delete File/);
});

test('mapped, deferred, pragma, and apply patch near misses fail closed as whole custom exec events', () => {
  const normalizer = createSessionNormalizer();
  const call = command => `{command: ${JSON.stringify(command)}, timeout_ms: 10000}`;
  const unsafe = [
    ['dynamic-device-map', 'const devices=["one","two"]; const results=await Promise.all(devices.map(device=>tools.shell_command({command:`hdc -t ${device} shell PRIVATE_DYNAMIC`}))); results.forEach(text);'],
    ['mapped-dynamic-value', `const cmds=[${call('SAFE_ONE')},{command: PRIVATE_DYNAMIC}]; const results=await Promise.all(cmds.map(command=>tools.shell_command(command))); results.forEach(text);`],
    ['mapped-parameter-mismatch', `const cmds=[${call('SAFE_ONE')},${call('SAFE_TWO')}]; const results=await Promise.all(cmds.map(command=>tools.shell_command(other))); results.forEach(text);`],
    ['mapped-side-effect-label', `const cmds=[${call('SAFE_ONE')},${call('SAFE_TWO')}]; const results=await Promise.all(cmds.map(command=>tools.shell_command(command))); results.forEach((result,index)=>{text(tools.apply_patch("PRIVATE_LABEL"));text(result);});`],
    ['mapped-side-effect-template', `const cmds=[${call('SAFE_ONE')},${call('SAFE_TWO')}]; const results=await Promise.all(cmds.map(command=>tools.shell_command(command))); results.forEach((result,index)=>{text(\`label \${tools.apply_patch("PRIVATE_TEMPLATE_LABEL")}\`);text(result);});`],
    ['deferred-out-of-order', `const first=await tools.shell_command(${call('SAFE_ONE')}); const second=await tools.shell_command(${call('SAFE_TWO')}); text(second); text(first);`],
    ['deferred-duplicate-result', `const first=await tools.shell_command(${call('SAFE_ONE')}); const second=await tools.shell_command(${call('SAFE_TWO')}); text(first); text(first); text(second);`],
    ['pragma-near-miss', `// @execx: PRIVATE_PRAGMA\nconst result=await tools.shell_command(${call('SAFE_ONE')});text(result);`],
    ['pragma-extra-comment', `// @exec: PRIVATE_PRAGMA\n// PRIVATE_SECOND_COMMENT\nconst result=await tools.shell_command(${call('SAFE_ONE')});text(result);`],
    ['patch-template', 'const patch = `PRIVATE_PATCH_TEMPLATE`; text(await tools.apply_patch(patch));'],
    ['patch-wrong-binding', 'const patch = "PRIVATE_PATCH"; text(await tools.apply_patch(other));'],
    ['patch-trailing-tool', 'const patch = "PRIVATE_PATCH"; text(await tools.apply_patch(patch)); text(await tools.future_tool());'],
  ];

  for (const [id, input] of unsafe) {
    const event = normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call', id: `exec-near-miss-${id}`, name: 'exec', status: 'completed', input,
    } });
    assert.equal(event, null, `${id} is omitted atomically`);
  }
});

test('multi exec detail fails closed atomically for unsafe siblings, ambiguity, and hard limits', () => {
  const normalizer = createSessionNormalizer();
  const call = command => `tools.shell_command({command: ${JSON.stringify(command)}})`;
  const tooMany = Array.from({ length: 33 }, (_, index) => call(`command-${index}`)).join(',');
  const tooLarge = Array.from({ length: 9 }, (_, index) => call(`${index}-${'x'.repeat(1000)}`)).join(',');
  const unsafe = [
    ['dynamic-command', `const r = await Promise.all([${call('SAFE_ONE')}, tools.shell_command({command: PRIVATE_DYNAMIC})]); r.forEach(text);`],
    ['other-tool', `const r = await Promise.all([${call('SAFE_ONE')}, tools.apply_patch("PRIVATE_PATCH")]); r.forEach(text);`],
    ['unknown-key', `const r = await Promise.all([${call('SAFE_ONE')}, tools.shell_command({command: "PRIVATE_UNKNOWN", private: true})]); r.forEach(text);`],
    ['comment', `const r = await Promise.all([${call('SAFE_ONE')}, /* PRIVATE_COMMENT */ ${call('PRIVATE_COMMENT_COMMAND')}]); r.forEach(text);`],
    ['template', `const r = await Promise.all([${call('SAFE_ONE')}, tools.shell_command({command: \`PRIVATE_TEMPLATE\`})]); r.forEach(text);`],
    ['trailing-tool', `const r = await Promise.all([${call('SAFE_ONE')}, ${call('SAFE_TWO')}]); r.forEach(text); await tools.apply_patch("PRIVATE_TAIL");`],
    ['duplicate-binding', 'const r = await tools.shell_command({command: "PRIVATE_FIRST"}); text(r); const r = await tools.shell_command({command: "PRIVATE_SECOND"}); text(r);'],
    ['promise-binding', `const Promise = await Promise.all([${call('SAFE_ONE')}, ${call('SAFE_TWO')}]); Promise.forEach(text);`],
    ['missing-call-separator', `await tools.shell_command({command: "SAFE_ONE"}) await tools.shell_command({command: "PRIVATE_NO_SEPARATOR"})`],
    ['missing-consumer-separator', 'const first = await tools.shell_command({command: "SAFE_ONE"}); text(first) const second = await tools.shell_command({command: "PRIVATE_NO_SEPARATOR"}); text(second);'],
    ['unknown-sandbox', `const r = await Promise.all([${call('SAFE_ONE')}, tools.shell_command({command: "PRIVATE_ENUM", sandbox_permissions: "future_private_mode"})]); r.forEach(text);`],
    ['empty-sibling', `const r = await Promise.all([${call('SAFE_ONE')}, ${call('')}]); r.forEach(text);`],
    ['too-many', `const r = await Promise.all([${tooMany}]); r.forEach(text);`],
    ['too-large', `const r = await Promise.all([${tooLarge}]); r.forEach(text);`],
  ];

  for (const [id, input] of unsafe) {
    const event = normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call', id: `exec-multi-${id}`, name: 'exec', status: 'completed', input,
    } });
    assert.equal(event, null, `${id} drops the whole custom exec event`);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|SAFE_ONE|SAFE_TWO/);
  }
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
      { type: 'input_text', text: '# Files mentioned by the user:\n## a.png: C:/private/a.png\n## spec.txt: C:/private/spec.txt\n## My request for Codex:\n查看图片' },
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
  assert.deepEqual(response.attachments.map(item => item.name), ['a.png', 'spec.txt']);
  assert.deepEqual(event.attachments.map(item => item.name), ['a.png']);
  assert.equal(JSON.stringify(response).includes('base64'), false);
  assert.equal(JSON.stringify(response).includes('C:/private'), false);
});

test('normalizer rejects only a strict Codex environment injection at the source boundary', () => {
  const normalizer = createNormalizer({ session: { isSubagent: false } });
  const internal = [
    '<environment_context>',
    '  <current_date>2026-07-16</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>E:/workspace</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>',
    '</environment_context>',
  ].join('\n');
  assert.equal(normalizer.normalize(responseMessage('user', '', internal, 'turn-internal')), null);

  const bulletSubagentsInternal = [
    '<environment_context>',
    '  <cwd>E:/workspace</cwd>',
    '  <shell>powershell</shell>',
    '  <current_date>2026-07-16</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>E:/workspace</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>',
    '  <subagents>',
    '    - redacted_task: RedactedAgent',
    '    - audit_worker: running',
    '  </subagents>',
    '</environment_context>',
  ].join('\n');
  assert.equal(normalizer.normalize(responseMessage('user', '', bulletSubagentsInternal,
    'turn-internal-bullet-subagents')), null,
  'the real Codex bullet-list subagent shape is recognized as a strict internal context');

  const multipart = normalizer.normalize(sessionItem('response_item', {
    type: 'message', role: 'user',
    content: [
      { type: 'input_text', text: '真实用户正文' },
      { type: 'input_text', text: internal },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-multipart' },
  }));
  assert.equal(multipart.text, '真实用户正文',
    'a strict environment part is removed structurally without removing its visible sibling part');
  assert.equal(JSON.stringify(multipart).includes('<environment_context>'), false);

  assert.equal(normalizer.normalize(sessionItem('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: internal }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-pure-internal-part' },
  })), null, 'a response containing only an internal part creates no public user event');

  for (const text of [
    '<environment_context>请解释这个标签</environment_context>',
    '<environment_context>\n  <example>用户提供的 XML 示例</example>\n</environment_context>',
    '<environment_context>\n  <subagents>\n    - redacted_task: running\n    用户自由正文\n  </subagents>\n</environment_context>',
    '<environment_context>\n  <unknown_field>value</unknown_field>\n</environment_context>',
  ]) {
    assert.equal(normalizer.normalize(responseMessage('user', '', text, 'turn-user')).text, text,
      'root-shaped ordinary user XML is not mistaken for a Codex injection');
  }
});

test('normalizer removes desktop-hidden bootstrap parts without hiding the real user message', () => {
  const normalizer = createNormalizer({ session: { isSubagent: false } });
  const recommendedPlugins = [
    '<recommended_plugins>',
    'Here is a list of plugins that are available but not installed.',
    '- Example (example@openai-curated-remote)',
    '</recommended_plugins>',
  ].join('\n');
  const agentsInstructions = [
    '# AGENTS.md instructions for E:\\workspace',
    '',
    '<INSTRUCTIONS>',
    '# Local execution safety',
    'Do not mutate the active task.',
    '</INSTRUCTIONS>',
  ].join('\n');
  const internalEnvironment = [
    '<environment_context>',
    '  <cwd>E:/workspace</cwd>',
    '  <shell>powershell</shell>',
    '  <current_date>2026-07-17</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>E:/workspace</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>',
    '</environment_context>',
  ].join('\n');
  const event = normalizer.normalize(sessionItem('response_item', {
    type: 'message', role: 'user',
    content: [
      { type: 'input_text', text: recommendedPlugins },
      { type: 'input_text', text: agentsInstructions },
      { type: 'input_text', text: internalEnvironment },
      { type: 'input_text', text: 'Reply exactly VISIBLE_USER_MESSAGE.' },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-bootstrap-filter' },
  }));
  assert.equal(event.text, 'Reply exactly VISIBLE_USER_MESSAGE.');
  assert.equal(JSON.stringify(event).includes('recommended_plugins'), false);
  assert.equal(JSON.stringify(event).includes('AGENTS.md instructions'), false);
});

test('current managed permission environment context stays desktop-hidden', () => {
  const normalizer = createNormalizer();
  const hidden = normalizer.normalize(sessionItem('response_item', {
    type: 'message', role: 'user', content: [{ type: 'input_text', text:
      '<environment_context>\n  <cwd>E:\\\\workspace</cwd>\n  <shell>powershell</shell>\n  <current_date>2026-07-17</current_date>\n  <timezone>Asia/Shanghai</timezone>\n  <filesystem><workspace_roots><root>E:\\\\workspace</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>\n</environment_context>'
    }]
  }));
  assert.equal(hidden, null);
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
  assert.deepEqual(
    [commentary.phase, planning.phase, reasoning.phase],
    ['commentary', 'plan', 'reasoning_summary'],
  );
  assert.equal(JSON.stringify([commentary, planning, reasoning]).includes('hidden'), false);
});

test('current ChatGPT turn_aborted closes the active turn as interrupted', () => {
  const normalizer = createNormalizer();
  normalizer.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-aborted-current' }));
  const terminal = normalizer.normalize(sessionItem('event_msg', {
    type: 'turn_aborted', turn_id: 'turn-aborted-current', reason: 'interrupted'
  }));
  assert.equal(terminal.state, 'interrupted');
  const next = normalizer.normalize(responseMessage('user', '', '终止后的新输入', 'turn-next'));
  assert.equal(next.delivery, 'initial');
});

test('summarizes tool calls without exposing arguments or outputs', () => {
  const normalizer = createNormalizer();
  const call = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-safe',
    arguments: JSON.stringify({ command: 'node tests/smoke.mjs --token=PRIVATE_TOKEN' }),
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
  assert.equal(call.displayDetail, '<redacted command>');
  assert.equal(output, null);
  assertNoSecretCanaries(assert, [call, output]);
});

test('current function shell calls publish only their sanitized visible command', () => {
  const normalizer = createNormalizer();
  const call = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call', name: 'shell_command', call_id: 'call-current-shell',
    arguments: JSON.stringify({ command: 'node tests/realtimeContract.test.mjs', workdir: 'E:/private/worktree' }),
  }));

  assert.equal(call.toolKind, 'command');
  assert.equal(call.displayDetail, 'node tests/realtimeContract.test.mjs');
  assert.doesNotMatch(JSON.stringify(call), /private\/worktree|workdir|arguments/);
});

test('current direct apply_patch expands safe file rows with diff statistics', () => {
  const normalizer = createNormalizer();
  const rows = normalizer.normalizeMany(sessionItem('response_item', {
    type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-current-direct',
    input: '*** Begin Patch\n*** Update File: entry/src/main/ets/pages/Index.ets\n@@\n-old\n+new\n+extra\n*** Add File: tests/new.test.mjs\n+first\n+second\n*** End Patch',
  }));

  assert.deepEqual(rows.map(row => ({ fileLabel: row.fileLabel, changeKind: row.changeKind,
    operation: row.operation, displayDetail: row.displayDetail })), [
    { fileLabel: 'entry/src/main/ets/pages/Index.ets', changeKind: 'modified', operation: 'edit', displayDetail: '+2 -1' },
    { fileLabel: 'tests/new.test.mjs', changeKind: 'added', operation: 'create', displayDetail: '+2 -0' },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /\+old|\+new|\+first|\+second|"input"/);
});

test('collaboration wait lifecycle is never published as a generic tool row', () => {
  const normalizer = createNormalizer();
  const call = normalizer.normalize(sessionItem('response_item', {
    type: 'function_call', name: 'wait', call_id: 'wait-call',
    arguments: JSON.stringify({ cell_id: 'PRIVATE_CELL' }),
  }));
  const custom = normalizer.normalize(sessionItem('response_item', {
    type: 'custom_tool_call', name: 'wait', call_id: 'wait-custom', input: 'PRIVATE_INPUT',
  }));
  assert.equal(call, null);
  assert.equal(custom, null);
});

test('current fileChange and turnDiff derive only safe file presentation metadata', () => {
  const normalizer = createNormalizer();
  const fileChange = normalizer.normalize(appServerItem('fileChange', {
    changes: [{ path: 'E:\\private\\workspace\\src\\server.js', kind: { type: 'update' }, diff: SECRET_BODY }],
    status: 'completed',
  }));
  const turnDiff = normalizer.normalize(appServerItem('turnDiff', {
    diff: `diff --git a/lib/public.js b/lib/public.js\n${SECRET_BODY}`,
    status: 'completed',
  }));

  assert.equal(fileChange.fileLabel, 'server.js');
  assert.equal(fileChange.changeKind, 'modified');
  assert.equal(turnDiff.fileLabel, 'lib/public.js');
  assert.equal(turnDiff.changeKind, 'modified');
  const serialized = JSON.stringify([fileChange, turnDiff]);
  assert.doesNotMatch(serialized, /E:\\\\private|SECRET_SUBAGENT_BODY_CANARY/);
  assert.equal(Object.hasOwn(fileChange, 'diff'), false);
  assert.equal(Object.hasOwn(turnDiff, 'diff'), false);
});

test('fileChange expands every real change into safe ordered file items with exact diff statistics', () => {
  const normalizer = createNormalizer();
  const rows = normalizer.normalizeMany(appServerItem('fileChange', {
    id: 'file-batch',
    changes: [
      {
        path: 'E:\\private-workspace\\src\\server.js',
        kind: { type: 'update' },
        diff: '@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n unchanged\n',
      },
      {
        path: 'lib/public.js',
        kind: { type: 'add' },
        diff: '--- /dev/null\n+++ b/lib/public.js\n@@ -0,0 +1,2 @@\n+first\n+second\n',
      },
    ],
    status: 'completed',
  }));

  assert.deepEqual(rows.map(row => ({
    id: row.id,
    operationKind: row.operationKind,
    operation: row.operation,
    fileLabel: row.fileLabel,
    changeKind: row.changeKind,
    displayDetail: row.displayDetail,
    count: row.count,
  })), [
    {
      id: 'file-batch:file:1', operationKind: 'file', operation: 'edit',
      fileLabel: 'server.js', changeKind: 'modified', displayDetail: '+2 -1', count: 1,
    },
    {
      id: 'file-batch:file:2', operationKind: 'file', operation: 'create',
      fileLabel: 'lib/public.js', changeKind: 'added', displayDetail: '+2 -0', count: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /private-workspace|@@|old|new|first|second|\/dev\/null|"diff"/i);
});

test('file child projection rejects URL and credential-like labels and never invents non-hunk statistics', () => {
  const normalizer = createNormalizer();
  const rows = normalizer.normalizeMany(appServerItem('fileChange', {
    id: 'file-hostile', status: 'completed',
    changes: [
      { path: 'file:///C:/private/root.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'https://private.example/token.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'C:\\private\\password=TOP_SECRET.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: '../private/nested.js', kind: { type: 'update' }, diff: 'Binary files differ' },
    ],
  }));

  assert.deepEqual(rows.map(row => ({ id: row.id, fileLabel: row.fileLabel, displayDetail: row.displayDetail })), [
    { id: 'file-hostile:file:4', fileLabel: 'nested.js', displayDetail: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /file:\/\/\/|https:|private\.example|TOP_SECRET|password=/i);
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
  const updated = normalizer.normalize(subagentActivity('interacted'));

  assert.equal(started.type, 'summary');
  assert.equal(started.summaryKind, 'subagent');
  assert.equal(started.text, 'private-secret-agent-path 已开始工作');
  assert.equal(updated.text, 'private-secret-agent-path 已更新');
  assert.deepEqual(started.subagent, {
    name: 'private-secret-agent-path',
    state: 'running',
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

test('projects static exec view_image ImageContent output without retaining the data URL', () => {
  const normalizer = createNormalizer();
  const filePath = `${SYNTHETIC_IMAGE_DIR}\\exec-viewed.png`;
  const callId = 'exec-view-image-output';
  const call = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed',
    input: `const r = await tools.view_image({path:${JSON.stringify(filePath)},detail:"original"}); image(r.image_url);`,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-exec-image' },
  } });
  const image = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [
      { type: 'input_text', text: SECRET_OUTPUT },
      { type: 'input_image', image_url: VALID_PNG_DATA_URL },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-exec-image' },
  } });

  assert.equal(call, null);
  assert.equal(image.toolKind, 'imageView');
  assert.equal(image.turnId, 'turn-exec-image');
  assert.equal(image.count, 1);
  assert.equal(image.attachments.length, 1);
  assert.equal(image.attachments[0].name, 'exec-viewed.png');
  assert.equal(getPrivateAttachmentSource(image.attachments[0]), filePath);
  assert.doesNotMatch(JSON.stringify(image), /base64|SECRET_/);
  assert.equal(JSON.stringify(image).includes(SYNTHETIC_IMAGE_DIR), false);
});

test('projects the current view_image wrapper when Codex also reports image detail', () => {
  const normalizer = createNormalizer();
  const filePath = `${SYNTHETIC_IMAGE_DIR}\\current-wrapper.png`;
  const callId = 'exec-current-view-image-wrapper';
  const call = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed',
    input: `const r=await tools.view_image({path:${JSON.stringify(filePath)},detail:"original"}); image(r.image_url); text(r.detail)`,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-current-image-wrapper' },
  } });
  const image = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [
      { type: 'input_image', image_url: VALID_PNG_DATA_URL },
      { type: 'input_text', text: 'original' },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-current-image-wrapper' },
  } });

  assert.equal(call, null);
  assert.equal(image.toolKind, 'imageView');
  assert.equal(image.turnId, 'turn-current-image-wrapper');
  assert.equal(image.count, 1);
  assert.equal(image.attachments[0].name, 'current-wrapper.png');
  assert.equal(getPrivateAttachmentSource(image.attachments[0]), filePath);
  assert.doesNotMatch(JSON.stringify(image), /base64|original/);
  assert.equal(JSON.stringify(image).includes(SYNTHETIC_IMAGE_DIR), false);
});

test('current view_image detail wrapper still fails closed when the detail belongs to another value', () => {
  const normalizer = createNormalizer();
  const callId = 'exec-mismatched-view-image-detail';
  normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId,
    input: `const r=await tools.view_image({path:${JSON.stringify(`${SYNTHETIC_IMAGE_DIR}\\mismatch.png`)}}); image(r.image_url); text(other.detail)`,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-mismatched-image-detail' },
  } });
  const image = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [{ type: 'input_image', image_url: VALID_PNG_DATA_URL }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-mismatched-image-detail' },
  } });

  assert.equal(image, null);
});

test('uses actual ImageContent count for a static multi-view exec and fails closed for unrelated output', () => {
  const normalizer = createNormalizer();
  const paths = ['one.png', 'two.png', 'three.png', 'four.png']
    .map(name => `${SYNTHETIC_IMAGE_DIR}\\${name}`);
  const callId = 'exec-multi-view-image-output';
  normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed',
    input: `const paths=${JSON.stringify(paths)}; const rs=await Promise.all(paths.map(path=>tools.view_image({path,detail:"original"}))); rs.forEach((r,i)=>{text(paths[i]);image(r.image_url);});`,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-multi-image' },
  } });
  const image = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [
      { type: 'input_text', text: 'safe label' },
      ...paths.map(() => ({ type: 'input_image', image_url: VALID_PNG_DATA_URL })),
    ],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-multi-image' },
  } });

  normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'exec-unrelated-image', status: 'completed',
    input: 'image("data:image/png;base64,PRIVATE")',
  } });
  const unrelated = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'exec-unrelated-image',
    output: [{ type: 'input_image', image_url: `data:image/png;base64,${SECRET_BODY}` }],
  } });

  assert.equal(image.count, 4);
  assert.deepEqual(image.attachments.map(item => item.name), paths.map(item => item.split('\\').pop()));
  assert.deepEqual(image.attachments.map(getPrivateAttachmentSource), paths);
  assert.equal(unrelated, null);
  assert.doesNotMatch(JSON.stringify(image), /base64|SECRET_/);
  assert.equal(JSON.stringify(image).includes(SYNTHETIC_IMAGE_DIR), false);
});

test('projects a static filename map consumed by a view_image for-of loop', () => {
  const normalizer = createNormalizer();
  const names = ['wide.png', 'phone.png', 'fold.png', 'tablet.png'];
  const paths = names.map(name => `${SYNTHETIC_IMAGE_DIR}\\${name}`);
  const callId = 'exec-template-view-images';
  const template = `${SYNTHETIC_IMAGE_DIR.replace(/\\/g, '\\\\')}\\\\\${n}`;
  normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId,
    input: `const paths=${JSON.stringify(names)}.map(n=>\`${template}\`); for(const p of paths){const r=await tools.view_image({path:p,detail:"original"}); image(r.image_url)}`,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-template-images' },
  } });
  const image = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: paths.map(() => ({ type: 'input_image', image_url: VALID_PNG_DATA_URL })),
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-template-images' },
  } });

  assert.equal(image.count, 4);
  assert.deepEqual(image.attachments.map(item => item.name), names);
  assert.deepEqual(image.attachments.map(getPrivateAttachmentSource), paths);
  assertNoSecretCanaries(assert, image);
  assert.equal(JSON.stringify(image).includes(SYNTHETIC_IMAGE_DIR), false);
});

test('exec image output fails closed unless producer, valid paths, and verified images have equal counts', () => {
  const cases = [
    {
      id: 'too-many-output-images',
      paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`],
      output: [VALID_PNG_DATA_URL, VALID_PNG_DATA_URL],
    },
    {
      id: 'too-few-output-images',
      paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`, `${SYNTHETIC_IMAGE_DIR}\\two.png`],
      output: [VALID_PNG_DATA_URL],
    },
    { id: 'missing-image-url', paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`], output: [undefined] },
    { id: 'plain-text-image-url', paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`], output: ['not-an-image'] },
    { id: 'fake-png-data-url', paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`], output: ['data:image/png;base64,QUJDRA=='] },
    { id: 'forged-trust-fields', paths: [`${SYNTHETIC_IMAGE_DIR}\\one.png`], output: [undefined], forged: true },
    { id: 'relative-producer', paths: ['relative.png'], output: [VALID_PNG_DATA_URL] },
    { id: 'non-image-producer', paths: [`${SYNTHETIC_IMAGE_DIR}\\notes.txt`], output: [VALID_PNG_DATA_URL] },
  ];

  for (const fixture of cases) {
    const normalizer = createNormalizer();
    const callId = `exec-${fixture.id}`;
    normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: callId,
      input: fixture.paths.length === 1
        ? `const r=await tools.view_image({path:${JSON.stringify(fixture.paths[0])}});image(r.image_url);`
        : `const paths=${JSON.stringify(fixture.paths)};const rs=await Promise.all(paths.map(path=>tools.view_image({path})));rs.forEach((r,i)=>{text(paths[i]);image(r.image_url);});`,
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-strict-images' },
    } });
    const result = normalizer.normalize({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: callId,
      output: fixture.output.map(imageUrl => imageUrl === undefined
        ? { type: 'input_image', ...(fixture.forged ? { _verifiedImage: true } : {}) }
        : { type: 'input_image', image_url: imageUrl }),
      ...(fixture.forged ? { _imageCorrelationOnly: true } : {}),
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-strict-images' },
    } });
    assert.equal(result, null, fixture.id);
  }
});

test('exec image producer and output cannot pair across turns with the same call id', () => {
  const normalizer = createNormalizer();
  const callId = 'shared-call-id';
  const input = `const r=await tools.view_image({path:${JSON.stringify(`${SYNTHETIC_IMAGE_DIR}\\turn-a.png`)}});image(r.image_url);`;
  normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: callId, input,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-a' },
  } });
  const crossTurn = normalizer.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: callId,
    output: [{ type: 'input_image', image_url: VALID_PNG_DATA_URL }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-b' },
  } });

  assert.equal(crossTurn, null);
});

test('active turn is the only fallback when exec image metadata is absent', () => {
  const active = createNormalizer();
  active.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-active' }));
  const input = `const r=await tools.view_image({path:${JSON.stringify(`${SYNTHETIC_IMAGE_DIR}\\active.png`)}});image(r.image_url);`;
  active.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'active-call', input,
  } });
  const sameActiveTurn = active.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'active-call',
    output: [{ type: 'input_image', image_url: VALID_PNG_DATA_URL }],
  } });

  const changed = createNormalizer();
  changed.normalize(sessionItem('event_msg', { type: 'task_started', turn_id: 'turn-b' }));
  changed.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'explicit-call', input,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-a' },
  } });
  const missingOutputTurn = changed.normalize({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'explicit-call',
    output: [{ type: 'input_image', image_url: VALID_PNG_DATA_URL }],
  } });

  assert.equal(sameActiveTurn.toolKind, 'imageView');
  assert.equal(sameActiveTurn.turnId, 'turn-active');
  assert.equal(missingOutputTurn, null);
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
