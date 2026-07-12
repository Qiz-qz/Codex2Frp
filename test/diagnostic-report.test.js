'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDiagnosticReport,
  redactDiagnosticString,
} = require('../lib/diagnostics/diagnostic-report');

const TOKEN = 'TOKEN_CANARY_74f4';
const BODY = 'BODY_CANARY_44da';
const QUEUE_TEXT = 'QUEUE_TEXT_CANARY_f027';
const SUBAGENT = 'SUBAGENT_CANARY_331d';
const WINDOWS_PATH = 'E:\\Private\\RAW_PATH_CANARY_948a\\session.jsonl';
const UNIX_PATH = '/home/private/UNIX_PATH_CANARY_f83d/session.jsonl';

test('diagnostic report rebuilds an allowlisted summary and drops every sensitive canary', () => {
  const circular = {};
  circular.self = circular;
  const report = createDiagnosticReport({
    environment: { platform: 'win32', nodeVersion: 'v24.9.0', env: { TOKEN } },
    versions: { backend: '2.2.0', desktop: '1.2026.154', cli: '0.144.0-alpha.4' },
    protocol: {
      profile: 'app-server-v0144',
      schemaVersion: '0.144.0-alpha.4',
      schemaHash: 'a'.repeat(64),
      codexHome: WINDOWS_PATH,
    },
    appServer: { state: 'ready', pid: 4101, connectionEpoch: 5, command: WINDOWS_PATH },
    capabilities: {
      operations: {
        'thread.list': { mode: 'rpc' },
        'turn.queueNext': { mode: 'bridge' },
        'composer.plus': { mode: 'unavailable', reason: BODY },
        [SUBAGENT]: { mode: 'futureMode', prompt: SUBAGENT },
      },
    },
    route: {
      kind: 'lan',
      status: 'healthy',
      latencyMs: 42,
      lastSuccessAt: '2026-07-10T01:00:00.000Z',
      nextRetryAt: null,
      url: `https://example.invalid/?token=${TOKEN}`,
      error: { code: 'ROUTE_TIMEOUT', message: `${BODY} ${WINDOWS_PATH}` },
    },
    sync: {
      snapshotVersion: 7,
      stale: false,
      lastSyncedAt: '2026-07-10T01:01:00.000Z',
      cursor: UNIX_PATH,
      rawEvent: BODY,
    },
    queue: {
      items: [
        { state: 'queued', text: QUEUE_TEXT, attachments: [{ dataUrl: BODY }] },
        { state: 'queued', text: BODY },
        { state: 'needs_reconcile', text: WINDOWS_PATH },
        { state: 'failed', lastError: { message: TOKEN } },
      ],
    },
    errors: [
      { code: 'APP_SERVER_EXITED', kind: 'unavailable', at: '2026-07-10T01:02:00.000Z', message: BODY },
      { code: WINDOWS_PATH, kind: 'remote', message: TOKEN },
    ],
    auth: { token: TOKEN },
    request: { body: BODY },
    response: { body: BODY },
    subagents: [{ id: SUBAGENT, prompt: SUBAGENT, output: BODY, path: UNIX_PATH }],
    cwd: WINDOWS_PATH,
    arbitrary: circular,
  }, {
    now: () => new Date('2026-07-10T02:00:00.000Z'),
    tokens: [TOKEN],
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    generatedAt: '2026-07-10T02:00:00.000Z',
    environment: { platform: 'win32', nodeVersion: 'v24.9.0' },
    versions: { backend: '2.2.0', desktop: '1.2026.154', cli: '0.144.0-alpha.4' },
    protocol: {
      profile: 'app-server-v0144',
      schemaVersion: '0.144.0-alpha.4',
      schemaHash: 'a'.repeat(64),
    },
    appServer: { state: 'ready', pid: 4101, connectionEpoch: 5 },
    capabilities: { rpc: 1, bridge: 1, uiExplicit: 0, unavailable: 1, unknown: 1 },
    route: {
      kind: 'lan',
      status: 'healthy',
      latencyMs: 42,
      lastSuccessAt: '2026-07-10T01:00:00.000Z',
      nextRetryAt: null,
      errorCode: 'ROUTE_TIMEOUT',
    },
    sync: {
      snapshotVersion: 7,
      stale: false,
      lastSyncedAt: '2026-07-10T01:01:00.000Z',
    },
    queue: {
      total: 4,
      states: { queued: 2, needs_reconcile: 1, failed: 1 },
    },
    errors: [
      { code: 'APP_SERVER_EXITED', kind: 'unavailable', at: '2026-07-10T01:02:00.000Z' },
      { code: 'UNKNOWN', kind: 'remote', at: null },
    ],
  });

  const serialized = JSON.stringify(report);
  for (const canary of [TOKEN, BODY, QUEUE_TEXT, SUBAGENT, WINDOWS_PATH, UNIX_PATH]) {
    assert.equal(serialized.includes(canary), false, `diagnostics leaked ${canary}`);
  }
  for (const forbiddenKey of ['token', 'body', 'text', 'attachments', 'subagents', 'cwd', 'path', 'message']) {
    assert.equal(Object.hasOwn(report, forbiddenKey), false);
  }
});

test('diagnostic string redaction removes configured tokens, bearer values, data URLs, query secrets, and paths', () => {
  const source = [
    `Authorization: Bearer ${TOKEN}`,
    `url=https://example.invalid/api?token=${TOKEN}&mode=full`,
    'image=data:image/png;base64,QUJDREVGRw==',
    `windows=${WINDOWS_PATH}`,
    `unix=${UNIX_PATH}`,
  ].join(' | ');
  const redacted = redactDiagnosticString(source, { tokens: [TOKEN] });

  assert.equal(redacted.includes(TOKEN), false);
  assert.equal(redacted.includes('QUJDREVGRw=='), false);
  assert.equal(redacted.includes('RAW_PATH_CANARY'), false);
  assert.equal(redacted.includes('UNIX_PATH_CANARY'), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /<path>/);
});

test('queue and capability aggregation accepts unknown future states without copying their bodies', () => {
  const report = createDiagnosticReport({
    capabilities: { operations: { future: { mode: 'futureMode', details: BODY } } },
    queue: { items: [{ state: 'future_state', text: QUEUE_TEXT }, null, 'invalid'] },
  }, { now: () => new Date('2026-07-10T02:00:00.000Z') });

  assert.deepEqual(report.capabilities, {
    rpc: 0,
    bridge: 0,
    uiExplicit: 0,
    unavailable: 0,
    unknown: 1,
  });
  assert.deepEqual(report.queue, { total: 1, states: { unknown: 1 } });
  assert.equal(JSON.stringify(report).includes(QUEUE_TEXT), false);
  assert.equal(JSON.stringify(report).includes(BODY), false);
});

test('unknown PID and latency remain null instead of being reported as real zero values', () => {
  const report = createDiagnosticReport({
    appServer: { pid: null },
    route: { latencyMs: null },
  }, { now: () => new Date('2026-07-10T02:00:00.000Z') });

  assert.equal(report.appServer.pid, null);
  assert.equal(report.route.latencyMs, null);
});

test('an unavailable owned app-server remains distinguishable from an unknown state', () => {
  const report = createDiagnosticReport({
    appServer: { state: 'unavailable', pid: null, connectionEpoch: 0 },
  }, { now: () => new Date('2026-07-10T02:00:00.000Z') });

  assert.equal(report.appServer.state, 'unavailable');
});
