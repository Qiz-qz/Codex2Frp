'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

function clampOffset(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return maximum;
  return Math.max(0, Math.min(maximum, Math.floor(number)));
}

function readByte(fd, offset) {
  const buffer = Buffer.allocUnsafe(1);
  return fs.readSync(fd, buffer, 0, 1, offset) === 1 ? buffer[0] : -1;
}

function findNextNewline(fd, start, end, chunkBytes) {
  let offset = start;
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, end - start)));
  while (offset < end) {
    const length = Math.min(buffer.length, end - offset);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    if (!bytesRead) break;
    const index = buffer.indexOf(0x0a, 0);
    if (index >= 0 && index < bytesRead) return offset + index;
    offset += bytesRead;
  }
  return -1;
}

function findPreviousNewline(fd, before, chunkBytes) {
  let end = before;
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, before)));
  while (end > 0) {
    const start = Math.max(0, end - buffer.length);
    const length = end - start;
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    if (!bytesRead) break;
    const index = buffer.lastIndexOf(0x0a, bytesRead - 1);
    if (index >= 0) return start + index;
    end = start;
  }
  return -1;
}

function alignedSuffixStart(fd, rawStart, end, chunkBytes) {
  if (rawStart <= 0) return 0;
  if (readByte(fd, rawStart - 1) === 0x0a) return rawStart;

  // Drop only the partial prefix. That complete record belongs to the next,
  // older page ending at the returned line boundary.
  const nextNewline = findNextNewline(fd, rawStart, end, chunkBytes);
  if (nextNewline >= 0 && nextNewline + 1 < end) return nextNewline + 1;

  // A single record may consume the whole byte window (with or without its
  // final newline). Extend to its boundary rather than splitting it or
  // returning an empty page whose cursor cannot advance.
  const previousNewline = findPreviousNewline(fd, rawStart, chunkBytes);
  return previousNewline >= 0 ? previousNewline + 1 : 0;
}

function streamLines(fd, start, end, chunkBytes) {
  const lines = [];
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, end - start)));
  let offset = start;
  let pending = '';
  while (offset < end) {
    const length = Math.min(buffer.length, end - offset);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    if (!bytesRead) break;
    pending += decoder.write(buffer.subarray(0, bytesRead));
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      if (line) lines.push(line);
      pending = pending.slice(newline + 1);
    }
    offset += bytesRead;
  }
  pending += decoder.end();
  if (pending) lines.push(pending.replace(/\r$/, ''));
  return lines;
}

function readJsonlSuffix(file, options = {}) {
  const stat = fs.statSync(file);
  const endOffset = clampOffset(options.endOffset, stat.size);
  const maxBytes = Math.max(0, Math.floor(Number(options.maxBytes) || 0));
  const chunkBytes = Math.max(4, Math.floor(Number(options.chunkBytes) || DEFAULT_CHUNK_BYTES));
  if (!endOffset || !maxBytes) {
    return { lines: [], stat, startOffset: endOffset, endOffset, scannedBytes: 0 };
  }

  const rawStart = Math.max(0, endOffset - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const startOffset = alignedSuffixStart(fd, rawStart, endOffset, chunkBytes);
    return {
      lines: streamLines(fd, startOffset, endOffset, chunkBytes),
      stat,
      startOffset,
      endOffset,
      scannedBytes: endOffset - startOffset,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readJsonlSuffix };
