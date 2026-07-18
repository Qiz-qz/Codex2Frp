'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bindCdpTargetToProbeEndpoint,
  normalizeCdpProbeHost,
} = require('../lib/windows/cdp-endpoint');

test('an IPv6-only loopback probe rewrites Chromium IPv4 debugger URLs to the reachable endpoint', () => {
  const target = bindCdpTargetToProbeEndpoint({
    id: 'main',
    type: 'page',
    webSocketDebuggerUrl: 'ws://127.0.0.1:39252/devtools/page/main',
  }, { host: '[::1]', port: 39252 });

  assert.equal(target.webSocketDebuggerUrl, 'ws://[::1]:39252/devtools/page/main');
  assert.deepEqual(target.cdpEndpoint, { host: '::1', port: 39252 });
});

test('the successful loopback probe host replaces localhost but never rewrites a remote debugger host', () => {
  assert.equal(normalizeCdpProbeHost('[::1]'), '::1');
  assert.equal(bindCdpTargetToProbeEndpoint({
    webSocketDebuggerUrl: 'ws://localhost:39252/devtools/page/main',
  }, { host: '127.0.0.1', port: 39252 }).webSocketDebuggerUrl,
  'ws://127.0.0.1:39252/devtools/page/main');

  assert.equal(bindCdpTargetToProbeEndpoint({
    webSocketDebuggerUrl: 'wss://desktop.example.test/devtools/page/main',
  }, { host: '::1', port: 39252 }).webSocketDebuggerUrl,
  'wss://desktop.example.test/devtools/page/main');
});
