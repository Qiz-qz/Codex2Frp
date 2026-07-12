'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WindowsDpapiSecretCodec } = require('../security/secret-protection');

class QueueStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueueStoreError';
    this.code = code;
    this.details = { ...details };
  }
}

function emptyQueueState() {
  return { schemaVersion: 1, items: [] };
}

function normalizeQueueState(value) {
  if (!value || typeof value !== 'object') return emptyQueueState();
  return {
    schemaVersion: 1,
    items: Array.isArray(value.items) ? value.items.filter(item => item && typeof item === 'object') : [],
  };
}

class QueueStore {
  constructor(options = {}) {
    this.file = typeof options.file === 'string' ? options.file : '';
    this.codec = options.codec || {
      encode: value => value,
      decode: value => value,
    };
    this.failClosed = options.failClosed === true;
    this.memory = emptyQueueState();
  }

  read() {
    if (!this.file) return normalizeQueueState(this.memory);
    let source;
    try {
      source = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyQueueState();
      if (!this.failClosed) return emptyQueueState();
      throw new QueueStoreError(
        'QUEUE_STORE_READ_FAILED',
        'Protected queue persistence could not be read safely.',
        { causeCode: String(error && error.code || 'QUEUE_STORE_UNREADABLE') },
      );
    }
    try {
      const encoded = JSON.parse(source);
      return normalizeQueueState(this.codec.decode(encoded));
    } catch (error) {
      if (this.failClosed) {
        throw new QueueStoreError(
          'QUEUE_STORE_READ_FAILED',
          'Protected queue persistence could not be decoded safely.',
          { causeCode: String(error && error.code || 'QUEUE_STORE_INVALID') },
        );
      }
      return emptyQueueState();
    }
  }

  write(value) {
    const normalized = normalizeQueueState(value);
    if (!this.file) {
      this.memory = JSON.parse(JSON.stringify(normalized));
      return normalizeQueueState(this.memory);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const encoded = this.codec.encode(normalized);
    fs.writeFileSync(temporary, `${JSON.stringify(encoded, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, this.file);
    return normalized;
  }
}

function createProductionQueueStore(options = {}) {
  const platform = String(options.platform || process.platform);
  if (platform !== 'win32') {
    return new QueueStore({ file: options.file });
  }
  const codecFactory = typeof options.codecFactory === 'function'
    ? options.codecFactory
    : () => new WindowsDpapiSecretCodec({ platform });
  const codec = options.codec || codecFactory();
  return new QueueStore({
    file: options.file,
    codec,
    failClosed: true,
  });
}

module.exports = {
  QueueStore,
  QueueStoreError,
  createProductionQueueStore,
  emptyQueueState,
  normalizeQueueState,
};
