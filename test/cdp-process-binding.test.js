'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcileCdpProcessBinding } = require('../lib/windows/cdp-process-binding');

test('rebinds control to the process that owns the exact live CDP port', () => {
  assert.equal(reconcileCdpProcessBinding({
    port: 39258,
    currentProcessId: 11660,
    processes: [{ port: 39258, processId: 9052 }],
    currentWindows: [],
  }), 9052);
});

test('clears a stale binding when the old process and CDP port are gone', () => {
  assert.equal(reconcileCdpProcessBinding({
    port: 39258,
    currentProcessId: 11660,
    processes: [],
    currentWindows: [],
  }), 0);
});

test('keeps a live binding during a transient CDP process scan failure', () => {
  assert.equal(reconcileCdpProcessBinding({
    port: 39258,
    currentProcessId: 9052,
    processes: [],
    currentWindows: [{ processId: 9052, visible: true }],
  }), 9052);
});
