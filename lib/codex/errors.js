'use strict';

class CodexControlError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.details = { ...details };
  }
}

class AppServerRpcError extends CodexControlError {
  constructor(message, options = {}) {
    super('APP_SERVER_RPC_ERROR', message, options.details, options);
    this.rpcCode = options.rpcCode;
    this.rpcData = options.rpcData;
  }
}

class AppServerTimeoutError extends CodexControlError {
  constructor(details) {
    super('APP_SERVER_RPC_TIMEOUT', `App-server request timed out: ${details.method}`, details);
  }
}

class AppServerExitedError extends CodexControlError {
  constructor(details) {
    super('APP_SERVER_EXITED', 'The owned app-server process exited.', details);
  }
}

class AppServerConnectionClosedError extends CodexControlError {
  constructor(details = {}, options = {}) {
    super('APP_SERVER_CONNECTION_CLOSED', 'The app-server connection is closed.', details, options);
  }
}

class AppServerProtocolError extends CodexControlError {
  constructor(message, details = {}, options = {}) {
    super('APP_SERVER_PROTOCOL_ERROR', message, details, options);
  }
}

class AppServerCompatibilityError extends CodexControlError {}

class CapabilityUnavailableError extends CodexControlError {
  constructor(operation, reason) {
    super(
      'CAPABILITY_UNAVAILABLE',
      `Codex operation is unavailable: ${operation}`,
      { operation, reason },
    );
  }
}

module.exports = {
  AppServerCompatibilityError,
  AppServerConnectionClosedError,
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  CapabilityUnavailableError,
  CodexControlError,
};
