'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  detectCodexCliVersion,
  discoverCodexExecutable,
  normalizeCodexCliVersion,
  profileFileForCliVersion,
} = require('../lib/app-server/discovery');
const { negotiateSchemaProfile, profiles } = require('../lib/app-server/schema-negotiator');
const { selectBridgeSchemaProfile } = require('../lib/app-server/bridge-profile-selector');

const PROFILE_0144_2 = require(path.join(
  __dirname,
  '..',
  'lib',
  'app-server',
  'profiles',
  'v0144_2-profile.json',
));
const PROFILE_0144 = require(path.join(
  __dirname,
  '..',
  'lib',
  'app-server',
  'profiles',
  'v0144-profile.json',
));

function legacyObservation(overrides = {}) {
  const requestMethods = PROFILE_0144.requestMethods || PROFILE_0144.requiredRequestMethods;
  const notificationMethods = PROFILE_0144.notificationMethods || PROFILE_0144.requiredNotificationMethods;
  return {
    schemaHash: PROFILE_0144.schemaHash || PROFILE_0144.schema.sha256,
    requestMethods,
    notificationMethods,
    typeUnions: PROFILE_0144.typeUnions || {
      'protocol/ClientRequest': requestMethods,
      'protocol/ServerNotification': notificationMethods,
    },
    ...overrides,
  };
}

test('CLI version detection uses a hidden no-shell process and parses stdout', () => {
  const calls = [];
  const version = detectCodexCliVersion('C:\\Codex\\codex.exe', {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'codex-cli 0.144.0-alpha.4\n', stderr: '' };
    },
  });
  assert.equal(version, '0.144.0-alpha.4');
  assert.equal(calls[0].command, 'C:\\Codex\\codex.exe');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('CLI version detection fails closed on process errors or unknown output', () => {
  assert.equal(detectCodexCliVersion('', {}), '');
  assert.equal(detectCodexCliVersion('codex.exe', {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'failed' }),
  }), '');
  assert.equal(detectCodexCliVersion('codex.exe', {
    spawnSync: () => { throw new Error('not found'); },
  }), '');
});

test('explicit executable wins and invalid candidates are ignored', () => {
  const files = new Map([
    ['C:\\explicit\\codex.exe', { isFile: true, mtimeMs: 10 }],
    ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\old\\codex.exe', { isFile: true, mtimeMs: 20 }],
    ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe', { isFile: true, mtimeMs: 30 }],
  ]);
  const result = discoverCodexExecutable({
    explicitPath: 'C:\\explicit\\codex.exe',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    listCandidates: () => [...files.keys()].slice(1),
    stat: file => files.get(file) || null,
  });
  assert.equal(result, 'C:\\explicit\\codex.exe');
});

test('bundled discovery chooses the newest valid Codex binary deterministically', () => {
  const candidates = [
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\a\\codex.exe',
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\b\\codex.exe',
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\not-a-file\\codex.exe',
  ];
  const result = discoverCodexExecutable({
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    listCandidates: () => candidates,
    stat: file => file.includes('not-a-file')
      ? { isFile: false, mtimeMs: 999 }
      : { isFile: true, mtimeMs: file.includes('\\b\\') ? 200 : 100 },
  });
  assert.equal(result, candidates[1]);
});

test('version parser accepts current Codex output and rejects unrelated text', () => {
  assert.equal(normalizeCodexCliVersion('codex-cli 0.144.0-alpha.4\n'), '0.144.0-alpha.4');
  assert.equal(normalizeCodexCliVersion('codex 0.144.0-alpha.4'), '0.144.0-alpha.4');
  assert.equal(normalizeCodexCliVersion('hello 1.2.3'), '');
});

test('profile selection is exact and fails closed for unknown CLI versions', () => {
  const known = profileFileForCliVersion('0.144.0-alpha.4');
  assert.equal(path.basename(known), 'v0144-profile.json');
  assert.equal(path.basename(profileFileForCliVersion('0.144.2')), 'v0144_2-profile.json');
  assert.equal(path.basename(profileFileForCliVersion('0.144.5')), 'v0144_2-profile.json');
  assert.equal(profileFileForCliVersion('0.145.0'), '');
  assert.equal(profileFileForCliVersion(''), '');
});

test('0.144.2 negotiates by validated schema hash', () => {
  const result = negotiateSchemaProfile({
    cliVersion: '0.144.2',
    schemaHash: PROFILE_0144_2.schemaHash,
    methods: PROFILE_0144_2.requestMethods,
    types: PROFILE_0144_2.typeUnions,
  });
  assert.equal(result.compatible, true);
  assert.equal(result.profile.schemaHash, PROFILE_0144_2.schemaHash);
});

test('known version with a different union fails closed', () => {
  const result = negotiateSchemaProfile({
    cliVersion: '0.144.2', schemaHash: 'bad', methods: [], types: {},
  });
  assert.deepEqual(result, { compatible: false, profile: null, reason: 'schema_mismatch' });
});

test('matching hash with a different schema shape fails closed', () => {
  const result = negotiateSchemaProfile({
    cliVersion: '0.144.2',
    schemaHash: PROFILE_0144_2.schemaHash,
    methods: PROFILE_0144_2.requestMethods,
    types: { ...PROFILE_0144_2.typeUnions, 'v2/MessagePhase': ['final_answer'] },
  });
  assert.deepEqual(result, { compatible: false, profile: null, reason: 'schema_shape_mismatch' });
});

test('negotiator loads both legacy and current schema profiles', () => {
  assert.deepEqual(profiles().map(profile => profile.id).sort(), [
    'app-server-v0144',
    'app-server-v0144_2',
  ]);
});

test('legacy pinned hash and shape negotiate to app-server-v0144', () => {
  const observation = legacyObservation();
  const result = negotiateSchemaProfile({
    cliVersion: '0.144.0-alpha.4',
    schemaHash: observation.schemaHash,
    methods: observation.requestMethods,
    types: observation.typeUnions,
  });
  assert.equal(result.compatible, true);
  assert.equal(result.profile.id, 'app-server-v0144');
});

test('production selector can use the pinned legacy aggregate-file hash without weakening shape checks', () => {
  const observation = legacyObservation({
    schemaHash: 'e'.repeat(64),
    schemaFileHashes: {
      'codex_app_server_protocol.schemas.json': PROFILE_0144.schema.sha256,
    },
  });
  const result = selectBridgeSchemaProfile({
    executable: 'C:\\Codex\\codex.exe',
    cliVersion: '0.144.0-alpha.4',
    observeSchema: () => observation,
  });
  assert.equal(result.compatible, true);
  assert.equal(result.profile.id, 'app-server-v0144');
});

test('production bridge rejects a detected 0.144.2 CLI when its observed schema drifts', () => {
  const result = selectBridgeSchemaProfile({
    executable: 'C:\\Codex\\codex.exe',
    cliVersion: '0.144.2',
    observeSchema: () => ({
      schemaHash: 'f'.repeat(64),
      requestMethods: PROFILE_0144_2.requestMethods,
      notificationMethods: PROFILE_0144_2.notificationMethods,
      typeUnions: PROFILE_0144_2.typeUnions,
    }),
  });
  assert.deepEqual(result, { compatible: false, profile: null, reason: 'schema_mismatch' });
});

test('production bridge accepts a version alias only when schema hash and shape match', () => {
  const result = selectBridgeSchemaProfile({
    executable: 'C:\\Codex\\codex.exe',
    cliVersion: '0.144.3',
    observeSchema: () => ({
      schemaHash: PROFILE_0144_2.schemaHash,
      requestMethods: PROFILE_0144_2.requestMethods,
      notificationMethods: PROFILE_0144_2.notificationMethods,
      typeUnions: PROFILE_0144_2.typeUnions,
    }),
  });
  assert.equal(result.compatible, true);
  assert.equal(result.profile.id, 'app-server-v0144_2');
  assert.equal(result.profile.cliVersions.includes('0.144.3'), false, 'version is only a hint');
});
