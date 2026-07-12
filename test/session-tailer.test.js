'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionTailer } = require('../lib/events/session-tailer');

class FakeFileSource {
  constructor(path, identity, text = '') {
    this.files = new Map([[path, { identity, bytes: Buffer.from(text, 'utf8') }]]);
    this.reads = [];
  }

  stat(path) {
    const file = this.files.get(path);
    return { identity: file.identity, size: file.bytes.length };
  }

  read(path, start, end) {
    this.reads.push({ start, end });
    return this.files.get(path).bytes.subarray(start, end);
  }

  append(path, text) {
    const file = this.files.get(path);
    file.bytes = Buffer.concat([file.bytes, Buffer.from(text, 'utf8')]);
  }

  replace(path, identity, text) {
    this.files.set(path, { identity, bytes: Buffer.from(text, 'utf8') });
  }
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

test('tailer commits byte offset only through complete JSONL lines and resumes a half-line', () => {
  const path = 'E:\\sessions\\rollout.jsonl';
  const first = line({ id: 'one', text: '涓枃' });
  const partial = JSON.stringify({ id: 'two', text: 'partial' });
  const split = Math.floor(partial.length / 2);
  const source = new FakeFileSource(path, 'file-a', first + partial.slice(0, split));
  const tailer = new SessionTailer({ filePath: path, source });

  const initial = tailer.poll();
  assert.deepEqual(initial.entries.map(entry => entry.item.id), ['one']);
  assert.equal(initial.cursor.offset, Buffer.byteLength(first));
  assert.equal(initial.cursor.fileIdentity, 'file-a');
  assert.equal(initial.resetReason, null);

  source.append(path, `${partial.slice(split)}\n`);
  const resumed = tailer.poll();
  assert.deepEqual(resumed.entries.map(entry => entry.item.id), ['two']);
  assert.equal(resumed.entries[0].offset, Buffer.byteLength(first));
  assert.equal(resumed.cursor.offset, Buffer.byteLength(first + partial + '\n'));
});

test('tailer cursor can be persisted and resumed without replaying committed lines', () => {
  const path = 'E:\\sessions\\resume.jsonl';
  const source = new FakeFileSource(path, 'file-resume', line({ id: 'one' }));
  const firstTailer = new SessionTailer({ filePath: path, source });
  const first = firstTailer.poll();
  source.append(path, line({ id: 'two' }));

  const resumedTailer = new SessionTailer({ filePath: path, source, cursor: first.cursor });
  const resumed = resumedTailer.poll();
  assert.deepEqual(resumed.entries.map(entry => entry.item.id), ['two']);
});

test('tailer resets to zero when the same file identity is truncated below its offset', () => {
  const path = 'E:\\sessions\\truncate.jsonl';
  const source = new FakeFileSource(path, 'file-a', line({ id: 'old-long-record', padding: 'x'.repeat(100) }));
  const tailer = new SessionTailer({ filePath: path, source });
  tailer.poll();

  source.replace(path, 'file-a', line({ id: 'new' }));
  const result = tailer.poll();
  assert.equal(result.resetReason, 'truncated');
  assert.deepEqual(result.entries.map(entry => entry.item.id), ['new']);
  assert.equal(result.entries[0].offset, 0);
});

test('tailer resets to zero when file identity changes during rotation', () => {
  const path = 'E:\\sessions\\rotate.jsonl';
  const source = new FakeFileSource(path, 'file-a', line({ id: 'old' }));
  const tailer = new SessionTailer({ filePath: path, source });
  tailer.poll();

  source.replace(path, 'file-b', line({ id: 'rotated' }));
  const result = tailer.poll();
  assert.equal(result.resetReason, 'rotated');
  assert.equal(result.cursor.fileIdentity, 'file-b');
  assert.deepEqual(result.entries.map(entry => entry.item.id), ['rotated']);
});

test('tailer fails closed on malformed complete lines while advancing past them', () => {
  const path = 'E:\\sessions\\malformed.jsonl';
  const source = new FakeFileSource(path, 'file-a', `{not-json}\n${line({ id: 'safe' })}`);
  const tailer = new SessionTailer({ filePath: path, source });

  const result = tailer.poll();
  assert.deepEqual(result.entries.map(entry => entry.item.id), ['safe']);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].offset, 0);
  assert.equal(result.cursor.offset, source.stat(path).size);
});

test('tailer reads a large append in fixed-size chunks without allocating the whole file range', () => {
  const path = 'E:\\sessions\\large.jsonl';
  const source = new FakeFileSource(path, 'file-large', [
    line({ id: 'one', padding: 'x'.repeat(70) }),
    line({ id: 'two', padding: 'y'.repeat(70) }),
    line({ id: 'three', padding: 'z'.repeat(70) }),
  ].join(''));
  const tailer = new SessionTailer({ filePath: path, source, chunkSize: 32 });

  const result = tailer.poll();
  assert.deepEqual(result.entries.map(entry => entry.item.id), ['one', 'two', 'three']);
  assert.equal(source.reads.length > 3, true);
  assert.equal(source.reads.every(read => read.end - read.start <= 32), true);
  assert.equal(result.cursor.offset, source.stat(path).size);
});
