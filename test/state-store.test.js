'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  emptyState,
  normalizeState,
  readState,
  writeState,
  sanitizeSakuraConfig,
} = require('../lib/state-store');

test('normalizes legacy local state and adds empty Sakura config', () => {
  const state = normalizeState({
    pinnedThreadIds: ['abc', 'not-valid'],
    archivedThreadIds: ['def'],
    titleOverrides: { abc: { name: 'Pinned' } },
    guiFailureReports: {},
  }, { isThreadId: value => value === 'abc' || value === 'def' });

  assert.deepEqual(state.pinnedThreadIds, ['abc']);
  assert.deepEqual(state.archivedThreadIds, ['def']);
  assert.equal(state.sakura.enabled, false);
  assert.equal(state.sakura.apiBase, 'https://api.natfrp.com/v4');
  assert.equal(state.sakura.preferredDomain, '');
  assert.equal(state.sakura.remotePort, 0);
});

test('default Sakura config does not ship with a personal tunnel', () => {
  const state = emptyState();
  assert.equal(state.sakura.preferredDomain, '');
  assert.equal(state.sakura.remotePort, 0);
  assert.deepEqual(state.sakura.managedTunnelIds, []);
});

test('drops legacy Push Kit state when normalizing local state', () => {
  const state = normalizeState({
    push: {
      devices: [
        { token: '  push-token-1  ', platform: 'harmonyos', deviceName: 'Mate Test', registeredAt: '2026-06-23T00:00:00.000Z' },
        { token: 'push-token-1', platform: 'harmonyos', deviceName: 'Duplicate' },
        { token: '', platform: 'harmonyos' },
      ],
      watches: [
        { id: 'watch-1', threadId: 'abc', sessionFile: 'session.jsonl', since: '2026-06-23T00:00:00.000Z', lastStatus: 'running' },
        { id: '', threadId: '', lastStatus: 'running' },
      ],
      lastEventKey: 'abc:complete:turn-1',
    },
  }, { isThreadId: value => value === 'abc' });

  assert.equal(Object.hasOwn(state, 'push'), false);
});

test('deduplicates persisted thread state ids while preserving order', () => {
  const state = normalizeState({
    pinnedThreadIds: ['abc', 'abc'],
    archivedThreadIds: ['def', 'def'],
  }, { isThreadId: value => value === 'abc' || value === 'def' });

  assert.deepEqual(state.pinnedThreadIds, ['abc']);
  assert.deepEqual(state.archivedThreadIds, ['def']);
});

test('malformed Sakura config falls back without discarding legacy state', () => {
  const state = normalizeState({
    pinnedThreadIds: ['abc'],
    archivedThreadIds: ['def'],
    titleOverrides: { abc: { name: 'Pinned' } },
    sakura: null,
  }, { isThreadId: value => value === 'abc' || value === 'def' });

  assert.deepEqual(state.pinnedThreadIds, ['abc']);
  assert.deepEqual(state.archivedThreadIds, ['def']);
  assert.deepEqual(state.titleOverrides, { abc: { name: 'Pinned' } });
  assert.equal(state.sakura.enabled, false);
  assert.equal(state.sakura.apiBase, 'https://api.natfrp.com/v4');

  const stringState = normalizeState({ sakura: 'bad-config' });
  assert.equal(stringState.sakura.enabled, false);
  assert.equal(stringState.sakura.apiBase, 'https://api.natfrp.com/v4');
});

test('normalizes persisted Codex control overrides', () => {
  const state = normalizeState({
    controlOverrides: {
      model: 'gpt-5.4-mini',
      reasoning: 'high',
      speed: 'fast',
      threadId: 'safe2',
      updatedAt: '2026-06-18T00:00:00.000Z',
      modelUpdatedAt: '2026-06-18T00:00:01.000Z',
      reasoningUpdatedAt: '2026-06-18T00:00:02.000Z',
      speedUpdatedAt: '2026-06-18T00:00:03.000Z',
      extra: 'ignored'
    }
  });

  assert.deepEqual(state.controlOverrides, {
    model: 'gpt-5.4-mini',
    reasoning: 'high',
    speed: 'fast',
    threadId: 'safe2',
    updatedAt: '2026-06-18T00:00:00.000Z',
    modelUpdatedAt: '2026-06-18T00:00:01.000Z',
    reasoningUpdatedAt: '2026-06-18T00:00:02.000Z',
    speedUpdatedAt: '2026-06-18T00:00:03.000Z'
  });

  const malformed = normalizeState({
    controlOverrides: {
      model: 42,
      reasoning: 'bad',
      speed: 'turbo',
      updatedAt: {}
    }
  });
  assert.deepEqual(malformed.controlOverrides, {
    model: '',
    reasoning: '',
    speed: '',
    threadId: '',
    updatedAt: '',
    modelUpdatedAt: '',
    reasoningUpdatedAt: '',
    speedUpdatedAt: ''
  });
});

test('legacy control timestamps migrate per field and max or ultra remain exact', () => {
  const legacy = normalizeState({
    controlOverrides: {
      threadId: 'safe2', model: 'gpt-5.6-sol', reasoning: 'max',
      updatedAt: '2026-06-18T00:00:00.000Z',
    },
  });
  assert.equal(legacy.controlOverrides.modelUpdatedAt, legacy.controlOverrides.updatedAt);
  assert.equal(legacy.controlOverrides.reasoningUpdatedAt, legacy.controlOverrides.updatedAt);
  assert.equal(legacy.controlOverrides.speedUpdatedAt, '');
  assert.equal(legacy.controlOverrides.reasoning, 'max');

  const ultra = normalizeState({ controlOverrides: {
    threadId: 'safe2', reasoning: 'ultra', updatedAt: '2026-06-18T00:00:00.000Z',
  } });
  assert.equal(ultra.controlOverrides.reasoning, 'ultra');
});

test('sanitized Sakura config is based on manual route fields only', () => {
  const state = normalizeState({
    sakura: {
      enabled: true,
      apiToken: 'secret-token',
      preferredDomain: 'codexhm-demo.nyat.app',
      remotePort: 28815,
      managedTunnelIds: ['26632383'],
    },
  });
  assert.equal(state.sakura.apiToken, '');
  assert.deepEqual(sanitizeSakuraConfig(state.sakura), {
    enabled: true,
    configured: true,
    apiBase: 'https://api.natfrp.com/v4',
    preferredDomain: 'codexhm-demo.nyat.app',
    remotePort: 28815,
    preferredTypes: ['https', 'http', 'tcp'],
    preferredNodeId: '',
    managedTunnelIds: ['26632383'],
  });
});

test('writes and reads normalized state from a temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-state-'));
  const file = path.join(dir, 'state.json');
  writeState(file, {
    ...emptyState(),
    sakura: {
      enabled: true,
      apiToken: 'secret-token',
      preferredDomain: 'codexhm-demo.nyat.app',
      remotePort: 28815,
      managedTunnelIds: ['26632383'],
    },
  });
  const state = readState(file);
  assert.equal(state.sakura.apiToken, '');
  assert.equal(state.sakura.remotePort, 28815);
  assert.deepEqual(state.sakura.managedTunnelIds, ['26632383']);
});
