'use strict';

const { spawnSync } = require('node:child_process');

class SecretProtectionError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'SecretProtectionError';
    this.code = code;
    this.statusCode = 500;
    this.details = { ...details };
  }
}

function ensureWindows(platform) {
  if (platform !== 'win32') {
    throw new SecretProtectionError(
      'DPAPI_UNAVAILABLE',
      'Windows DPAPI secret protection is unavailable on this platform.',
    );
  }
}

function validBase64(value) {
  const text = String(value || '').trim();
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === text ? bytes : null;
}

function dpapiScript(operation) {
  const method = operation === 'protect' ? 'Protect' : 'Unprotect';
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$encoded = [Console]::In.ReadToEnd().Trim()',
    '$inputBytes = [Convert]::FromBase64String($encoded)',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    `$outputBytes = [System.Security.Cryptography.ProtectedData]::${method}($inputBytes, $null, $scope)`,
    '[Console]::Out.Write([Convert]::ToBase64String($outputBytes))',
  ].join("\n");
}

function runWindowsDpapi(request = {}, options = {}) {
  const platform = options.platform || process.platform;
  ensureWindows(platform);
  const operation = request.operation;
  if (operation !== 'protect' && operation !== 'unprotect') {
    throw new SecretProtectionError('DPAPI_REQUEST_INVALID', 'DPAPI operation is invalid.');
  }
  if (!Buffer.isBuffer(request.input) || request.input.length === 0) {
    throw new SecretProtectionError('DPAPI_REQUEST_INVALID', 'DPAPI input must be a non-empty buffer.');
  }

  const script = dpapiScript(operation);
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const spawnImpl = options.spawnImpl || spawnSync;
  let result;
  try {
    result = spawnImpl(options.command || 'powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ], {
      input: request.input.toString('base64'),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new SecretProtectionError(
      'DPAPI_OPERATION_FAILED',
      'Windows DPAPI operation failed.',
      { operation },
      { cause: error },
    );
  }
  if (!result || result.error || result.status !== 0) {
    throw new SecretProtectionError(
      'DPAPI_OPERATION_FAILED',
      'Windows DPAPI operation failed.',
      { operation, status: Number.isInteger(result && result.status) ? result.status : null },
      { cause: result && result.error },
    );
  }
  const output = validBase64(result.stdout);
  if (!output) {
    throw new SecretProtectionError(
      'DPAPI_OUTPUT_INVALID',
      'Windows DPAPI returned invalid output.',
      { operation },
    );
  }
  return output;
}

class WindowsDpapiSecretCodec {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.runner = typeof options.runner === 'function'
      ? options.runner
      : request => runWindowsDpapi(request, { platform: this.platform });
  }

  run(operation, input) {
    ensureWindows(this.platform);
    let output;
    try {
      output = this.runner({ operation, input });
    } catch (error) {
      if (error instanceof SecretProtectionError) throw error;
      throw new SecretProtectionError(
        'DPAPI_OPERATION_FAILED',
        'Windows DPAPI operation failed.',
        { operation },
        { cause: error },
      );
    }
    if (!Buffer.isBuffer(output) || output.length === 0) {
      throw new SecretProtectionError(
        'DPAPI_RUNNER_INVALID',
        'DPAPI runner must return a non-empty buffer.',
        { operation },
      );
    }
    return output;
  }

  encode(value) {
    ensureWindows(this.platform);
    let plaintext;
    let protectedBytes;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new SecretProtectionError(
          'SECRET_SERIALIZATION_FAILED',
          'Secret value cannot be serialized.',
        );
      }
      plaintext = Buffer.from(serialized, 'utf8');
      protectedBytes = this.run('protect', plaintext);
      return {
        scheme: 'windows-dpapi',
        version: 1,
        payload: protectedBytes.toString('base64'),
      };
    } catch (error) {
      if (error instanceof SecretProtectionError) throw error;
      throw new SecretProtectionError(
        'SECRET_SERIALIZATION_FAILED',
        'Secret value cannot be serialized.',
        {},
        { cause: error },
      );
    } finally {
      if (plaintext) plaintext.fill(0);
      if (protectedBytes) protectedBytes.fill(0);
    }
  }

  decode(envelope) {
    ensureWindows(this.platform);
    if (!envelope || typeof envelope !== 'object'
      || envelope.scheme !== 'windows-dpapi'
      || envelope.version !== 1) {
      throw new SecretProtectionError('SECRET_ENVELOPE_INVALID', 'Secret envelope is invalid.');
    }
    const protectedBytes = validBase64(envelope.payload);
    if (!protectedBytes) {
      throw new SecretProtectionError('SECRET_ENVELOPE_INVALID', 'Secret envelope is invalid.');
    }
    let plaintext;
    try {
      plaintext = this.run('unprotect', protectedBytes);
      try {
        return JSON.parse(plaintext.toString('utf8'));
      } catch (error) {
        throw new SecretProtectionError(
          'SECRET_PAYLOAD_INVALID',
          'Decrypted secret payload is invalid.',
          {},
          { cause: error },
        );
      }
    } finally {
      protectedBytes.fill(0);
      if (plaintext) plaintext.fill(0);
    }
  }
}

module.exports = {
  SecretProtectionError,
  WindowsDpapiSecretCodec,
  runWindowsDpapi,
};
