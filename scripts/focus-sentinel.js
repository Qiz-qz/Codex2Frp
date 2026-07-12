#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Win32FocusAdapter } = require('../lib/windows/win32-focus-adapter');
const { discoverCodexWindow } = require('../lib/windows/codex-window-discovery');

const SCHEMA_VERSION = 1;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 1000;
const SHOW_STATES = new Set(['normal', 'minimized', 'maximized', 'hidden', 'unknown']);

class FocusSentinelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FocusSentinelError';
    this.code = code;
  }
}

function argumentError() {
  return new FocusSentinelError(
    'FOCUS_SENTINEL_ARGUMENT_INVALID',
    'Focus sentinel arguments are invalid.',
  );
}

function parseArgs(argv = []) {
  let durationMs = DEFAULT_DURATION_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let outputFile = '';
  let requireMinimized = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || '');
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--require-minimized') {
      requireMinimized = true;
      continue;
    }
    if (!['--duration', '--interval', '--output'].includes(argument)) throw argumentError();
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) throw argumentError();
    index += 1;
    if (argument === '--output') {
      outputFile = String(value).trim();
      if (!outputFile) throw argumentError();
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw argumentError();
    if (argument === '--duration') durationMs = Math.round(number * 1000);
    if (argument === '--interval') intervalMs = Math.round(number);
    if (durationMs <= 0 || intervalMs <= 0) throw argumentError();
  }

  if (!help && !outputFile) throw argumentError();
  return { durationMs, intervalMs, outputFile, requireMinimized, help };
}

function safeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

function safePoint(value) {
  const point = value && typeof value === 'object' ? value : {};
  return { x: safeInteger(point.x), y: safeInteger(point.y) };
}

function safeRect(value) {
  const rect = value && typeof value === 'object' ? value : {};
  return {
    left: safeInteger(rect.left),
    top: safeInteger(rect.top),
    right: safeInteger(rect.right),
    bottom: safeInteger(rect.bottom),
  };
}

function safeHandle(value) {
  const handle = String(value == null ? '' : value).trim();
  return /^\d+$/.test(handle) && handle !== '0' ? handle : null;
}

function normalizePlacement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawState = String(value.showState || '').trim().toLowerCase();
  return {
    flags: safeInteger(value.flags),
    showCmd: safeInteger(value.showCmd),
    showState: SHOW_STATES.has(rawState) ? rawState : 'unknown',
    visible: value.visible === true,
    minimized: value.minimized === true,
    maximized: value.maximized === true,
    minPosition: safePoint(value.minPosition),
    maxPosition: safePoint(value.maxPosition),
    normalPosition: safeRect(value.normalPosition),
  };
}

function captureState(adapter, discover = discoverCodexWindow) {
  if (!adapter || typeof adapter.getForegroundWindow !== 'function'
    || typeof adapter.getWindowPlacement !== 'function') {
    throw new FocusSentinelError(
      'FOCUS_SENTINEL_ADAPTER_INVALID',
      'Focus sentinel adapter is invalid.',
    );
  }
  const foregroundWindow = safeHandle(adapter.getForegroundWindow());
  const discovered = discover(adapter);
  const codexWindow = safeHandle(discovered && discovered.handle);
  return {
    foregroundWindow,
    codexWindow,
    codexPlacement: codexWindow
      ? normalizePlacement(adapter.getWindowPlacement(codexWindow))
      : null,
  };
}

function stateChanges(previous, current) {
  const changes = [];
  if (previous.foregroundWindow !== current.foregroundWindow) changes.push('foreground');
  if (previous.codexWindow !== current.codexWindow) changes.push('codexWindow');
  if (JSON.stringify(previous.codexPlacement) !== JSON.stringify(current.codexPlacement)) {
    changes.push('placement');
  }
  return changes;
}

function minimized(placement) {
  return Boolean(placement && (
    placement.minimized === true
    || placement.showState === 'minimized'
  ));
}

function clockValue(clock) {
  const value = Number(clock.now());
  if (!Number.isFinite(value)) {
    throw new FocusSentinelError(
      'FOCUS_SENTINEL_CLOCK_INVALID',
      'Focus sentinel clock is invalid.',
    );
  }
  return value;
}

function isoTime(value) {
  return new Date(value).toISOString();
}

function baseSummary(config, startedAtMs) {
  return {
    type: 'summary',
    schemaVersion: SCHEMA_VERSION,
    startedAt: isoTime(startedAtMs),
    endedAt: isoTime(startedAtMs),
    requestedDurationMs: config.durationMs,
    observedDurationMs: 0,
    intervalMs: config.intervalMs,
    requireMinimized: config.requireMinimized,
    sampleCount: 0,
    changeCount: 0,
    foregroundChangeCount: 0,
    codexWindowChangeCount: 0,
    placementChangeCount: 0,
    missingCodexSampleCount: 0,
    minimizedViolationCount: 0,
    errorCount: 0,
    passed: true,
  };
}

async function runFocusSentinel(options = {}) {
  const durationMs = Number(options.durationMs || DEFAULT_DURATION_MS);
  const intervalMs = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(durationMs) || durationMs <= 0
    || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw argumentError();
  }
  const config = {
    durationMs: Math.round(durationMs),
    intervalMs: Math.round(intervalMs),
    requireMinimized: options.requireMinimized === true,
  };
  const adapter = options.adapter;
  const clock = options.clock || { now: () => Date.now() };
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const writeEvent = typeof options.writeEvent === 'function' ? options.writeEvent : () => {};
  const discover = typeof options.discover === 'function' ? options.discover : discoverCodexWindow;
  const startedAtMs = clockValue(clock);
  const deadline = startedAtMs + config.durationMs;
  const summary = baseSummary(config, startedAtMs);

  const emit = async event => { await writeEvent(event); };
  const finish = async reasonCode => {
    const endedAtMs = clockValue(clock);
    summary.endedAt = isoTime(endedAtMs);
    summary.observedDurationMs = Math.max(0, endedAtMs - startedAtMs);
    if (reasonCode) summary.reasonCode = reasonCode;
    summary.passed = !reasonCode
      && summary.changeCount === 0
      && summary.missingCodexSampleCount === 0
      && summary.minimizedViolationCount === 0
      && summary.errorCount === 0;
    await emit(summary);
    return { ...summary };
  };

  await emit({
    type: 'start',
    schemaVersion: SCHEMA_VERSION,
    startedAt: summary.startedAt,
    requestedDurationMs: config.durationMs,
    intervalMs: config.intervalMs,
    requireMinimized: config.requireMinimized,
  });

  let sequence = 0;
  let previous;
  try {
    previous = captureState(adapter, discover);
    summary.sampleCount += 1;
    if (!previous.codexWindow || !previous.codexPlacement) summary.missingCodexSampleCount += 1;
    await emit({
      type: 'sample',
      schemaVersion: SCHEMA_VERSION,
      sequence,
      at: isoTime(clockValue(clock)),
      state: previous,
    });
  } catch {
    summary.errorCount += 1;
    await emit({
      type: 'error',
      schemaVersion: SCHEMA_VERSION,
      sequence,
      at: isoTime(clockValue(clock)),
      code: 'FOCUS_SAMPLE_FAILED',
    });
    return finish('FOCUS_INITIAL_SAMPLE_FAILED');
  }

  if (!previous.codexWindow || !previous.codexPlacement) {
    return finish('CODEX_WINDOW_NOT_FOUND');
  }
  if (config.requireMinimized && !minimized(previous.codexPlacement)) {
    summary.minimizedViolationCount += 1;
    await emit({
      type: 'violation',
      schemaVersion: SCHEMA_VERSION,
      sequence,
      at: isoTime(clockValue(clock)),
      code: 'CODEX_WINDOW_NOT_MINIMIZED',
    });
    return finish('CODEX_WINDOW_NOT_MINIMIZED');
  }

  while (clockValue(clock) < deadline) {
    const beforeSleep = clockValue(clock);
    await sleep(Math.min(config.intervalMs, deadline - beforeSleep));
    const afterSleep = clockValue(clock);
    if (afterSleep <= beforeSleep) {
      throw new FocusSentinelError(
        'FOCUS_SENTINEL_CLOCK_STALLED',
        'Focus sentinel clock did not advance.',
      );
    }
    sequence += 1;
    summary.sampleCount += 1;
    let current;
    try {
      current = captureState(adapter, discover);
    } catch {
      summary.errorCount += 1;
      await emit({
        type: 'error',
        schemaVersion: SCHEMA_VERSION,
        sequence,
        at: isoTime(afterSleep),
        code: 'FOCUS_SAMPLE_FAILED',
      });
      continue;
    }

    if (!current.codexWindow || !current.codexPlacement) summary.missingCodexSampleCount += 1;
    if (config.requireMinimized && current.codexPlacement && !minimized(current.codexPlacement)) {
      summary.minimizedViolationCount += 1;
      await emit({
        type: 'violation',
        schemaVersion: SCHEMA_VERSION,
        sequence,
        at: isoTime(afterSleep),
        code: 'CODEX_WINDOW_NOT_MINIMIZED',
      });
    }

    const changes = stateChanges(previous, current);
    if (changes.length > 0) {
      summary.changeCount += 1;
      if (changes.includes('foreground')) summary.foregroundChangeCount += 1;
      if (changes.includes('codexWindow')) summary.codexWindowChangeCount += 1;
      if (changes.includes('placement')) summary.placementChangeCount += 1;
      await emit({
        type: 'change',
        schemaVersion: SCHEMA_VERSION,
        sequence,
        at: isoTime(afterSleep),
        changes,
        state: current,
      });
    }
    previous = current;
  }

  return finish();
}

function createJsonlSink(outputFile, options = {}) {
  const fileSystem = options.fs || fs;
  const normalized = String(outputFile || '').trim();
  if (!normalized) throw argumentError();
  const resolved = path.resolve(normalized);
  fileSystem.mkdirSync(path.dirname(resolved), { recursive: true });
  fileSystem.writeFileSync(resolved, '', 'utf8');
  return event => {
    fileSystem.appendFileSync(resolved, `${JSON.stringify(event)}\n`, 'utf8');
  };
}

function safeFailureCode(error) {
  const code = String(error && error.code || '');
  return /^FOCUS_[A-Z0-9_]+$/.test(code) ? code : 'FOCUS_SENTINEL_FAILED';
}

function usage() {
  return [
    'Usage: node scripts/focus-sentinel.js --output <jsonl> [options]',
    '  --duration <seconds>    Sampling duration (default: 3600)',
    '  --interval <ms>         Sampling interval (default: 1000)',
    '  --require-minimized     Fail unless Codex stays minimized',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = typeof dependencies.stdout === 'function'
    ? dependencies.stdout
    : value => process.stdout.write(`${value}\n`);
  try {
    const config = parseArgs(argv);
    if (config.help) {
      stdout(usage());
      return 0;
    }
    const writeEvent = dependencies.writeEvent || createJsonlSink(config.outputFile, {
      fs: dependencies.fs,
    });
    const adapter = dependencies.adapter || new Win32FocusAdapter();
    const summary = await runFocusSentinel({
      ...config,
      adapter,
      clock: dependencies.clock,
      sleep: dependencies.sleep,
      writeEvent,
      discover: dependencies.discover,
    });
    stdout(JSON.stringify(summary));
    return summary.passed ? 0 : 2;
  } catch (error) {
    stdout(JSON.stringify({
      type: 'error',
      schemaVersion: SCHEMA_VERSION,
      code: safeFailureCode(error),
    }));
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = {
  DEFAULT_DURATION_MS,
  DEFAULT_INTERVAL_MS,
  FocusSentinelError,
  captureState,
  createJsonlSink,
  main,
  normalizePlacement,
  parseArgs,
  runFocusSentinel,
};
