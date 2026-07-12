'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SecretProtectionError,
  WindowsDpapiSecretCodec,
  runWindowsDpapi,
} = require('../lib/security/secret-protection');

const TOKEN = 'DPAPI_PLAINTEXT_CANARY';

function reversibleRunner(calls) {
  return request => {
    calls.push({ operation: request.operation, input: Buffer.from(request.input) });
    const prefix = Buffer.from('dpapi:', 'ascii');
    if (request.operation === 'protect') return Buffer.concat([prefix, request.input]);
    assert.equal(request.input.subarray(0, prefix.length).equals(prefix), true);
    return Buffer.from(request.input.subarray(prefix.length));
  };
}

function expectSecretCode(error, code) {
  assert.equal(error instanceof SecretProtectionError, true);
  assert.equal(error.code, code);
  return true;
}

test('Windows codec round-trips JSON through the injected DPAPI runner without plaintext envelope', () => {
  const calls = [];
  const codec = new WindowsDpapiSecretCodec({
    platform: 'win32',
    runner: reversibleRunner(calls),
  });

  const encoded = codec.encode({ token: TOKEN, nested: { enabled: true } });
  assert.deepEqual(Object.keys(encoded), ['scheme', 'version', 'payload']);
  assert.equal(encoded.scheme, 'windows-dpapi');
  assert.equal(encoded.version, 1);
  assert.equal(JSON.stringify(encoded).includes(TOKEN), false);
  assert.deepEqual(codec.decode(encoded), { token: TOKEN, nested: { enabled: true } });
  assert.deepEqual(calls.map(call => call.operation), ['protect', 'unprotect']);
  assert.equal(calls.every(call => Buffer.isBuffer(call.input)), true);
});

test('codec rejects malformed envelopes, invalid runner output, and invalid decrypted JSON', () => {
  const codec = new WindowsDpapiSecretCodec({
    platform: 'win32',
    runner: reversibleRunner([]),
  });
  const cases = [
    [null, 'SECRET_ENVELOPE_INVALID'],
    [{ scheme: 'plaintext', version: 1, payload: 'eA==' }, 'SECRET_ENVELOPE_INVALID'],
    [{ scheme: 'windows-dpapi', version: 2, payload: 'eA==' }, 'SECRET_ENVELOPE_INVALID'],
    [{ scheme: 'windows-dpapi', version: 1, payload: '@@@' }, 'SECRET_ENVELOPE_INVALID'],
  ];
  for (const [envelope, code] of cases) {
    assert.throws(() => codec.decode(envelope), error => expectSecretCode(error, code));
  }

  const invalidRunner = new WindowsDpapiSecretCodec({
    platform: 'win32',
    runner: () => 'not-a-buffer',
  });
  assert.throws(
    () => invalidRunner.encode({ token: TOKEN }),
    error => expectSecretCode(error, 'DPAPI_RUNNER_INVALID'),
  );

  const invalidJson = new WindowsDpapiSecretCodec({
    platform: 'win32',
    runner: request => request.operation === 'protect'
      ? Buffer.from(request.input)
      : Buffer.from('not-json', 'utf8'),
  });
  const envelope = invalidJson.encode({ token: TOKEN });
  assert.throws(
    () => invalidJson.decode(envelope),
    error => expectSecretCode(error, 'SECRET_PAYLOAD_INVALID'),
  );
});

test('non-Windows platforms fail closed before an injected runner can observe secrets', () => {
  let calls = 0;
  const codec = new WindowsDpapiSecretCodec({
    platform: 'linux',
    runner: () => { calls += 1; return Buffer.alloc(0); },
  });

  assert.throws(
    () => codec.encode({ token: TOKEN }),
    error => expectSecretCode(error, 'DPAPI_UNAVAILABLE'),
  );
  assert.throws(
    () => codec.decode({ scheme: 'windows-dpapi', version: 1, payload: 'eA==' }),
    error => expectSecretCode(error, 'DPAPI_UNAVAILABLE'),
  );
  assert.equal(calls, 0);
});

test('default DPAPI runner hides the window, disables shell, and sends secret bytes on stdin', () => {
  const spawnCalls = [];
  const protectedBytes = Buffer.from('protected-output', 'utf8');
  const result = runWindowsDpapi({
    operation: 'protect',
    input: Buffer.from(TOKEN, 'utf8'),
  }, {
    platform: 'win32',
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { status: 0, stdout: protectedBytes.toString('base64'), stderr: '' };
    },
  });

  assert.deepEqual(result, protectedBytes);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'powershell.exe');
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.equal(spawnCalls[0].options.input, Buffer.from(TOKEN).toString('base64'));
  assert.equal(spawnCalls[0].args.join(' ').includes(TOKEN), false);
});

test('default DPAPI runner explicitly loads the System.Security assembly for clean PowerShell sessions', () => {
  let decodedScript = '';
  runWindowsDpapi({
    operation: 'protect',
    input: Buffer.from(TOKEN, 'utf8'),
  }, {
    platform: 'win32',
    spawnImpl(_command, args) {
      const encodedCommand = args[args.indexOf('-EncodedCommand') + 1];
      decodedScript = Buffer.from(encodedCommand, 'base64').toString('utf16le');
      return { status: 0, stdout: Buffer.from('protected-output').toString('base64'), stderr: '' };
    },
  });

  assert.match(decodedScript, /Add-Type -AssemblyName System\.Security/);
  assert.ok(
    decodedScript.indexOf('Add-Type -AssemblyName System.Security')
      < decodedScript.indexOf('[System.Security.Cryptography.DataProtectionScope]'),
    'the assembly is loaded before its DPAPI types are resolved',
  );
});
