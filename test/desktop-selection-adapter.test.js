'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  consumeDesktopSelectionForSync,
  createDesktopSelectionAdapter,
  normalizeVerifiedDesktopSelection,
  verifiedSelectionExpression,
} = require('../lib/control/desktop-selection-adapter');

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('desktop selection accepts only exact UUIDs from verified route or active action attributes', () => {
  assert.deepEqual(normalizeVerifiedDesktopSelection({
    route: `codex://threads/${THREAD}`,
    observedAt: '2026-07-14T00:00:00.000Z',
  }), { threadId: THREAD, source: 'desktop-route', observedAt: '2026-07-14T00:00:00.000Z', confidence: 'exact' });
  assert.deepEqual(normalizeVerifiedDesktopSelection({
    actionAttributes: {
      'data-app-action-sidebar-thread-id': `local:${THREAD}`,
      'data-app-action-sidebar-thread-active': 'true',
    },
    observedAt: '2026-07-14T00:00:01.000Z',
  }), { threadId: THREAD, source: 'desktop-action-attribute', observedAt: '2026-07-14T00:00:01.000Z', confidence: 'exact' });
});

test('desktop selection never uses title, row index, recency, text, or database flags as identity', () => {
  for (const raw of [
    { selectedRow: { title: THREAD } }, { title: THREAD, text: THREAD },
    { index: 0, recentThreadId: THREAD }, { database: { selectedThreadId: THREAD } },
    { actionAttributes: { 'data-app-action-sidebar-thread-id': THREAD } },
    { actionAttributes: { 'data-app-action-sidebar-thread-id': THREAD, 'data-app-action-sidebar-thread-active': 'false' } },
    { route: `https://example.invalid/search?q=${THREAD}` },
    { route: `https://example.invalid/threads/${THREAD}` },
    { route: `file:///threads/${THREAD}` },
    { route: `codex://evil/threads/${THREAD}` },
    { route: `codex://threads/${THREAD}/settings` },
    { route: `app://evil/index.html#/threads/${THREAD}` },
  ]) assert.equal(normalizeVerifiedDesktopSelection(raw), null);
});

test('verified Codex renderer hash route is accepted but unrelated renderer paths are rejected', () => {
  assert.equal(normalizeVerifiedDesktopSelection({
    route: `app://-/index.html#/threads/${THREAD}`,
  }).threadId, THREAD);
  assert.equal(normalizeVerifiedDesktopSelection({
    route: `app://-/settings.html#/threads/${THREAD}`,
  }), null);
});

test('conflicting exact route and active-action UUID evidence fails closed', () => {
  assert.equal(normalizeVerifiedDesktopSelection({
    route: `app://-/index.html#/threads/${THREAD}`,
    actionAttributes: {
      'data-app-action-sidebar-thread-id': OTHER_THREAD,
      'data-app-action-sidebar-thread-active': 'true',
    },
  }), null);
});

test('renderer selection expression accepts exactly one unique active UUID', () => {
  const element = threadId => ({
    getBoundingClientRect: () => ({ width: 100, height: 20, bottom: 20, y: 0, right: 100, x: 0 }),
    getAttribute: name => name === 'data-app-action-sidebar-thread-id'
      ? threadId
      : name === 'data-app-action-sidebar-thread-active' ? 'true' : '',
  });
  const evaluate = (ids, href = 'app://-/index.html') => vm.runInNewContext(verifiedSelectionExpression(), {
    document: { querySelectorAll: () => ids.map(element) },
    location: { href },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    innerHeight: 800,
    innerWidth: 600,
  });
  assert.equal(evaluate([THREAD]).actionAttributes['data-app-action-sidebar-thread-id'], THREAD);
  assert.equal(evaluate([THREAD, OTHER_THREAD]), null);
  assert.equal(evaluate([THREAD, OTHER_THREAD], `app://-/index.html#/threads/${THREAD}`), null);
  assert.equal(evaluate([THREAD, THREAD]).actionAttributes['data-app-action-sidebar-thread-id'], THREAD);
});

test('phone open is confirmed only after exact observed UUID and suppresses its source-token echo', async () => {
  const observations = [{ route: `codex://threads/${OTHER_THREAD}` }, { route: `codex://threads/${THREAD}` }];
  const navigation = [];
  const contexts = [];
  const adapter = createDesktopSelectionAdapter({
    observeSource: async () => observations.shift() || { route: `codex://threads/${THREAD}` },
    navigate: async request => navigation.push(request),
    transaction: { run: async (context, operation) => { contexts.push(context); return operation({}); } },
    createIntent: ({ action, threadId }) => ({ id: 'intent', action, threadId }),
    createSourceToken: () => 'phone-token', sleep: async () => {},
    now: (() => { let value = 0; return () => value += 10; })(),
    confirmationTimeoutMs: 100, confirmationPollIntervalMs: 10,
  });
  assert.deepEqual(await adapter.openDesktopThread(THREAD), {
    status: 'confirmed', requestedThreadId: THREAD, observedThreadId: THREAD,
  });
  assert.deepEqual(navigation, [{ threadId: THREAD, sourceToken: 'phone-token' }]);
  assert.equal(contexts[0].action, 'thread.openDesktop');
  assert.equal(contexts[0].threadId, THREAD);
  const echo = await adapter.observeDesktopSelection({ route: `codex://threads/${THREAD}`, sourceToken: 'phone-token' });
  assert.equal(echo.suppressEcho, true);
  assert.equal(echo.sourceToken, 'phone-token');
});

test('phone open fails closed on exact mismatch or absent exact observation', async () => {
  const make = raw => createDesktopSelectionAdapter({
    observeSource: async () => raw, navigate: async () => {},
    transaction: { run: async (_context, operation) => operation({}) },
    createIntent: ({ action, threadId }) => ({ action, threadId }), createSourceToken: () => 'token',
    sleep: async () => {}, now: (() => { let value = 0; return () => value += 10; })(),
    confirmationTimeoutMs: 20, confirmationPollIntervalMs: 10,
  });
  assert.deepEqual(await make({ route: `codex://threads/${OTHER_THREAD}` }).openDesktopThread(THREAD), {
    status: 'uncertain', requestedThreadId: THREAD, observedThreadId: OTHER_THREAD, reason: 'desktop_selection_mismatch',
  });
  assert.deepEqual(await make({ title: THREAD, text: THREAD }).openDesktopThread(THREAD), {
    status: 'unavailable', requestedThreadId: THREAD, reason: 'exact_desktop_selection_unavailable',
  });
  assert.deepEqual(await make({
    route: `codex://threads/${THREAD}`,
    actionAttributes: {
      'data-app-action-sidebar-thread-id': OTHER_THREAD,
      'data-app-action-sidebar-thread-active': 'true',
    },
  }).openDesktopThread(THREAD), {
    status: 'unavailable', requestedThreadId: THREAD, reason: 'exact_desktop_selection_unavailable',
  });
});

test('failed phone navigation does not suppress a later real desktop selection', async () => {
  const adapter = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${OTHER_THREAD}` }),
    navigate: async () => {}, transaction: { run: async (_context, operation) => operation({}) },
    createIntent: ({ action, threadId }) => ({ action, threadId }), createSourceToken: () => 'failed-token',
    sleep: async () => {}, now: (() => { let value = 0; return () => value += 10; })(),
    confirmationTimeoutMs: 10, confirmationPollIntervalMs: 10,
  });
  assert.equal((await adapter.openDesktopThread(THREAD)).status, 'uncertain');
  const later = await adapter.observeDesktopSelection({ route: `codex://threads/${THREAD}` });
  assert.equal(Object.hasOwn(later, 'suppressEcho'), false);
});

test('confirmed phone source remains suppressed until desktop selection changes', async () => {
  let now = 0;
  const adapter = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${THREAD}` }),
    navigate: async () => {}, transaction: { run: async (_context, operation) => operation({}) },
    createIntent: ({ action, threadId }) => ({ action, threadId }), createSourceToken: () => 'short-token',
    sleep: async () => {}, now: () => now,
    confirmationTimeoutMs: 10, confirmationPollIntervalMs: 10, sourceTokenTtlMs: 50,
  });
  assert.equal((await adapter.openDesktopThread(THREAD)).status, 'confirmed');
  now = 100;
  const later = await adapter.observeDesktopSelection({ route: `codex://threads/${THREAD}` });
  assert.equal(later.suppressEcho, true);
  const changed = await adapter.observeDesktopSelection({ route: `codex://threads/${OTHER_THREAD}` });
  assert.equal(Object.hasOwn(changed, 'suppressEcho'), false);
  const userReturned = await adapter.observeDesktopSelection({ route: `codex://threads/${THREAD}` });
  assert.equal(Object.hasOwn(userReturned, 'suppressEcho'), false);
});

test('invalid requested IDs never enter transaction or navigation', async () => {
  let transactionCalls = 0; let navigationCalls = 0;
  const adapter = createDesktopSelectionAdapter({
    observeSource: async () => null, navigate: async () => { navigationCalls += 1; },
    transaction: { run: async () => { transactionCalls += 1; } },
  });
  assert.deepEqual(await adapter.openDesktopThread('latest-thread'), {
    status: 'unavailable', requestedThreadId: '', reason: 'invalid_thread_id',
  });
  assert.equal(transactionCalls, 0); assert.equal(navigationCalls, 0);
});

test('production sync consumes phone-origin suppression and publishes later desktop selections', async () => {
  const adapter = createDesktopSelectionAdapter({
    observeSource: async () => ({ route: `codex://threads/${THREAD}` }),
    navigate: async () => {}, transaction: { run: async (_context, operation) => operation({}) },
    createIntent: ({ action, threadId }) => ({ action, threadId }), createSourceToken: () => 'sync-token',
    sleep: async () => {}, confirmationTimeoutMs: 10, confirmationPollIntervalMs: 10,
  });
  assert.equal((await adapter.openDesktopThread(THREAD)).status, 'confirmed');
  assert.deepEqual(await consumeDesktopSelectionForSync(adapter), {
    selection: null,
    suppressed: true,
    reason: 'phone_origin',
  });
  const next = await consumeDesktopSelectionForSync(adapter);
  assert.equal(next.suppressed, true);
  adapter.observeSource = async () => ({ route: `codex://threads/${OTHER_THREAD}` });
  const desktopSwitch = await consumeDesktopSelectionForSync(adapter);
  assert.equal(desktopSwitch.suppressed, false);
  assert.equal(desktopSwitch.selection.threadId, OTHER_THREAD);
});
