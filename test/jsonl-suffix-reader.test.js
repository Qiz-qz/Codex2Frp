'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonlSuffix } = require('../lib/history/jsonl-suffix-reader');

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-jsonl-suffix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

test('bounded suffix returns complete chronological lines and an older-page boundary', (t) => {
  const rows = Array.from({ length: 40 }, (_, index) => JSON.stringify({ index, text: `row-${index}` }));
  const file = fixture(t, `${rows.join('\n')}\n`);
  const first = readJsonlSuffix(file, { maxBytes: 175, chunkBytes: 37 });
  assert.ok(first.startOffset > 0);
  assert.deepEqual(first.lines.map(JSON.parse), rows.slice(-first.lines.length).map(JSON.parse));
  assert.ok(first.lines.every(line => line.startsWith('{') && line.endsWith('}')));

  const older = readJsonlSuffix(file, {
    maxBytes: fs.statSync(file).size,
    endOffset: first.startOffset,
    chunkBytes: 31,
  });
  assert.deepEqual(older.lines.concat(first.lines).map(JSON.parse), rows.map(JSON.parse));
});

test('utf8 characters split across read chunks remain intact', (t) => {
  const rows = [
    JSON.stringify({ text: '第一条🙂' }),
    JSON.stringify({ text: '第二条𠮷' }),
    JSON.stringify({ text: '第三条' }),
  ];
  const file = fixture(t, rows.join('\n'));
  const result = readJsonlSuffix(file, { maxBytes: fs.statSync(file).size, chunkBytes: 7 });
  assert.deepEqual(result.lines.map(JSON.parse), rows.map(JSON.parse));
});

test('a record larger than the byte budget is returned whole and cursor still advances', (t) => {
  const large = JSON.stringify({ id: 'large', text: 'x'.repeat(32 * 1024) });
  const small = JSON.stringify({ id: 'small' });
  const file = fixture(t, `${large}\n${small}\n`);
  const result = readJsonlSuffix(file, { maxBytes: 8 * 1024, chunkBytes: 1024 });
  assert.deepEqual(result.lines.map(JSON.parse), [{ id: 'small' }]);
  assert.equal(result.startOffset, Buffer.byteLength(`${large}\n`));
  const older = readJsonlSuffix(file, { maxBytes: 1024, endOffset: result.startOffset, chunkBytes: 256 });
  assert.deepEqual(older.lines.map(JSON.parse), [JSON.parse(large)]);
  assert.equal(older.startOffset, 0);
});

test('sparse file beyond the V8 string ceiling reads only its bounded JSONL suffix', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-jsonl-sparse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'huge-session.jsonl');
  const fd = fs.openSync(file, 'w');
  const hugeSize = 600 * 1024 * 1024;
  try {
    fs.ftruncateSync(fd, hugeSize);
    const suffix = Buffer.from(`\n${JSON.stringify({ index: 1 })}\n${JSON.stringify({ index: 2 })}\n`, 'utf8');
    fs.writeSync(fd, suffix, 0, suffix.length, hugeSize - suffix.length);
  } finally {
    fs.closeSync(fd);
  }

  const result = readJsonlSuffix(file, { maxBytes: 4096, chunkBytes: 257 });
  assert.equal(result.endOffset, hugeSize);
  assert.ok(result.scannedBytes <= 4096);
  assert.deepEqual(result.lines.map(JSON.parse), [{ index: 1 }, { index: 2 }]);
});
