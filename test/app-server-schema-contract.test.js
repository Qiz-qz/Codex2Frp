'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  NOTIFICATION_METHODS,
  REQUEST_METHODS,
} = require('../lib/app-server/methods');
const {
  computeNormalizedSchemaHash,
  computeSchemaHash,
  loadSchemaProfile,
  validateInitializeResponse,
  validateSchemaProfile,
  verifySchemaHash,
} = require('../lib/app-server/schema-profile');

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');
const PROFILE_0144_2_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144_2-profile.json');

function loadProfile() {
  return loadSchemaProfile(PROFILE_FILE);
}

function expectCompatibilityCode(error, code) {
  assert.equal(error.code, code);
  return true;
}

test('v0144 fixture pins the exact core methods and generated schema hash', () => {
  const profile = validateSchemaProfile(loadProfile());

  assert.equal(profile.id, 'app-server-v0144');
  assert.equal(profile.schemaVersion, '0.144.0-alpha.4');
  assert.equal(
    profile.schema.sha256,
    '85ea836927d6cfdd3c68a9bda17dba48d2573bbc282ab2d5775a5005e40bc9c3',
  );
  assert.deepEqual(profile.requiredRequestMethods, Object.values(REQUEST_METHODS));
  assert.deepEqual(profile.requiredNotificationMethods, Object.values(NOTIFICATION_METHODS));
  assert.equal(profile.schemaHash, profile.schema.sha256);
  assert.deepEqual(profile.cliVersions, ['0.144.0-alpha.4']);
  assert.deepEqual(profile.requestMethods, Object.values(REQUEST_METHODS));
  assert.deepEqual(profile.notificationMethods, Object.values(NOTIFICATION_METHODS));
  assert.deepEqual(profile.typeUnions['protocol/ClientRequest'], Object.values(REQUEST_METHODS));
  assert.deepEqual(profile.typeUnions['protocol/ServerNotification'], Object.values(NOTIFICATION_METHODS));
  assert.equal(REQUEST_METHODS.THREAD_TURNS_LIST, 'thread/turns/list');
  assert.equal(REQUEST_METHODS.THREAD_FORK, 'thread/fork');
  assert.equal(REQUEST_METHODS.THREAD_COMPACT, 'thread/compact/start');
  assert.equal(REQUEST_METHODS.THREAD_SETTINGS_UPDATE, 'thread/settings/update');
  assert.equal(REQUEST_METHODS.MODEL_LIST, 'model/list');
  assert.equal(REQUEST_METHODS.COLLABORATION_MODE_LIST, 'collaborationMode/list');
  assert.equal(NOTIFICATION_METHODS.ITEM_STARTED, 'item/started');
  assert.equal(NOTIFICATION_METHODS.ITEM_COMPLETED, 'item/completed');
  assert.equal(NOTIFICATION_METHODS.TURN_PLAN_UPDATED, 'turn/plan/updated');
});

test('schema hashes are computed from raw bytes and mismatches fail closed', () => {
  const profile = loadProfile();
  const schemaBytes = Buffer.from('{"title":"minimal-v0144-test-schema"}\n', 'utf8');
  const expectedHash = computeSchemaHash(schemaBytes);
  const matchingProfile = {
    ...profile,
    schema: { ...profile.schema, sha256: expectedHash },
    schemaHash: expectedHash,
  };

  assert.equal(verifySchemaHash(schemaBytes, matchingProfile), expectedHash);
  assert.throws(
    () => verifySchemaHash(Buffer.from(`${schemaBytes.toString('utf8')} `), matchingProfile),
    error => expectCompatibilityCode(error, 'APP_SERVER_SCHEMA_MISMATCH'),
  );
});

test('v0144_2 fixture pins the normalized hash, method inventory, and critical unions', () => {
  const profile = loadSchemaProfile(PROFILE_0144_2_FILE);
  assert.equal(profile.schemaVersion, '0.144.2');
  assert.equal(profile.schemaHash, '2e30b98331bfd3951d812fe0a9c32f08caeef1e40749f77dc935baef8d33ba54');
  assert.deepEqual(profile.cliVersions, ['0.144.2', '0.144.5']);
  assert.equal(profile.requestMethods.length, 122);
  assert.equal(profile.notificationMethods.length, 68);
  assert.deepEqual(profile.typeUnions['v2/MessagePhase'], ['commentary', 'final_answer']);
  assert.ok(profile.typeUnions['v2/ThreadItem'].includes('subAgentActivity'));
  assert.ok(profile.typeUnions['v2/ThreadItem'].includes('contextCompaction'));
});

test('generated schema normalization sorts files and object keys while preserving array order', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-schema-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-schema-second-'));
  try {
    fs.mkdirSync(path.join(first, 'v2'));
    fs.mkdirSync(path.join(second, 'v2'));
    fs.writeFileSync(path.join(first, 'z.json'), '{\r\n  "b": 2, "a": [2, 1]\r\n}', 'utf8');
    fs.writeFileSync(path.join(first, 'v2', 'a.json'), '{"z":0,"a":1}', 'utf8');
    fs.writeFileSync(path.join(second, 'v2', 'a.json'), '{\n  "a": 1,\n  "z": 0\n}\n', 'utf8');
    fs.writeFileSync(path.join(second, 'z.json'), '{"a":[2,1],"b":2}', 'utf8');

    assert.equal(computeNormalizedSchemaHash(first), computeNormalizedSchemaHash(second));
    fs.writeFileSync(path.join(second, 'z.json'), '{"a":[1,2],"b":2}', 'utf8');
    assert.notEqual(computeNormalizedSchemaHash(first), computeNormalizedSchemaHash(second));
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('initialize validation accepts the isolated Windows home and pinned user agent', () => {
  const profile = loadProfile();
  const response = {
    codexHome: 'e:\\isolated\\codex-home\\',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex_cli_rs/0.144.0-alpha.4 (Windows 11)',
  };

  assert.equal(validateInitializeResponse(response, {
    profile,
    expectedCodexHome: 'E:\\isolated\\codex-home',
  }), response);
});

test('initialize validation rejects a different CODEX_HOME before capability use', () => {
  const profile = loadProfile();
  assert.throws(() => validateInitializeResponse({
    codexHome: 'E:\\default-home',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex-cli 0.144.0-alpha.4',
  }, {
    profile,
    expectedCodexHome: 'E:\\isolated\\codex-home',
  }), error => expectCompatibilityCode(error, 'APP_SERVER_CODEX_HOME_MISMATCH'));
});

test('initialize validation accepts the current Codex Desktop app-server user agent', () => {
  const profile = loadProfile();
  const response = {
    codexHome: 'E:\\isolated\\codex-home',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'Codex Desktop/0.144.0-alpha.4 (Windows 10.0.26200; x86_64) unknown (codex2frp; 2.2.0)',
  };
  assert.equal(validateInitializeResponse(response, {
    profile,
    expectedCodexHome: response.codexHome,
  }), response);
});

test('initialize validation rejects unnegotiated platform and user-agent versions', () => {
  const profile = loadProfile();
  const base = {
    codexHome: 'E:\\isolated\\codex-home',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex-cli 0.144.0-alpha.4',
  };

  assert.throws(() => validateInitializeResponse({ ...base, platformOs: 'linux' }, {
    profile,
    expectedCodexHome: base.codexHome,
  }), error => expectCompatibilityCode(error, 'APP_SERVER_PLATFORM_MISMATCH'));
  assert.throws(() => validateInitializeResponse({ ...base, userAgent: 'codex-cli 0.145.0' }, {
    profile,
    expectedCodexHome: base.codexHome,
  }), error => expectCompatibilityCode(error, 'APP_SERVER_USER_AGENT_MISMATCH'));
});

test('validated v0144_2 schema accepts a compatible 0.144.x user-agent alias only', () => {
  const profile = loadSchemaProfile(PROFILE_0144_2_FILE);
  const response = {
    codexHome: 'E:\\isolated\\codex-home',
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'Codex Desktop/0.144.3 (Windows 11)',
  };
  assert.equal(validateInitializeResponse(response, {
    profile,
    expectedCodexHome: response.codexHome,
  }), response);
  assert.throws(() => validateInitializeResponse({ ...response, userAgent: 'Codex Desktop/0.145.0' }, {
    profile,
    expectedCodexHome: response.codexHome,
  }), error => expectCompatibilityCode(error, 'APP_SERVER_USER_AGENT_MISMATCH'));
  assert.throws(() => validateInitializeResponse({ ...response, platformOs: 'linux' }, {
    profile,
    expectedCodexHome: response.codexHome,
  }), error => expectCompatibilityCode(error, 'APP_SERVER_PLATFORM_MISMATCH'));
});
