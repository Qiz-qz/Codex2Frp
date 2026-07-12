'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AttachmentStore,
  AttachmentStoreError,
} = require('../lib/attachments/attachment-store');

const SAMPLES = Object.freeze({
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
  'image/gif': Buffer.from('GIF89a!', 'ascii'),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]),
  'image/bmp': Buffer.concat([
    Buffer.from('BM', 'ascii'),
    Buffer.alloc(12),
  ]),
  'image/heic': Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.alloc(12),
  ]),
  'image/heif': Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmif1', 'ascii'),
    Buffer.alloc(12),
  ]),
  'application/pdf': Buffer.from('%PDF-1.7\n', 'ascii'),
});

function dataUrl(mimeType, bytes = SAMPLES[mimeType]) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function createStore(t, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-attachments-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return {
    rootDir,
    store: new AttachmentStore({ rootDir, ...options }),
  };
}

function expectAttachmentCode(error, code) {
  assert.equal(error instanceof AttachmentStoreError, true);
  assert.equal(error.code, code);
  return true;
}

test('supported attachments use stable content ids and keep payloads outside queue-safe metadata', (t) => {
  const { store, rootDir } = createStore(t, {
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    ttlMs: 60_000,
  });
  const rows = Object.entries(SAMPLES).map(([mimeType], index) => ({
    name: `folder\\sample-${index}`,
    mimeType,
    dataUrl: dataUrl(mimeType),
  }));

  const saved = store.saveBatch(rows);
  assert.equal(saved.length, rows.length);
  for (const [index, descriptor] of saved.entries()) {
    assert.match(descriptor.id, /^att_[a-f0-9]{64}$/);
    assert.equal(descriptor.mimeType, rows[index].mimeType);
    assert.equal(descriptor.sizeBytes, SAMPLES[rows[index].mimeType].length);
    assert.equal(descriptor.name.includes('\\'), false);
    assert.deepEqual(Object.keys(descriptor), [
      'id',
      'name',
      'mimeType',
      'sizeBytes',
      'createdAt',
      'expiresAt',
    ]);
    const loaded = store.read(descriptor.id);
    assert.deepEqual(loaded.data, SAMPLES[descriptor.mimeType]);
    assert.deepEqual(loaded.metadata, descriptor);
  }

  const repeated = store.saveBatch([{
    name: 'different-name.png',
    mimeType: 'image/png',
    dataUrl: dataUrl('image/png'),
  }])[0];
  assert.equal(repeated.id, saved[0].id);

  const contentFiles = fs.readdirSync(path.join(rootDir, 'content'));
  const metadataFiles = fs.readdirSync(path.join(rootDir, 'metadata'));
  assert.equal(contentFiles.length, rows.length);
  assert.equal(metadataFiles.length, rows.length);
  const queueSafeJson = JSON.stringify(saved);
  assert.equal(queueSafeJson.includes('base64'), false);
  assert.equal(queueSafeJson.includes(rootDir), false);
  assert.equal(queueSafeJson.includes(SAMPLES['application/pdf'].toString('base64')), false);
});

test('malformed data URLs, base64, unsupported MIME, MIME mismatch, and bad magic fail closed', (t) => {
  const { store, rootDir } = createStore(t);
  const cases = [
    [{ name: 'remote.png', dataUrl: 'https://example.invalid/image.png' }, 'ATTACHMENT_DATA_URL_INVALID'],
    [{ name: 'bad.png', dataUrl: 'data:image/png;base64,@@@' }, 'ATTACHMENT_BASE64_INVALID'],
    [{ name: 'text.txt', dataUrl: 'data:text/plain;base64,SGVsbG8=' }, 'ATTACHMENT_MIME_UNSUPPORTED'],
    [{ name: 'wrong.jpg', mimeType: 'image/jpeg', dataUrl: dataUrl('image/png') }, 'ATTACHMENT_MIME_MISMATCH'],
    [{ name: 'fake.png', dataUrl: 'data:image/png;base64,SGVsbG8=' }, 'ATTACHMENT_MAGIC_MISMATCH'],
  ];

  for (const [row, code] of cases) {
    assert.throws(() => store.saveBatch([row]), error => expectAttachmentCode(error, code));
  }
  assert.equal(fs.existsSync(path.join(rootDir, 'content')), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'metadata')), false);
});

test('HEIC and HEIF MIME declarations cannot swap ISO-BMFF brands', (t) => {
  const { store } = createStore(t);
  assert.throws(() => store.saveBatch([{
    name: 'wrong.heic',
    mimeType: 'image/heic',
    dataUrl: dataUrl('image/heic', SAMPLES['image/heif']),
  }]), error => expectAttachmentCode(error, 'ATTACHMENT_MAGIC_MISMATCH'));
  assert.throws(() => store.saveBatch([{
    name: 'wrong.heif',
    mimeType: 'image/heif',
    dataUrl: dataUrl('image/heif', SAMPLES['image/heic']),
  }]), error => expectAttachmentCode(error, 'ATTACHMENT_MAGIC_MISMATCH'));
});

test('count, per-file, and total byte limits reject the whole batch before any write', (t) => {
  const countHarness = createStore(t, { maxAttachments: 2 });
  assert.throws(() => countHarness.store.saveBatch([
    { name: '1.gif', dataUrl: dataUrl('image/gif') },
    { name: '2.gif', dataUrl: dataUrl('image/gif') },
    { name: '3.gif', dataUrl: dataUrl('image/gif') },
  ]), error => expectAttachmentCode(error, 'ATTACHMENT_COUNT_LIMIT'));

  const fileHarness = createStore(t, { maxFileBytes: 6 });
  assert.throws(
    () => fileHarness.store.saveBatch([{ name: 'large.gif', dataUrl: dataUrl('image/gif') }]),
    error => expectAttachmentCode(error, 'ATTACHMENT_FILE_SIZE_LIMIT'),
  );

  const totalHarness = createStore(t, { maxFileBytes: 20, maxTotalBytes: 12 });
  assert.throws(() => totalHarness.store.saveBatch([
    { name: '1.gif', dataUrl: dataUrl('image/gif') },
    { name: '2.gif', dataUrl: dataUrl('image/gif') },
  ]), error => expectAttachmentCode(error, 'ATTACHMENT_TOTAL_SIZE_LIMIT'));

  const atomicHarness = createStore(t);
  assert.throws(() => atomicHarness.store.saveBatch([
    { name: 'valid.png', dataUrl: dataUrl('image/png') },
    { name: 'invalid.png', dataUrl: 'data:image/png;base64,SGVsbG8=' },
  ]), error => expectAttachmentCode(error, 'ATTACHMENT_MAGIC_MISMATCH'));
  assert.equal(fs.existsSync(path.join(atomicHarness.rootDir, 'content')), false);
});

test('expired attachments are removed from both stores while invalid ids cannot traverse', (t) => {
  let now = new Date('2026-07-10T00:00:00.000Z');
  const { store, rootDir } = createStore(t, { now: () => now, ttlMs: 1_000 });
  const saved = store.saveBatch([{ name: '..\\secret.png', dataUrl: dataUrl('image/png') }])[0];
  assert.equal(saved.name, 'secret.png');
  assert.deepEqual(store.cleanupExpired(), []);

  now = new Date('2026-07-10T00:00:01.001Z');
  assert.deepEqual(store.cleanupExpired(), [saved.id]);
  assert.equal(store.getMetadata(saved.id), null);
  assert.equal(store.read(saved.id), null);
  assert.equal(fs.existsSync(path.join(rootDir, 'content', `${saved.id}.bin`)), false);
  assert.equal(fs.existsSync(path.join(rootDir, 'metadata', `${saved.id}.json`)), false);
  assert.throws(
    () => store.read('../outside'),
    error => expectAttachmentCode(error, 'ATTACHMENT_ID_INVALID'),
  );
});
