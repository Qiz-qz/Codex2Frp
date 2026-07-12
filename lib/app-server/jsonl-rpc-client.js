'use strict';

const { EventEmitter } = require('node:events');
const {
  AppServerConnectionClosedError,
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
} = require('../codex/errors');

class JsonlRpcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.input || typeof options.input.write !== 'function') {
      throw new TypeError('JsonlRpcClient requires a writable input stream.');
    }
    if (!options.output || typeof options.output.on !== 'function') {
      throw new TypeError('JsonlRpcClient requires a readable output stream.');
    }
    this.input = options.input;
    this.output = options.output;
    this.connectionEpoch = Number(options.connectionEpoch) || 0;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) > 0
      ? Number(options.requestTimeoutMs)
      : 5000;
    this.sequence = 0;
    this.notificationSequence = 0;
    this.pending = new Map();
    this.pendingServerRequests = new Map();
    this.buffer = '';
    this.closed = false;

    this.onData = chunk => this.consume(chunk);
    this.onEnd = () => this.close(new AppServerConnectionClosedError({
      connectionEpoch: this.connectionEpoch,
    }));
    this.onOutputError = error => this.close(new AppServerConnectionClosedError({
      connectionEpoch: this.connectionEpoch,
    }, { cause: error }));
    this.output.on('data', this.onData);
    this.output.once('end', this.onEnd);
    this.output.once('error', this.onOutputError);
  }

  request(method, params = {}, options = {}) {
    if (this.closed) {
      return Promise.reject(new AppServerConnectionClosedError({
        connectionEpoch: this.connectionEpoch,
      }));
    }
    const id = `${this.connectionEpoch}:${++this.sequence}`;
    const timeoutMs = Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : this.requestTimeoutMs;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new AppServerTimeoutError({
          method,
          id,
          timeoutMs,
          connectionEpoch: this.connectionEpoch,
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this.input.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppServerConnectionClosedError({
          method,
          id,
          connectionEpoch: this.connectionEpoch,
        }, { cause: error }));
      }
    });
  }

  notify(method, params) {
    if (this.closed) {
      throw new AppServerConnectionClosedError({ connectionEpoch: this.connectionEpoch });
    }
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    try {
      this.input.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      const closed = new AppServerConnectionClosedError({
        method,
        connectionEpoch: this.connectionEpoch,
      }, { cause: error });
      this.close(closed);
      throw closed;
    }
  }

  respondServerRequest(id, result, options = {}) {
    const expectedEpoch = Number(options.connectionEpoch);
    const hasExpectedEpoch = Object.hasOwn(options, 'connectionEpoch');
    if (this.closed || (hasExpectedEpoch && (!Number.isSafeInteger(expectedEpoch)
      || expectedEpoch <= 0 || expectedEpoch !== this.connectionEpoch))) {
      throw new AppServerConnectionClosedError({
        connectionEpoch: this.connectionEpoch,
      });
    }
    const key = this.serverRequestKey(id);
    const entry = this.pendingServerRequests.get(key);
    if (!entry) {
      throw new AppServerProtocolError(
        'Unknown or already resolved app-server request.',
        { connectionEpoch: this.connectionEpoch },
      );
    }
    this.pendingServerRequests.delete(key);
    const payload = {
      jsonrpc: '2.0',
      id: entry.id,
      result: result === undefined ? null : result,
    };
    try {
      this.input.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      const closed = new AppServerConnectionClosedError({
        connectionEpoch: this.connectionEpoch,
      }, { cause: error });
      this.close(closed);
      throw closed;
    }
    return true;
  }

  serverRequestKey(id) {
    const type = typeof id;
    if ((type !== 'string' && type !== 'number') || (type === 'number' && !Number.isFinite(id))) {
      return '';
    }
    return `${type}:${String(id)}`;
  }

  consume(chunk) {
    if (this.closed) return;
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.consumeLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  consumeLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('protocolError', new AppServerProtocolError(
        'App-server emitted invalid JSONL.',
        { connectionEpoch: this.connectionEpoch },
        { cause: error },
      ));
      return;
    }

    if (typeof message.method === 'string' && Object.hasOwn(message, 'id')) {
      const key = this.serverRequestKey(message.id);
      if (!key || this.pendingServerRequests.has(key)) {
        this.emit('protocolError', new AppServerProtocolError(
          'App-server emitted an invalid or duplicate server request.',
          { connectionEpoch: this.connectionEpoch },
        ));
        return;
      }
      this.pendingServerRequests.set(key, { id: message.id });
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
        params: message.params,
        connectionEpoch: this.connectionEpoch,
      });
      return;
    }

    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      this.emit('notification', {
        method: message.method,
        params: message.params,
        connectionEpoch: this.connectionEpoch,
        sequence: ++this.notificationSequence,
      });
      return;
    }

    if (!Object.hasOwn(message, 'id')) {
      this.emit('protocolError', new AppServerProtocolError(
        'App-server emitted a message without a method or id.',
        { connectionEpoch: this.connectionEpoch },
      ));
      return;
    }

    const id = String(message.id);
    const entry = this.pending.get(id);
    if (!entry) {
      this.emit('lateResponse', { ...message, id, connectionEpoch: this.connectionEpoch });
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new AppServerRpcError(
        String(message.error.message || 'App-server RPC failed.'),
        {
          rpcCode: message.error.code,
          rpcData: message.error.data,
          details: { id, method: entry.method, connectionEpoch: this.connectionEpoch },
        },
      ));
      return;
    }
    entry.resolve(message.result);
  }

  handleExit({ code = null, signal = null } = {}) {
    this.close(new AppServerExitedError({
      code,
      signal,
      connectionEpoch: this.connectionEpoch,
    }));
  }

  close(error = new AppServerConnectionClosedError()) {
    if (this.closed) return;
    this.closed = true;
    this.output.removeListener('data', this.onData);
    this.output.removeListener('end', this.onEnd);
    this.output.removeListener('error', this.onOutputError);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.pendingServerRequests.clear();
  }
}

module.exports = {
  JsonlRpcClient,
};
