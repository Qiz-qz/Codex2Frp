'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { JsonlRpcClient } = require('./jsonl-rpc-client');
const {
  AppServerConnectionClosedError,
  CodexControlError,
} = require('../codex/errors');

const DEFAULT_APP_SERVER_ARGS = Object.freeze([
  '-c',
  'features.code_mode_host=true',
  'app-server',
  '--analytics-default-enabled',
]);

class AppServerProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawnImpl = options.spawnImpl || spawn;
    this.command = options.command || 'codex';
    this.args = options.args ? [...options.args] : [...DEFAULT_APP_SERVER_ARGS];
    this.baseEnv = options.env ? { ...options.env } : {};
    this.requestTimeoutMs = Number(options.requestTimeoutMs) > 0
      ? Number(options.requestTimeoutMs)
      : 5000;
    this.connectionEpoch = 0;
    this.owned = null;
  }

  get ownedPid() {
    return this.owned ? this.owned.child.pid : null;
  }

  start(options = {}) {
    if (this.owned) {
      throw new CodexControlError(
        'APP_SERVER_ALREADY_RUNNING',
        'This manager already owns an app-server process.',
        { pid: this.owned.child.pid, connectionEpoch: this.owned.connectionEpoch },
      );
    }
    const codexHome = String(options.codexHome || '').trim();
    if (!codexHome) throw new TypeError('AppServerProcessManager.start requires codexHome.');

    const command = options.command || this.command;
    const args = options.args ? [...options.args] : [...this.args];
    const child = this.spawnImpl(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...this.baseEnv,
        ...(options.env || {}),
        CODEX_HOME: codexHome,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child || !Number.isInteger(child.pid) || !child.stdin || !child.stdout) {
      throw new TypeError('spawnImpl must return a child process with pid, stdin, and stdout.');
    }

    const connectionEpoch = this.connectionEpoch + 1;
    this.connectionEpoch = connectionEpoch;
    const client = new JsonlRpcClient({
      input: child.stdin,
      output: child.stdout,
      connectionEpoch,
      requestTimeoutMs: options.requestTimeoutMs || this.requestTimeoutMs,
    });
    const owned = { child, client, connectionEpoch };
    this.owned = owned;

    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', chunk => {
        const text = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).slice(0, 4096);
        this.emit('stderr', { pid: child.pid, connectionEpoch, text });
      });
    }

    child.once('exit', (code, signal) => {
      client.handleExit({ code, signal });
      if (this.owned === owned) this.owned = null;
      this.emit('exit', { pid: child.pid, code, signal, connectionEpoch });
    });
    child.once('error', error => {
      client.close(new AppServerConnectionClosedError(
        { pid: child.pid, connectionEpoch },
        { cause: error },
      ));
      if (this.owned === owned) this.owned = null;
      this.emit('processError', { pid: child.pid, error, connectionEpoch });
    });

    return { pid: child.pid, connectionEpoch, client };
  }

  stop(signal = 'SIGTERM') {
    if (!this.owned) return false;
    return this.owned.child.kill(signal) !== false;
  }
}

module.exports = {
  AppServerProcessManager,
  DEFAULT_APP_SERVER_ARGS,
};
