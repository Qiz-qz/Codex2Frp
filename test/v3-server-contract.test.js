'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redactDiagnosticString } = require('../lib/diagnostics/diagnostic-report');

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
  const safeRemoteSource = source.includes('function safeRemoteAttachmentUrl(')
    ? functionSource('safeRemoteAttachmentUrl')
    : '';
  return new Function(
    'path', 'URL', 'INLINE_ATTACHMENT_BYTES', 'attachmentFilePath', 'imageMimeTypeForFile',
    'registerOutputAttachment', 'requestBaseUrl', 'inlineAttachmentDataUrl', 'redactDiagnosticString',
    `${safeRemoteSource}${functionSource('enrichAttachmentList')} return enrichAttachmentList;`,
  )(
    path,
    URL,
    512 * 1024,
    attachment => String(attachment.filePath || attachment.path || ''),
    () => 'image/*',
    overrides.registerOutputAttachment || (() => null),
    () => 'http://phone.local',
    () => '',
    redactDiagnosticString,
  );
}

test('production server owns one lazy v3 app-server runtime with persistent queue', () => {
  assert.match(source, /AppServerRuntime/);
  assert.match(source, /V3ApiRouter/);
  assert.match(source, /discoverCodexExecutable/);
  assert.match(source, /detectCodexCliVersion/);
  assert.match(source, /TurnInputQueue/);
  assert.match(source, /PendingRequestStore/);
  assert.match(source, /turn-input-queue\.json/);
  assert.match(source, /serverRequestSink:\s*request => handleV3ServerRequest\(pendingRequestStore, request\)/);
  assert.match(source, /function handleV3ServerRequest[\s\S]*currentTimeAt/);
  assert.match(source, /function handleV3ServerRequest[\s\S]*item\/tool\/call[\s\S]*success:\s*false/);
  assert.match(source, /CODEX2FRP_APP_SERVER_REQUEST_TIMEOUT_MS\s*\|\|\s*20000/,
    'production RPC timeout covers real thread startup latency');
  assert.match(source, /new AppServerProcessManager\(\{[\s\S]*requestTimeoutMs:\s*CODEX_APP_SERVER_REQUEST_TIMEOUT_MS[\s\S]*\}\)/,
    'the production process manager receives the explicit request timeout');
  assert.match(source, /const queueCommandCoordinator = new CommandCoordinator\(\{ guard \}\)/,
    'queue persistence has its own lock and cannot recursively acquire the RPC mutation lock');
  assert.match(source, /createBridgeV3Router\(\{[\s\S]*?queueCommandCoordinator,[\s\S]*?\}\)/);
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

test('attachment mapper never publishes credential-bearing remote URLs', () => {
  const mapped = attachmentMapper()([
    { name: 'token.png', mimeType: 'image/png', url: 'https://cdn.example/a.png?token=TOKEN_CANARY' },
    { name: 'signed.png', mimeType: 'image/png', url: 'https://cdn.example/a.png?X-Amz-Signature=SIGNATURE_CANARY' },
    { name: 'fragment.png', mimeType: 'image/png', url: 'https://cdn.example/a.png#SECRET_FRAGMENT' },
    { name: 'userinfo.png', mimeType: 'image/png', url: 'https://user:pass@cdn.example/a.png' },
    { name: 'safe.png', mimeType: 'image/png', url: 'https://cdn.example/a.png' },
  ], {}, { inlineData: false });
  const serialized = JSON.stringify(mapped);

  for (const secret of ['TOKEN_CANARY', 'SIGNATURE_CANARY', 'SECRET_FRAGMENT', 'user:pass']) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  assert.equal(mapped.filter(item => item.url).length, 1);
  assert.equal(mapped.find(item => item.name === 'safe.png').url, 'https://cdn.example/a.png');
  assert.equal(mapped.find(item => item.name === 'token.png').url, undefined);
});

test('structured history recursively exposes capability attachment DTOs without private paths', () => {
  const enrichAttachmentList = attachmentMapper({
    registerOutputAttachment(filePath) {
      return { handle: 'opaque-capability', filePath, mimeType: 'image/png', size: 4 };
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
  assert.match(serialized, /\/codex\/attachment\/opaque-capability/);
  assert.equal(serialized.includes('filePath'), false);
  assert.equal(serialized.includes('dataUrl'), false);
  assert.equal(serialized.includes(originalPath), false);
});
