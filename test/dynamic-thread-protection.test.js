'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createDynamicProtectedThreadGuard,
  ThreadProtectionRegistry,
} = require('../lib/control/dynamic-thread-protection');
const { CommandCoordinator } = require('../lib/control/command-coordinator');

const ENVIRONMENT_THREAD = '11111111-1111-4111-8111-111111111111';
const STATIC_THREAD = '22222222-2222-4222-8222-222222222222';
const USER_THREAD = '33333333-3333-4333-8333-333333333333';
const OTHER_THREAD = '44444444-4444-4444-8444-444444444444';

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-thread-protection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'protected-threads.json');
  return {
    root,
    file,
    createRegistry(overrides = {}) {
      return new ThreadProtectionRegistry({
        file,
        environment: { CODEX_THREAD_ID: ENVIRONMENT_THREAD },
        protectedThreadIds: [STATIC_THREAD],
        ...options,
        ...overrides,
      });
    },
  };
}

test('status exposes only target protection and aggregate metadata for permanent layers', (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();

  assert.equal(registry.isProtected(ENVIRONMENT_THREAD), true);
  assert.equal(registry.isProtected(STATIC_THREAD), true);
  assert.equal(registry.isProtected(USER_THREAD), false);
  const status = registry.status(ENVIRONMENT_THREAD);
  assert.deepEqual(status, {
    protected: true,
    protectedCount: 2,
    environmentProtected: true,
    revision: 0,
  });
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(ENVIRONMENT_THREAD), false);
  assert.equal(serialized.includes(STATIC_THREAD), false);
  assert.equal(serialized.includes(USER_THREAD), false);
});

test('user protection is added and removed atomically with aggregate-only responses', (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();

  const added = registry.protect(USER_THREAD, { expectedRevision: 0 });
  assert.deepEqual(added, {
    protected: true,
    protectedCount: 3,
    environmentProtected: true,
    revision: 1,
    changed: true,
  });
  assert.equal(JSON.stringify(added).includes(USER_THREAD), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), {
    schemaVersion: 1,
    revision: 1,
    userProtectedThreadIds: [USER_THREAD],
  });

  const removed = registry.unprotect(USER_THREAD, { expectedRevision: 1 });
  assert.deepEqual(removed, {
    protected: false,
    protectedCount: 2,
    environmentProtected: true,
    revision: 2,
    changed: true,
  });
  assert.equal(JSON.stringify(removed).includes(USER_THREAD), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), {
    schemaVersion: 1,
    revision: 2,
    userProtectedThreadIds: [],
  });
  assert.deepEqual(
    fs.readdirSync(h.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')),
    [],
  );
});

test('user protection survives restart and refresh observes another instance mutation', (t) => {
  const h = createHarness(t);
  const first = h.createRegistry();
  first.protect(USER_THREAD, { expectedRevision: 0 });

  const restarted = h.createRegistry();
  assert.equal(restarted.isProtected(USER_THREAD), true);
  assert.equal(restarted.status(USER_THREAD).revision, 1);
  restarted.unprotect(USER_THREAD, { expectedRevision: 1 });

  const refreshed = first.refresh();
  assert.deepEqual(refreshed, {
    protectedCount: 2,
    environmentProtected: true,
    revision: 2,
  });
  assert.equal(first.isProtected(USER_THREAD), false);
});

test('environment and static protection cannot be removed and stable 403 errors leak no ids', (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();

  for (const protectedThreadId of [ENVIRONMENT_THREAD, STATIC_THREAD]) {
    assert.throws(
      () => registry.unprotect(protectedThreadId, { expectedRevision: 0 }),
      error => {
        assert.equal(error.code, 'PROTECTION_IMMUTABLE');
        assert.equal(error.statusCode, 403);
        assert.deepEqual(error.details, {});
        const serialized = JSON.stringify({
          message: error.message,
          code: error.code,
          statusCode: error.statusCode,
          details: error.details,
        });
        assert.equal(serialized.includes(protectedThreadId), false);
        return true;
      },
    );
  }
  assert.deepEqual(registry.summary(), {
    protectedCount: 2,
    environmentProtected: true,
    revision: 0,
  });
  assert.equal(fs.existsSync(h.file), false);
});

test('a corrupt persistence file makes refresh, reads, and writes fail closed without id leakage', (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();
  fs.writeFileSync(
    h.file,
    `{"schemaVersion":1,"revision":0,"userProtectedThreadIds":["${USER_THREAD}"]`,
    'utf8',
  );

  const expectStoreFailure = error => {
    assert.equal(error.code, 'PROTECTION_STORE_INVALID');
    assert.equal(error.statusCode, 503);
    assert.deepEqual(error.details, {});
    const serialized = JSON.stringify({
      message: error.message,
      code: error.code,
      details: error.details,
    });
    assert.equal(serialized.includes(USER_THREAD), false);
    assert.equal(serialized.includes(h.file), false);
    return true;
  };

  assert.throws(() => registry.refresh(), expectStoreFailure);
  assert.throws(() => registry.isProtected(USER_THREAD), expectStoreFailure);
  assert.throws(
    () => registry.protect(USER_THREAD, { expectedRevision: 0 }),
    expectStoreFailure,
  );
  assert.deepEqual(
    fs.readdirSync(h.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')),
    [],
  );
  assert.throws(() => h.createRegistry(), expectStoreFailure);
});

test('revision and lock conflicts reject concurrent writers without losing state or leaking ids', (t) => {
  const h = createHarness(t);
  const first = h.createRegistry();
  const stale = h.createRegistry();
  first.protect(USER_THREAD, { expectedRevision: 0 });

  assert.throws(
    () => stale.protect(OTHER_THREAD, { expectedRevision: 0 }),
    error => {
      assert.equal(error.code, 'PROTECTION_REVISION_CONFLICT');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, { expectedRevision: 0, actualRevision: 1 });
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes(USER_THREAD), false);
      assert.equal(serialized.includes(OTHER_THREAD), false);
      return true;
    },
  );
  assert.equal(stale.status(USER_THREAD).protected, true);
  assert.equal(stale.summary().revision, 1);

  const lockFile = `${h.file}.lock`;
  fs.writeFileSync(lockFile, '', { flag: 'wx' });
  assert.throws(
    () => stale.protect(OTHER_THREAD, { expectedRevision: 1 }),
    error => {
      assert.equal(error.code, 'PROTECTION_STORE_BUSY');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details, {});
      assert.equal(JSON.stringify(error).includes(OTHER_THREAD), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(lockFile), true);
  fs.unlinkSync(lockFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), {
    schemaVersion: 1,
    revision: 1,
    userProtectedThreadIds: [USER_THREAD],
  });
});

test('one dynamic guard queries the registry for target, observed, and desktop mutations', async (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();
  const guard = createDynamicProtectedThreadGuard({ registry });
  const coordinator = new CommandCoordinator({ guard });
  registry.protect(USER_THREAD, { expectedRevision: 0 });
  let calls = 0;

  for (const context of [
    { action: 'queue.enqueue', threadId: USER_THREAD },
    { action: 'turn.start', threadId: OTHER_THREAD, observedThreadId: USER_THREAD },
    {
      action: 'control.model',
      mode: 'ui',
      threadId: OTHER_THREAD,
      desktopThreadId: ENVIRONMENT_THREAD,
    },
  ]) {
    await assert.rejects(
      coordinator.run(context, async () => { calls += 1; }),
      error => error && error.code === 'PROTECTED_THREAD',
    );
  }
  assert.equal(calls, 0);

  const read = guard.assertAllowed({ action: 'thread.read', threadId: USER_THREAD });
  assert.equal(read.mode, 'read');
  registry.unprotect(USER_THREAD, { expectedRevision: 1 });
  const result = await coordinator.run({
    action: 'queue.enqueue',
    threadId: USER_THREAD,
  }, async () => {
    calls += 1;
    return 'allowed';
  });
  assert.equal(result, 'allowed');
  assert.equal(calls, 1);
});

test('invalid targets and revisions are rejected before persistence with privacy-safe 400 errors', (t) => {
  const h = createHarness(t);
  const registry = h.createRegistry();

  for (const operation of [
    () => registry.status('  '),
    () => registry.protect(null, { expectedRevision: 0 }),
    () => registry.unprotect(42, { expectedRevision: 0 }),
  ]) {
    assert.throws(operation, error => {
      assert.equal(error.code, 'PROTECTION_TARGET_REQUIRED');
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.details, {});
      return true;
    });
  }
  assert.throws(
    () => registry.protect(USER_THREAD, { expectedRevision: -1 }),
    error => {
      assert.equal(error.code, 'PROTECTION_REVISION_INVALID');
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.details, {});
      assert.equal(JSON.stringify(error).includes(USER_THREAD), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(h.file), false);
});

test('atomic rename failure preserves the previous state and returns a privacy-safe store error', (t) => {
  const h = createHarness(t);
  const initial = h.createRegistry();
  initial.protect(USER_THREAD, { expectedRevision: 0 });
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          const error = new Error(`${OTHER_THREAD} ${source} ${destination}`);
          error.code = 'EIO';
          throw error;
        };
      }
      return Reflect.get(target, property);
    },
  });
  const registry = h.createRegistry({ fs: failingFs });

  assert.throws(
    () => registry.unprotect(USER_THREAD, { expectedRevision: 1 }),
    error => {
      assert.equal(error.code, 'PROTECTION_STORE_WRITE_FAILED');
      assert.equal(error.statusCode, 503);
      assert.deepEqual(error.details, {});
      const serialized = JSON.stringify({ message: error.message, ...error });
      assert.equal(serialized.includes(USER_THREAD), false);
      assert.equal(serialized.includes(OTHER_THREAD), false);
      assert.equal(serialized.includes(h.file), false);
      return true;
    },
  );
  assert.equal(registry.isProtected(USER_THREAD), true);
  assert.equal(registry.summary().revision, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), {
    schemaVersion: 1,
    revision: 1,
    userProtectedThreadIds: [USER_THREAD],
  });
  assert.deepEqual(
    fs.readdirSync(h.root).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')),
    [],
  );
});

test('lock cleanup attempts unlink after close failure and reports a stable committed result', (t) => {
  const h = createHarness(t);
  let failClose = true;
  const cleanupFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'closeSync') {
        return handle => {
          target.closeSync(handle);
          if (failClose) {
            failClose = false;
            throw new Error(`${USER_THREAD} ${h.file}`);
          }
        };
      }
      return Reflect.get(target, property);
    },
  });
  const registry = h.createRegistry({ fs: cleanupFs });

  assert.throws(
    () => registry.protect(USER_THREAD, { expectedRevision: 0 }),
    error => {
      assert.equal(error.code, 'PROTECTION_STORE_CLEANUP_FAILED');
      assert.equal(error.statusCode, 503);
      assert.deepEqual(error.details, { committed: true });
      const serialized = JSON.stringify({ message: error.message, ...error });
      assert.equal(serialized.includes(USER_THREAD), false);
      assert.equal(serialized.includes(h.file), false);
      return true;
    },
  );
  assert.equal(fs.existsSync(`${h.file}.lock`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), {
    schemaVersion: 1,
    revision: 1,
    userProtectedThreadIds: [USER_THREAD],
  });
});
