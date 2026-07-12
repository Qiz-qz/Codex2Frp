'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  NOTIFICATION_METHODS,
  REQUEST_METHODS,
} = require('../lib/app-server/methods');
const {
  computeSchemaHash,
  loadSchemaProfile,
  validateInitializeResponse,
  validateSchemaProfile,
  verifySchemaHash,
} = require('../lib/app-server/schema-profile');

const PROFILE_FILE = path.join(__dirname, 'fixtures', 'app-server', 'v0144-profile.json');

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
  };

  assert.equal(verifySchemaHash(schemaBytes, matchingProfile), expectedHash);
  assert.throws(
    () => verifySchemaHash(Buffer.from(`${schemaBytes.toString('utf8')} `), matchingProfile),
    error => expectCompatibilityCode(error, 'APP_SERVER_SCHEMA_MISMATCH'),
  );
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
