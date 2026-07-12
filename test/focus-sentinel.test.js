'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  captureState,
  createJsonlSink,
  main,
  parseArgs,
  runFocusSentinel,
} = require('../scripts/focus-sentinel');

const START = Date.parse('2026-07-10T00:00:00.000Z');
const PRIVATE_CANARIES = Object.freeze([
  'TASK_CANARY_PRIVATE',
  'TOKEN_CANARY_PRIVATE',
  'C:\\Private\\session.jsonl',
]);

function placement(overrides = {}) {
  return {
    flags: 2,
    showCmd: 2,
    showState: 'minimized',
    visible: true,
    minimized: true,
    maximized: false,
    minPosition: { x: -32000, y: -32000 },
    maxPosition: { x: 0, y: 0 },
    normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 },
    task: PRIVATE_CANARIES[0],
    token: PRIVATE_CANARIES[1],
    path: PRIVATE_CANARIES[2],
    ...overrides,
  };
}

function harness(states, options = {}) {
  let now = START;
  const calls = [];
  const events = [];
  const stateAt = () => states[Math.min(
    Math.floor((now - START) / Number(options.stateEveryMs || 1000)),
    states.length - 1,
  )];
  const adapter = {
    listTopLevelWindows() {
      calls.push('listTopLevelWindows');
      const state = stateAt();
      if (state.error) throw state.error;
      if (state.missing) return [];
      return [{
        handle: state.codexWindow || '9001',
        ownerHandle: null,
        processId: 321,
        processName: 'C:\\Private\\ChatGPT.exe',
        title: PRIVATE_CANARIES[0],
        visible: true,
      }];
    },
    getForegroundWindow() {
      calls.push('getForegroundWindow');
      const state = stateAt();
      if (state.error) throw state.error;
      return state.foregroundWindow || '7001';
    },
    getWindowPlacement() {
      calls.push('getWindowPlacement');
      const state = stateAt();
      if (state.error) throw state.error;
      return state.placement || placement();
    },
    activateWindow() { throw new Error('read-only sentinel called activateWindow'); },
    setForegroundWindow() { throw new Error('read-only sentinel called setForegroundWindow'); },
    setWindowPlacement() { throw new Error('read-only sentinel called setWindowPlacement'); },
  };
  return {
    adapter,
    calls,
    events,
    clock: { now: () => now },
    sleep: async milliseconds => { now += milliseconds; },
    writeEvent: event => events.push(JSON.parse(JSON.stringify(event))),
  };
}

test('parseArgs exposes one-hour safe defaults and explicit reusable CLI controls', () => {
  assert.deepEqual(parseArgs(['--output', 'focus.jsonl']), {
    durationMs: 60 * 60 * 1000,
    intervalMs: 1000,
    outputFile: 'focus.jsonl',
    requireMinimized: false,
    help: false,
  });
  assert.deepEqual(parseArgs([
    '--duration', '5',
    '--interval', '250',
    '--output', 'audit.jsonl',
    '--require-minimized',
  ]), {
    durationMs: 5000,
    intervalMs: 250,
    outputFile: 'audit.jsonl',
    requireMinimized: true,
    help: false,
  });
});

test('parseArgs rejects missing output, invalid numbers, and unknown flags without echoing values', () => {
  for (const args of [
    [],
    ['--output', 'x', '--duration', '0'],
    ['--output', 'x', '--interval', '-1'],
    ['--output', 'x', '--private-canary'],
  ]) {
    assert.throws(() => parseArgs(args), error => {
      assert.equal(error.code, 'FOCUS_SENTINEL_ARGUMENT_INVALID');
      assert.equal(PRIVATE_CANARIES.some(canary => String(error.message).includes(canary)), false);
      return true;
    });
  }
});

test('captureState uses existing discovery while allowlisting handles and complete WINDOWPLACEMENT fields', () => {
  const state = captureState(harness([{}]).adapter);

  assert.deepEqual(state, {
    foregroundWindow: '7001',
    codexWindow: '9001',
    codexPlacement: {
      flags: 2,
      showCmd: 2,
      showState: 'minimized',
      visible: true,
      minimized: true,
      maximized: false,
      minPosition: { x: -32000, y: -32000 },
      maxPosition: { x: 0, y: 0 },
      normalPosition: { left: 100, top: 60, right: 1300, bottom: 860 },
    },
  });
  const serialized = JSON.stringify(state);
  for (const canary of PRIVATE_CANARIES) assert.equal(serialized.includes(canary), false);
});

test('stable sampling stays read-only and emits an initial state plus a passing summary', async () => {
  const h = harness([{}, {}, {}]);
  const summary = await runFocusSentinel({
    adapter: h.adapter,
    clock: h.clock,
    sleep: h.sleep,
    writeEvent: h.writeEvent,
    durationMs: 2000,
    intervalMs: 1000,
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.changeCount, 0);
  assert.deepEqual(h.events.map(event => event.type), ['start', 'sample', 'summary']);
  assert.equal(h.calls.filter(call => call === 'listTopLevelWindows').length, 3);
  assert.equal(h.calls.every(call => [
    'listTopLevelWindows',
    'getForegroundWindow',
    'getWindowPlacement',
  ].includes(call)), true);
});

test('foreground and full placement changes are recorded and fail the zero-focus summary', async () => {
  const h = harness([
    {},
    { foregroundWindow: '8001' },
    {
      foregroundWindow: '8001',
      placement: placement({
        flags: 0,
        showCmd: 1,
        showState: 'normal',
        minimized: false,
        normalPosition: { left: 0, top: 0, right: 800, bottom: 600 },
      }),
    },
  ]);
  const summary = await runFocusSentinel({
    adapter: h.adapter,
    clock: h.clock,
    sleep: h.sleep,
    writeEvent: h.writeEvent,
    durationMs: 2000,
    intervalMs: 1000,
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.changeCount, 2);
  assert.equal(summary.foregroundChangeCount, 1);
  assert.equal(summary.placementChangeCount, 1);
  assert.deepEqual(
    h.events.filter(event => event.type === 'change').map(event => event.changes),
    [['foreground'], ['placement']],
  );
});

test('require-minimized fails fast without changing a normal Codex window', async () => {
  const h = harness([{
    placement: placement({ showCmd: 1, showState: 'normal', minimized: false }),
  }]);
  let sleepCalls = 0;
  const summary = await runFocusSentinel({
    adapter: h.adapter,
    clock: h.clock,
    sleep: async milliseconds => {
      sleepCalls += 1;
      await h.sleep(milliseconds);
    },
    writeEvent: h.writeEvent,
    durationMs: 5000,
    intervalMs: 1000,
    requireMinimized: true,
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.reasonCode, 'CODEX_WINDOW_NOT_MINIMIZED');
  assert.equal(summary.sampleCount, 1);
  assert.equal(sleepCalls, 0);
  assert.equal(h.calls.includes('setWindowPlacement'), false);
});

test('a missing initial Codex window fails fast with a stable summary', async () => {
  const h = harness([{ missing: true }]);
  const summary = await runFocusSentinel({
    adapter: h.adapter,
    clock: h.clock,
    sleep: h.sleep,
    writeEvent: h.writeEvent,
    durationMs: 5000,
    intervalMs: 1000,
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.reasonCode, 'CODEX_WINDOW_NOT_FOUND');
  assert.equal(summary.sampleCount, 1);
});

test('sampling errors expose only a stable code and never leak messages or paths', async () => {
  const failure = Object.assign(new Error(PRIVATE_CANARIES.join(' ')), {
    code: 'PRIVATE_CODE_NOT_ALLOWED',
  });
  const h = harness([{}, { error: failure }, {}]);
  const summary = await runFocusSentinel({
    adapter: h.adapter,
    clock: h.clock,
    sleep: h.sleep,
    writeEvent: h.writeEvent,
    durationMs: 2000,
    intervalMs: 1000,
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.errorCount, 1);
  assert.equal(h.events.find(event => event.type === 'error').code, 'FOCUS_SAMPLE_FAILED');
  const serialized = JSON.stringify(h.events);
  for (const canary of PRIVATE_CANARIES) assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes('PRIVATE_CODE_NOT_ALLOWED'), false);
});

test('createJsonlSink persists event lines without embedding the output path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-focus-sentinel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputFile = path.join(root, 'private-output-name.jsonl');
  const sink = createJsonlSink(outputFile);

  sink({ type: 'start', schemaVersion: 1 });
  sink({ type: 'summary', passed: true });

  const lines = fs.readFileSync(outputFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(lines, [
    { type: 'start', schemaVersion: 1 },
    { type: 'summary', passed: true },
  ]);
  assert.equal(fs.readFileSync(outputFile, 'utf8').includes(outputFile), false);
});

test('main writes only the final summary to stdout and maps pass, violation, and config exit codes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex2frp-focus-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputFile = path.join(root, 'audit.jsonl');
  const passing = harness([{}, {}]);
  const stdout = [];
  const passCode = await main([
    '--duration', '1',
    '--interval', '1000',
    '--output', outputFile,
  ], {
    adapter: passing.adapter,
    clock: passing.clock,
    sleep: passing.sleep,
    stdout: value => stdout.push(value),
  });

  assert.equal(passCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).type, 'summary');
  assert.equal(stdout[0].includes(outputFile), false);

  const violation = harness([{
    placement: placement({ showCmd: 1, showState: 'normal', minimized: false }),
  }]);
  const violationCode = await main([
    '--duration', '1',
    '--interval', '1000',
    '--output', outputFile,
    '--require-minimized',
  ], {
    adapter: violation.adapter,
    clock: violation.clock,
    sleep: violation.sleep,
    stdout: () => {},
  });
  assert.equal(violationCode, 2);

  const errors = [];
  const configCode = await main(['--output'], { stdout: value => errors.push(value) });
  assert.equal(configCode, 1);
  assert.deepEqual(JSON.parse(errors[0]), {
    type: 'error',
    schemaVersion: 1,
    code: 'FOCUS_SENTINEL_ARGUMENT_INVALID',
  });
});
