'use strict';

const fs = require('node:fs');

function createFsFileSource() {
  return {
    stat(filePath) {
      const stat = fs.statSync(filePath);
      const stableId = Number(stat.ino) > 0
        ? `${stat.dev}:${stat.ino}`
        : `${stat.birthtimeMs}:${stat.dev}`;
      return { identity: stableId, size: stat.size };
    },
    read(filePath, start, end) {
      const length = Math.max(0, end - start);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(filePath, 'r');
      try {
        const bytesRead = fs.readSync(fd, buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

function normalizeCursor(filePath, cursor = {}) {
  const fileIdentity = String(cursor.fileIdentity || '');
  return {
    filePath,
    fileIdentity,
    offset: fileIdentity && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0
      ? cursor.offset
      : 0,
  };
}

class SessionTailer {
  constructor(options = {}) {
    this.filePath = String(options.filePath || '').trim();
    if (!this.filePath) throw new TypeError('SessionTailer requires filePath.');
    this.source = options.source || createFsFileSource();
    if (typeof this.source.stat !== 'function' || typeof this.source.read !== 'function') {
      throw new TypeError('SessionTailer source requires stat() and read().');
    }
    this.chunkSize = Number.isSafeInteger(options.chunkSize) && options.chunkSize > 0
      ? options.chunkSize
      : 64 * 1024;
    this.cursor = normalizeCursor(this.filePath, options.cursor);
  }

  poll() {
    const stat = this.source.stat(this.filePath);
    const fileIdentity = String(stat.identity || '');
    const size = Number(stat.size);
    if (!fileIdentity || !Number.isSafeInteger(size) || size < 0) {
      throw new TypeError('SessionTailer source returned invalid file metadata.');
    }

    let resetReason = null;
    if (this.cursor.fileIdentity && this.cursor.fileIdentity !== fileIdentity) {
      this.cursor.offset = 0;
      resetReason = 'rotated';
    } else if (this.cursor.fileIdentity === fileIdentity && size < this.cursor.offset) {
      this.cursor.offset = 0;
      resetReason = 'truncated';
    }
    this.cursor.fileIdentity = fileIdentity;

    const baseOffset = this.cursor.offset;
    const entries = [];
    const parseErrors = [];
    const lineParts = [];
    let lineOffset = baseOffset;
    let position = baseOffset;

    while (position < size) {
      const requestedEnd = Math.min(size, position + this.chunkSize);
      const chunkValue = this.source.read(this.filePath, position, requestedEnd);
      const sourceChunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue || '', 'utf8');
      const chunk = sourceChunk.subarray(0, requestedEnd - position);
      if (chunk.length === 0) break;
      let segmentStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        if (index > segmentStart) lineParts.push(chunk.subarray(segmentStart, index));
        let lineBuffer = lineParts.length === 0
          ? Buffer.alloc(0)
          : lineParts.length === 1
            ? lineParts[0]
            : Buffer.concat(lineParts);
        if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }
        const nextOffset = position + index + 1;
        const text = lineBuffer.toString('utf8').trim();
        if (text) {
          try {
            entries.push({
              source: 'file',
              filePath: this.filePath,
              fileIdentity,
              offset: lineOffset,
              nextOffset,
              item: JSON.parse(text),
            });
          } catch {
            parseErrors.push({ fileIdentity, offset: lineOffset, nextOffset });
          }
        }
        this.cursor.offset = nextOffset;
        lineOffset = nextOffset;
        lineParts.length = 0;
        segmentStart = index + 1;
      }
      if (segmentStart < chunk.length) lineParts.push(chunk.subarray(segmentStart));
      position += chunk.length;
    }

    return {
      entries,
      parseErrors,
      resetReason,
      cursor: { ...this.cursor },
    };
  }
}

module.exports = {
  SessionTailer,
  createFsFileSource,
};
