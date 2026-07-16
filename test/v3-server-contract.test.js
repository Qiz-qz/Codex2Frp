'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactDiagnosticString } = require('../lib/diagnostics/diagnostic-report');
const { createSessionNormalizer } = require('../lib/events/session-normalizer');
const { EventReconciler } = require('../lib/events/reconciler');
const { buildTurnViews } = require('../lib/events/turn-view-builder');
const {
  getPrivateAttachmentSource,
  setPrivateAttachmentSource,
} = require('../lib/events/private-attachment-source');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const index = asyncStart >= 0 && (start < 0 || asyncStart < start) ? asyncStart : start;
  assert.notEqual(index, -1, `${name} exists`);
  const signatureEnd = source.indexOf(') {', index);
  const brace = signatureEnd >= 0 ? signatureEnd + 2 : source.indexOf('{', index);
  let depth = 0;
  for (let cursor = brace; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, cursor);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const brace = source.indexOf(') {', start) + 2;
  return `${source.slice(start, brace + 1)}${functionBody(name)}}`;
}

function attachmentMapper(overrides = {}) {
  const trustedCapabilitySource = source.includes('function trustedLocalCapabilityUrl(')
    ? functionSource('trustedLocalCapabilityUrl')
    : '';
  const attachmentFilePathSource = functionSource('attachmentFilePath');
  return new Function(
    'path', 'URL', 'INLINE_ATTACHMENT_BYTES', 'imageMimeTypeForFile',
    'registerOutputAttachment', 'requestBaseUrl', 'inlineAttachmentDataUrl', 'redactDiagnosticString',
    'capabilityAttachmentFile', 'getPrivateAttachmentSource',
    `${attachmentFilePathSource}${trustedCapabilitySource}${functionSource('enrichAttachmentList')} return enrichAttachmentList;`,
  )(
    path,
    URL,
    512 * 1024,
    () => 'image/*',
    overrides.registerOutputAttachment || (() => null),
    () => 'http://phone.local',
    () => '',
    redactDiagnosticString,
    overrides.capabilityAttachmentFile || (() => null),
    getPrivateAttachmentSource,
  );
}

function imageValidator() {
  return new Function(
    'fs', 'path', 'Buffer', 'MAX_OUTPUT_ATTACHMENT_BYTES', 'imageMimeTypeForFile',
    `${functionSource('validatedImageFile')} return validatedImageFile;`,
  )(fs, path, Buffer, 32 * 1024 * 1024, new Function(
    'path',
    `${functionSource('imageMimeTypeForFile')} return imageMimeTypeForFile;`,
  )(path));
}

test('production server owns one lazy v3 app-server runtime with persistent queue', () => {
  assert.match(source, /AppServerRuntime/);
  assert.match(source, /V3ApiRouter/);
  assert.match(source, /discoverCodexExecutable/);
  assert.match(source, /detectCodexCliVersion/);
  assert.match(source, /selectBridgeSchemaProfile/);
  assert.match(functionBody('createV3Bridge'), /selectBridgeSchemaProfile\(\{/);
  assert.doesNotMatch(functionBody('createV3Bridge'), /profileFileForCliVersion/);
  assert.match(source, /TurnInputQueue/);
  assert.match(source, /PendingRequestStore/);
  assert.match(source, /turn-input-queue\.json/);
  assert.match(source, /serverRequestSink:\s*request => handleV3ServerRequest\(pendingRequestStore, request\)/);
  assert.match(source, /serverRequestLifecycleSink:\s*event => handleV3ServerRequestLifecycle\(pendingRequestStore, event\)/);
  assert.match(source, /notificationSink:\s*notification => handleV3Notification\(eventRuntime, pendingRequestStore, notification\)/);
  assert.match(functionBody('handleV3Notification'), /serverRequest\/resolved[\s\S]*resolveServerRequest/);
  assert.match(functionBody('handleV3ServerRequestLifecycle'), /connectionClosed[\s\S]*expireConnectionEpoch/);
  assert.match(source, /function handleV3ServerRequest[\s\S]*currentTimeAt/);
  assert.match(source, /function handleV3ServerRequest[\s\S]*item\/tool\/call[\s\S]*success:\s*false/);
  assert.match(source, /CODEX2FRP_APP_SERVER_REQUEST_TIMEOUT_MS\s*\|\|\s*20000/,
    'production RPC timeout covers real thread startup latency');
  assert.match(source, /new AppServerProcessManager\(\{[\s\S]*requestTimeoutMs:\s*CODEX_APP_SERVER_REQUEST_TIMEOUT_MS[\s\S]*\}\)/,
    'the production process manager receives the explicit request timeout');
  assert.match(functionBody('createV3Bridge'), /supportedMethods:\s*profile\.requestMethods/,
    'production capabilities consume the negotiated profile method inventory');
  assert.match(functionBody('createV3Bridge'), /confirmedNativeControls:\s*true/,
    'production mutations use the confirmed native control facade');
  assert.match(source, /const queueCommandCoordinator = new CommandCoordinator\(\{ guard \}\)/,
    'queue persistence has its own lock and cannot recursively acquire the RPC mutation lock');
  assert.match(source, /createBridgeV3Router\(\{[\s\S]*?queueCommandCoordinator,[\s\S]*?\}\)/);
});

test('server installs the desktop request bridge before renderer RPC and synchronizes request listing', () => {
  assert.match(source, /new DesktopServerRequestBridge\s*\(/);
  assert.match(source, /beforeInvoke:\s*\(\)\s*=>\s*desktopServerRequestBridge\.synchronize\(\)/);
  assert.match(source, /pendingRequestStore\.setSynchronizer\s*\(\s*\(\)\s*=>\s*desktopServerRequestBridge\.synchronize\(\)/);
});

test('v3 dispatch authenticates before parsing or starting the lazy runtime', () => {
  const body = functionBody('handleV3ApiRequest');
  assert.match(body, /isAuthorized\(req\)/);
  assert.match(body, /readBody\(req\)/);
  assert.ok(body.indexOf('isAuthorized(req)') < body.indexOf('readBody(req)'), 'auth precedes body parsing');
  assert.match(body, /v3ApiRouter\.handle/);
  assert.doesNotMatch(body, /restoreCodexDesktopWindow|activateCodexThread|bringToFront|SetForegroundWindow/);
  assert.match(source, /eventRuntime/);
  assert.match(source, /ProductionEventRuntime/);
});

test('HTTP surface supports queue edit and cancellation verbs and shuts down only owned app-server', () => {
  assert.match(functionBody('corsHeaders'), /GET,POST,PUT,PATCH,DELETE,OPTIONS/);
  assert.match(source, /req\.url\.startsWith\('\/codex\/v3\/'\)/);
  assert.match(source, /stopV3Runtime/);
  assert.match(functionBody('stopV3Runtime'), /eventRuntime\.stop\(\)/);
});

test('production server shares one dynamic protection registry across RPC, queue, and UI guards', () => {
  assert.match(source, /new ThreadProtectionRegistry\(/);
  assert.match(source, /protected-threads\.json/);
  assert.match(source, /createDynamicProtectedThreadGuard\(\{[\s\S]*?registry: threadProtectionRegistry/);
  assert.match(source, /protectionRegistry: threadProtectionRegistry/);
  assert.match(source, /threadProtectionRegistry\.summary\(\)\.protectedCount/);
  assert.doesNotMatch(source, /explicitUiProtectedThreadGuard\.protectedThreadIds\.size/);
});

test('output images use bounded opaque capability URLs without paths or tokens', () => {
  assert.match(source, /OUTPUT_ATTACHMENT_HANDLE_PATTERN/);
  assert.match(source, /OUTPUT_ATTACHMENT_TTL_MS/);
  assert.match(functionBody('registerOutputAttachment'), /createHmac\('sha256'/);
  assert.match(source, /\/codex\/attachment\/\$\{registered\.handle\}/);
  assert.doesNotMatch(source, /\/codex\/attachment\/\$\{registered\.handle\}[^\n]*(?:path|token)=/);
  assert.match(functionBody('validatedImageFile'), /realpathSync/);
  assert.match(functionBody('validatedImageFile'), /MAX_OUTPUT_ATTACHMENT_BYTES/);
  assert.match(functionBody('handleAttachment'), /x-content-type-options/);
});

test('output image validation trusts verified magic MIME when a supported image suffix is misleading', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-magic-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const misleadingJpeg = path.join(root, 'hdc-snapshot.jpeg');
  const unknownSuffix = path.join(root, 'hdc-snapshot.bin');
  const forgedJpeg = path.join(root, 'forged.jpeg');
  const disguisedHeic = path.join(root, 'disguised-heic.jpeg');
  fs.writeFileSync(misleadingJpeg, pngBytes);
  fs.writeFileSync(unknownSuffix, pngBytes);
  fs.writeFileSync(forgedJpeg, Buffer.from('not an image', 'utf8'));
  fs.writeFileSync(disguisedHeic, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]));

  const validate = imageValidator();
  assert.equal(validate(misleadingJpeg).mimeType, 'image/png');
  assert.equal(validate(unknownSuffix), null, 'the path still needs a supported image suffix');
  assert.equal(validate(forgedJpeg), null, 'the suffix alone never bypasses magic validation');
  assert.equal(validate(disguisedHeic), null, 'HEIC content cannot masquerade behind a JPEG suffix');
});

test('attachment mapper preserves safe metadata without inventing a click target', () => {
  const mapped = attachmentMapper()([
    { name: 'report.png', mimeType: 'image/png', size: 1234 },
  ], {}, { inlineData: false });

  assert.deepEqual(mapped, [{
    name: 'report.png',
    mime: 'image/png',
    mimeType: 'image/png',
    size: 1234,
  }]);
});

test('attachment mapper publishes only locally registered capabilities on the trusted request origin', () => {
  const mapped = attachmentMapper()([
    { name: 'token.png', mimeType: 'image/png', url: 'https://cdn.example/a.png?token=TOKEN_CANARY' },
    { name: 'signed.png', mimeType: 'image/png', url: 'https://cdn.example/a.png?X-Amz-Signature=SIGNATURE_CANARY' },
    { name: 'fragment.png', mimeType: 'image/png', url: 'https://cdn.example/a.png#SECRET_FRAGMENT' },
    { name: 'userinfo.png', mimeType: 'image/png', url: 'https://user:pass@cdn.example/a.png' },
    { name: 'safe.png', mimeType: 'image/png', url: 'https://cdn.example/a.png' },
    { name: 'foreign.png', mimeType: 'image/png', url: 'https://evil.example/codex/attachment/0123456789abcdef0123456789abcdef' },
    { name: 'unregistered.png', mimeType: 'image/png', url: '/codex/attachment/0123456789abcdef0123456789abcdef' },
  ], {}, { inlineData: false });
  const serialized = JSON.stringify(mapped);

  for (const secret of ['TOKEN_CANARY', 'SIGNATURE_CANARY', 'SECRET_FRAGMENT', 'user:pass']) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  assert.equal(mapped.filter(item => item.url).length, 0);
  assert.equal(mapped.find(item => item.name === 'token.png').url, undefined);
});

test('production attachment path parser never recovers a local file from legacy or hostile URLs', () => {
  const registered = [];
  const mapped = attachmentMapper({
    registerOutputAttachment(filePath) {
      registered.push(filePath);
      return { handle: '0123456789abcdef0123456789abcdef', filePath, mimeType: 'image/png', size: 42 };
    },
  })([
    { name: 'foreign.png', url: 'https://evil.example/codex/attachment?path=C:/known/foreign.png' },
    { name: 'userinfo.png', url: 'http://user:pass@phone.local/codex/attachment?path=C:/known/userinfo.png' },
    { name: 'encoded.png', url: '/codex/%61ttachment?path=C%3A%2Fknown%2Fencoded.png' },
    { name: 'relative.png', url: '/codex/attachment?path=C:/known/relative.png' },
  ], { headers: { host: 'phone.local' } }, { inlineData: false });

  assert.deepEqual(registered, []);
  assert.equal(mapped.some(item => item.url), false);
  assert.doesNotMatch(JSON.stringify(mapped), /known|foreign\.png\?|userinfo\.png\?|encoded\.png\?|relative\.png\?/);
});

test('history parsing expands file snapshots with the same normalizeMany contract as realtime', () => {
  const body = functionBody('parseCodexThreadHistory');
  assert.match(body, /new EventReconciler\(\{ serverInstanceId: 'history-parser' \}\)/);
  assert.match(body, /historyReconciler\.rehydrate\(historyEntries\)\.events/);
  assert.doesNotMatch(body, /sessionNormalizer\.normalize\(item\)/);
});

test('v3 attachment enrichment keeps registered capabilities strictly relative to the configured backend', () => {
  const handle = '0123456789abcdef0123456789abcdef';
  const mapped = attachmentMapper({
    registerOutputAttachment(filePath) {
      return { handle, filePath, mimeType: 'image/png', size: 42 };
    },
    capabilityAttachmentFile(url) {
      return url.pathname === `/codex/attachment/${handle}` ? { mimeType: 'image/png', size: 42 } : null;
    },
  })([
    { name: 'local.png', mimeType: 'image/png', filePath: 'E:\\private\\local.png' },
    { name: 'cached.png', mimeType: 'image/png', url: `http://phone.local/codex/attachment/${handle}` },
    { name: 'foreign.png', mimeType: 'image/png', url: `http://127.0.0.1:18988/codex/attachment/${handle}` },
  ], { headers: { host: '127.0.0.1:18988' } }, { inlineData: false });

  assert.deepEqual(mapped.map(item => item.url), [
    `/codex/attachment/${handle}`,
    `/codex/attachment/${handle}`,
    undefined,
  ]);
  assert.doesNotMatch(JSON.stringify(mapped), /https?:\/\/|127\.0\.0\.1|phone\.local|E:\\\\private/);
});

test('normalizer through builder and history response exposes registered image capability in timeline and segments', () => {
  const handle = '0123456789abcdef0123456789abcdef';
  const registerHistoryEventAttachments = new Function(
    'path', 'attachmentFilePath', 'registerOutputAttachment', 'imageMimeTypeForFile',
    'setPrivateAttachmentSource', 'getPrivateAttachmentSource',
    `${functionSource('registerHistoryEventAttachments')} return registerHistoryEventAttachments;`,
  )(path, attachment => String(attachment.filePath || attachment.path || ''), filePath => ({
    handle, filePath, mimeType: 'image/png', size: 42,
  }), () => 'image/png', setPrivateAttachmentSource, getPrivateAttachmentSource);
  const enrichAttachmentList = attachmentMapper({
    registerOutputAttachment(filePath) {
      return { handle, filePath, mimeType: 'image/png', size: 42 };
    },
    capabilityAttachmentFile(url) {
      return url.pathname === `/codex/attachment/${handle}` ? { mimeType: 'image/png', size: 42 } : null;
    },
  });
  const enrichHistoryAttachments = new Function('enrichAttachmentList', `
    ${functionSource('enrichHistoryMessage')}
    ${functionSource('enrichHistoryTurn')}
    ${functionSource('enrichHistoryAttachments')}
    return enrichHistoryAttachments;
  `)(enrichAttachmentList);
  const normalizer = createSessionNormalizer();
  const normalized = normalizer.normalize({ type: 'response_item', payload: {
    type: 'imageView', id: 'real-image-view', status: 'completed', path: 'E:\\private\\viewed.png',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-image-history' },
  } });
  const events = registerHistoryEventAttachments([normalized]);
  const turn = buildTurnViews(events, '11111111-2222-4333-8444-555555555555')[0];
  const response = enrichHistoryAttachments({ messages: [], turns: [turn] }, { headers: { host: 'phone.local' } });
  const serialized = JSON.stringify(response);

  assert.equal(response.turns[0].timeline[0].attachments[0].url, `/codex/attachment/${handle}`);
  assert.equal(response.turns[0].segments[0].items[0].attachments[0].url, `/codex/attachment/${handle}`);
  assert.doesNotMatch(serialized, /E:\\\\private|filePath|token/i);
});

test('paired user image metadata keeps the private source and v3 publishes one capability URL', () => {
  const handle = 'fedcba9876543210fedcba9876543210';
  const filePath = 'E:\\ProtocolFixtures\\paired-user.png';
  const reconciler = new EventReconciler({ serverInstanceId: 'server-paired-user-capability' });
  reconciler.ingestFileEntries([
    {
      source: 'file', offset: 0, nextOffset: 100,
      item: {
        type: 'response_item', timestamp: '2026-07-10T12:00:00.000Z', _stableOrder: 1,
        payload: {
          type: 'message', role: 'user', content: [{
            type: 'input_text',
            text: `# Files mentioned by the user:\n## paired-user.png: ${filePath}\n## My request for Codex:\n检查图片`,
          }],
        },
      },
    },
    {
      source: 'file', offset: 100, nextOffset: 200,
      item: {
        type: 'event_msg', timestamp: '2026-07-10T12:00:00.001Z', _stableOrder: 2,
        payload: { type: 'user_message', message: '检查图片', local_images: [filePath] },
      },
    },
  ]);
  const user = reconciler.snapshot().events.find(event => event.role === 'user');
  assert.equal(user.attachments.length, 1, 'same-name fallback supplements the canonical metadata instead of being discarded');
  assert.equal(getPrivateAttachmentSource(user.attachments[0]), filePath);
  assert.equal(JSON.stringify(user).includes('ProtocolFixtures'), false);

  const mapped = attachmentMapper({
    registerOutputAttachment(source) {
      assert.equal(source, filePath);
      return { handle, filePath: source, mimeType: 'image/png', size: 42 };
    },
  })(user.attachments, {}, { inlineData: false });
  assert.deepEqual(mapped, [{
    name: 'paired-user.png', mime: 'image/png', mimeType: 'image/png', size: 42,
    url: `/codex/attachment/${handle}`,
  }]);
});

test('paired user history merges the same-name capability supplement into the canonical message', () => {
  const handle = '00112233445566778899aabbccddeeff';
  const filePath = 'E:\\ProtocolFixtures\\history-user.png';
  const registerHistoryEventAttachments = new Function(
    'path', 'attachmentFilePath', 'registerOutputAttachment', 'imageMimeTypeForFile',
    'setPrivateAttachmentSource', 'getPrivateAttachmentSource',
    `${functionSource('registerHistoryEventAttachments')} return registerHistoryEventAttachments;`,
  )(path, attachment => String(attachment.filePath || attachment.path || ''), source => ({
    handle, filePath: source, mimeType: 'image/png', size: 42,
  }), () => 'image/png', setPrivateAttachmentSource, getPrivateAttachmentSource);
  const normalizer = createSessionNormalizer();
  const normalized = [
    normalizer.normalize({
      type: 'response_item', timestamp: '2026-07-10T12:10:00.000Z',
      payload: { type: 'message', role: 'user', content: [{
        type: 'input_text',
        text: `# Files mentioned by the user:\n## history-user.png: ${filePath}\n## My request for Codex:\n检查历史图片`,
      }] },
    }),
    normalizer.normalize({
      type: 'event_msg', timestamp: '2026-07-10T12:10:00.001Z',
      payload: { type: 'user_message', message: '检查历史图片', local_images: [filePath] },
    }),
  ];
  const turns = buildTurnViews(registerHistoryEventAttachments(normalized), '11111111-2222-4333-8444-555555555555');
  const userTurn = turns.find(turn => turn.user && turn.user.text === '检查历史图片');

  assert.equal(userTurn.user.attachments.length, 1);
  assert.equal(userTurn.user.attachments[0].url, `/codex/attachment/${handle}`);
  assert.equal(getPrivateAttachmentSource(userTurn.user.attachments[0]), filePath);
  assert.equal(JSON.stringify(userTurn).includes('ProtocolFixtures'), false);
});

test('two different user image sources with one basename keep two independent capabilities', () => {
  const firstPath = 'E:\\ProtocolFixtures\\first\\same.png';
  const secondPath = 'E:\\ProtocolFixtures\\second\\same.png';
  const handles = new Map([
    [firstPath, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    [secondPath, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
  ]);
  const reconciler = new EventReconciler({ serverInstanceId: 'server-same-basename-images' });
  reconciler.ingestFileEntries([
    {
      source: 'file', offset: 0, nextOffset: 100,
      item: {
        type: 'response_item', timestamp: '2026-07-10T12:20:00.000Z', _stableOrder: 1,
        payload: { type: 'message', role: 'user', content: [{
          type: 'input_text',
          text: `# Files mentioned by the user:\n## same.png: ${firstPath}\n## same.png: ${secondPath}\n## My request for Codex:\n比较图片`,
        }] },
      },
    },
    {
      source: 'file', offset: 100, nextOffset: 200,
      item: {
        type: 'event_msg', timestamp: '2026-07-10T12:20:00.001Z', _stableOrder: 2,
        payload: { type: 'user_message', message: '比较图片', local_images: [firstPath, secondPath] },
      },
    },
  ]);
  const user = reconciler.snapshot().events.find(event => event.role === 'user');
  assert.equal(user.attachments.length, 2);
  assert.deepEqual(user.attachments.map(getPrivateAttachmentSource), [firstPath, secondPath]);
  assert.equal(JSON.stringify(user).includes('ProtocolFixtures'), false);

  const mapped = attachmentMapper({
    registerOutputAttachment(source) {
      return { handle: handles.get(source), filePath: source, mimeType: 'image/png', size: 42 };
    },
  })(user.attachments, {}, { inlineData: false });
  assert.deepEqual(mapped.map(item => item.url), [
    '/codex/attachment/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '/codex/attachment/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  assert.deepEqual(mapped.map(item => item.name), ['same.png', 'same.png']);
});

test('cached history re-registers private image sources after capability expiry or eviction', () => {
  const initialHandle = '00000000000000000000000000000000';
  const refreshedHandles = [
    '11111111111111111111111111111111',
    '22222222222222222222222222222222',
  ];
  const registerHistoryEventAttachments = new Function(
    'path', 'attachmentFilePath', 'registerOutputAttachment', 'imageMimeTypeForFile',
    'setPrivateAttachmentSource', 'getPrivateAttachmentSource',
    `${functionSource('registerHistoryEventAttachments')} return registerHistoryEventAttachments;`,
  )(path, attachment => String(attachment.filePath || attachment.path || ''), filePath => ({
    handle: initialHandle, filePath, mimeType: 'image/png', size: 42,
  }), () => 'image/png', setPrivateAttachmentSource, getPrivateAttachmentSource);
  let currentHandle = refreshedHandles[0];
  const enrichAttachmentList = attachmentMapper({
    registerOutputAttachment(filePath) {
      return { handle: currentHandle, filePath, mimeType: 'image/png', size: 42 };
    },
    capabilityAttachmentFile() {
      return null;
    },
  });
  const enrichHistoryAttachments = new Function('enrichAttachmentList', `
    ${functionSource('enrichHistoryMessage')}
    ${functionSource('enrichHistoryTurn')}
    ${functionSource('enrichHistoryAttachments')}
    return enrichHistoryAttachments;
  `)(enrichAttachmentList);
  const normalizer = createSessionNormalizer();
  const normalized = normalizer.normalize({ type: 'response_item', payload: {
    type: 'imageView', id: 'cache-image', status: 'completed', path: 'E:\\private\\cached.png',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-cache-image' },
  } });
  const cachedHistory = { messages: [], turns: [
    buildTurnViews(registerHistoryEventAttachments([normalized]), '11111111-2222-4333-8444-555555555555')[0],
  ] };

  assert.doesNotMatch(JSON.stringify(cachedHistory), /E:\\\\private|filePath/);
  const firstResponse = enrichHistoryAttachments(cachedHistory, { headers: { host: 'phone.local' } });
  currentHandle = refreshedHandles[1];
  const secondResponse = enrichHistoryAttachments(cachedHistory, { headers: { host: 'phone.local' } });
  assert.match(firstResponse.turns[0].timeline[0].attachments[0].url, new RegExp(refreshedHandles[0]));
  assert.match(firstResponse.turns[0].process.activities[0].attachments[0].url, new RegExp(refreshedHandles[0]));
  assert.match(firstResponse.turns[0].process.detailActivities[0].attachments[0].url, new RegExp(refreshedHandles[0]));
  assert.match(secondResponse.turns[0].timeline[0].attachments[0].url, new RegExp(refreshedHandles[1]));
  assert.match(secondResponse.turns[0].segments[0].items[0].attachments[0].url, new RegExp(refreshedHandles[1]));
  assert.match(secondResponse.turns[0].process.activities[0].attachments[0].url, new RegExp(refreshedHandles[1]));
  assert.match(secondResponse.turns[0].process.detailActivities[0].attachments[0].url, new RegExp(refreshedHandles[1]));
  assert.doesNotMatch(JSON.stringify([firstResponse, secondResponse]), /E:\\\\private|filePath|token/i);
});

test('structured history recursively exposes capability attachment DTOs without private paths', () => {
  const handle = 'abcdef0123456789abcdef0123456789';
  const enrichAttachmentList = attachmentMapper({
    registerOutputAttachment(filePath) {
      return { handle, filePath, mimeType: 'image/png', size: 4 };
    },
  });
  const enrichHistoryAttachments = new Function('enrichAttachmentList', `
    ${functionSource('enrichHistoryMessage')}
    ${functionSource('enrichHistoryTurn')}
    ${functionSource('enrichHistoryAttachments')}
    return enrichHistoryAttachments;
  `)(enrichAttachmentList);
  const originalPath = 'C:/private/a.png';
  const history = {
    messages: [],
    turns: [{
      user: { attachments: [{ name: 'a.png', filePath: originalPath, dataUrl: 'data:image/png;base64,AAAA' }] },
      final: { attachments: [{ name: 'b.png', path: 'C:/private/b.png' }] },
      process: {
        activities: [{ attachments: [{ name: 'c.png', filePath: 'C:/private/c.png' }] }],
        detailActivities: [{ attachments: [{ name: 'd.png', filePath: 'C:/private/d.png' }] }],
      },
    }],
  };

  const httpResponse = enrichHistoryAttachments(history, { headers: { host: 'phone.local' } });
  const serialized = JSON.stringify(httpResponse);
  assert.match(serialized, new RegExp(`/codex/attachment/${handle}`));
  assert.equal(serialized.includes('filePath'), false);
  assert.equal(serialized.includes('dataUrl'), false);
  assert.equal(serialized.includes(originalPath), false);
});
