'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const { loadSchemaProfile } = require('../lib/app-server/schema-profile');
const { selectBridgeSchemaProfile } = require('../lib/app-server/bridge-profile-selector');
const { createCapabilityManifest, requireCapability } = require('../lib/codex/capabilities');
const { buildTurnViews } = require('../lib/events/turn-view-builder');

const root = path.resolve(__dirname, '..');
const liveSmoke = fs.readFileSync(path.join(__dirname, 'integration', 'app-server-live-smoke.test.js'), 'utf8');
const installedSmoke = fs.readFileSync(path.join(root, 'scripts', 'installed-readonly-smoke.ps1'), 'utf8');

test('backend parity gate has an explicit repeatable command', () => {
  assert.equal(
    packageJson.scripts['test:backend-gate'],
    'npm test && npm run check && npm run test:integration',
  );
});

test('live gate names its opt-in skip and isolates all writable Codex state', () => {
  assert.match(liveSmoke, /CODEX2FRP_LIVE_APP_SERVER=1 is required/);
  assert.match(liveSmoke, /codex2frp-live-gate-/);
  assert.match(liveSmoke, /assertIsolatedCodexHome/);
  assert.match(liveSmoke, /observeInstalledSchema/);
  assert.match(liveSmoke, /selectBridgeSchemaProfile/);
  assert.match(liveSmoke, /schemaProfile\.schemaHash/);
  assert.match(liveSmoke, /0\.144\.2/);
});

test('installed smoke is a GET-only observation and never exposes or mutates task identity', () => {
  assert.doesNotMatch(installedSmoke, /-Method\s+(?:Post|Put|Patch|Delete)\b/i);
  assert.doesNotMatch(installedSmoke, /\/input|\/actions|\/interrupt|\/steer|\/flush|\/retry|\/reconcile/i);
  assert.doesNotMatch(installedSmoke, /^\s{2}threadId\s*=/im);
  assert.match(installedSmoke, /readOnly\s*=\s*\$true/);
});

test('0.144.2 profile and dynamic capabilities fail closed for unknown operations', () => {
  const profile = loadSchemaProfile(path.join(root, 'lib', 'app-server', 'profiles', 'v0144_2-profile.json'));
  assert.equal(profile.id, 'app-server-v0144_2');
  assert.equal(profile.schemaVersion, '0.144.2');
  assert.match(profile.schemaHash, /^[a-f0-9]{64}$/);

  const manifest = createCapabilityManifest({
    profile,
    supportedMethods: [...profile.requiredRequestMethods, 'future/privateMethod'],
    runtimeReady: true,
  });
  assert.equal(manifest.operations['model.list'].available, true);
  assert.equal(manifest.operations['model.list'].ready, true);
  assert.equal(manifest.operations['model.list'].readbackSupported, true);
  assert.equal(manifest.operations['collaborationMode.list'].ready, false);
  assert.equal(manifest.operations['collaborationMode.list'].reason, 'desktop_ui_not_verified');
  assert.equal(Object.hasOwn(manifest.operations, 'future/privateMethod'), false);
  assert.throws(() => requireCapability(manifest, 'future/privateMethod'), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('production negotiation rejects same-version observed schema drift', () => {
  const profile = loadSchemaProfile(path.join(root, 'lib', 'app-server', 'profiles', 'v0144_2-profile.json'));
  const result = selectBridgeSchemaProfile({
    executable: 'C:\\Codex\\codex.exe',
    cliVersion: '0.144.2',
    observeSchema: () => ({
      schemaHash: 'f'.repeat(64),
      requestMethods: profile.requestMethods,
      notificationMethods: profile.notificationMethods,
      typeUnions: profile.typeUnions,
    }),
  });
  assert.deepEqual(result, { compatible: false, profile: null, reason: 'schema_mismatch' });
});

test('public timeline gate preserves order and adjacency while excluding private payloads', () => {
  const privateCanary = 'PRIVATE_GATE_CANARY';
  const threadId = '11111111-2222-4333-8444-555555555555';
  const turn = buildTurnViews([
    { type: 'turn', state: 'started', turnId: 'turn-gate', order: 1, eventId: 'turn-start' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', turnId: 'turn-gate', order: 2, eventId: 'command-a', id: 'command-a', text: 'Run tests A', arguments: privateCanary, output: privateCanary },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', turnId: 'turn-gate', order: 3, eventId: 'command-b', id: 'command-b', text: 'Run tests B', payload: privateCanary },
    { type: 'summary', summaryKind: 'commentary', phase: 'commentary', turnId: 'turn-gate', order: 4, eventId: 'commentary', id: 'commentary', body: 'Visible checkpoint', text: 'Working' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'command', turnId: 'turn-gate', order: 5, eventId: 'command-c', id: 'command-c', text: 'Run tests C' },
    { type: 'summary', summaryKind: 'tool', toolKind: 'file', turnId: 'turn-gate', order: 6, eventId: 'file', id: 'file', text: 'Edited file', fileLabel: 'server.js', changeKind: 'modified', path: `E:\\${privateCanary}\\server.js` },
    { type: 'summary', summaryKind: 'tool', toolKind: 'imageView', turnId: 'turn-gate', order: 7, eventId: 'image', id: 'image', text: 'Viewed image', count: 1, attachments: [{ name: 'safe.png', url: '/codex/attachment/0123456789abcdef0123456789abcdef', filePath: privateCanary }] },
    { type: 'summary', summaryKind: 'subagent', turnId: 'turn-gate', order: 8, eventId: 'agent', id: 'agent', text: 'worker running', body: privateCanary, subagent: { name: 'worker', state: 'running', prompt: privateCanary, output: privateCanary } },
  ], threadId)[0];

  assert.deepEqual(turn.timeline.map(entry => entry.kind), [
    'command', 'command', 'commentary', 'command', 'file', 'image', 'subagent',
  ]);
  assert.deepEqual(turn.segments.map(segment => [segment.kind, segment.count]), [
    ['command', 2], ['commentary', 1], ['operation', 2], ['image', 1], ['subagent', 1],
  ]);
  assert.deepEqual({ commandCount: turn.segments[2].commandCount, fileCount: turn.segments[2].fileCount },
    { commandCount: 1, fileCount: 1 });
  assert.deepEqual(turn.segments[2].items.map(item => item.operationKind), ['command', 'file']);
  assert.equal(turn.timeline[2].publicNarrative, 'Visible checkpoint');
  assert.deepEqual(turn.timeline.at(-1).subagent, { name: 'worker', state: 'running' });
  assert.deepEqual(turn.segments[3].items[0].attachments, [{
    name: 'safe.png', url: '/codex/attachment/0123456789abcdef0123456789abcdef',
  }]);
  assert.doesNotMatch(JSON.stringify(turn), new RegExp(privateCanary));
});
