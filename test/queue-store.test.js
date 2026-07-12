'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProductionQueueStore,
  emptyQueueState,
} = require('../lib/queue/queue-store');

function createFile(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-queue-store-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return path.join(rootDir, 'turn-input-queue.json');
}

function fakeProtectedCodec() {
  return {
    encode(value) {
      return {
        scheme: 'fake-dpapi',
        payload: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
      };
    },
    decode(envelope) {
      if (!envelope || envelope.scheme !== 'fake-dpapi') {
        const error = new Error('protected envelope rejected');
        error.code = 'FAKE_DPAPI_REJECTED';
        throw error;
      }
      return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
    },
  };
}

test('Windows production queue persistence injects a codec and stores no plaintext', (t) => {
  const file = createFile(t);
  let codecFactoryCalls = 0;
  const store = createProductionQueueStore({
    file,
    platform: 'win32',
    codecFactory: () => {
      codecFactoryCalls += 1;
      return fakeProtectedCodec();
    },
  });
  const state = {
    schemaVersion: 1,
    items: [{ id: 'queue-1', state: 'queued', text: 'PLAINTEXT_QUEUE_CANARY' }],
  };

  store.write(state);

  assert.equal(codecFactoryCalls, 1);
  assert.equal(fs.readFileSync(file, 'utf8').includes('PLAINTEXT_QUEUE_CANARY'), false);
  assert.deepEqual(store.read(), state);
});

test('Windows protected queue reads fail closed except for a missing file', (t) => {
  const file = createFile(t);
  const store = createProductionQueueStore({
    file,
    platform: 'win32',
    codecFactory: fakeProtectedCodec,
  });

  assert.deepEqual(store.read(), emptyQueueState());
  fs.writeFileSync(file, '{"scheme":"plaintext","items":[]}', 'utf8');
  assert.throws(
    () => store.read(),
    error => error && error.code === 'QUEUE_STORE_READ_FAILED',
  );
  fs.writeFileSync(file, '{not-json', 'utf8');
  assert.throws(
    () => store.read(),
    error => error && error.code === 'QUEUE_STORE_READ_FAILED',
  );

  const decodeMissingStore = createProductionQueueStore({
    file,
    platform: 'win32',
    codecFactory: () => ({
      encode: value => value,
      decode: () => {
        const error = new Error('codec dependency missing');
        error.code = 'ENOENT';
        throw error;
      },
    }),
  });
  fs.writeFileSync(file, '{}', 'utf8');
  assert.throws(
    () => decodeMissingStore.read(),
    error => error && error.code === 'QUEUE_STORE_READ_FAILED',
  );
});

test('non-Windows production queue never constructs DPAPI and keeps legacy persistence', (t) => {
  const file = createFile(t);
  const store = createProductionQueueStore({
    file,
    platform: 'linux',
    codecFactory: () => {
      throw new Error('codec factory must not run');
    },
  });
  const state = {
    schemaVersion: 1,
    items: [{ id: 'queue-linux', state: 'queued', text: 'non-windows' }],
  };

  store.write(state);

  assert.equal(fs.readFileSync(file, 'utf8').includes('non-windows'), true);
  assert.deepEqual(store.read(), state);
});
