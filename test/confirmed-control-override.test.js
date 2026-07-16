'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  confirmedModelOverride,
  confirmedReasoningOverride,
  mergeConfirmedControlOverrides,
  matchingOverridesForThread,
} = require('../lib/control/confirmed-control-override');

const NOW = Date.parse('2026-07-16T12:10:00.000Z');
const FRESH = '2026-07-16T12:09:00.000Z';

test('confirmed model override resolves exact live ids and keys for mini and Spark', () => {
  const liveModeOptions = {
    modelOptions: [
      { id: 'gpt-5.4-mini', key: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', source: 'desktop-live' },
      { id: 'gpt-5.3-codex-spark', key: 'spark', label: 'Spark', source: 'desktop-live' },
    ],
  };
  const mini = confirmedModelOverride({ model: 'gpt-5.4-mini', updatedAt: FRESH }, { liveModeOptions, now: NOW });
  const spark = confirmedModelOverride({ model: 'spark', updatedAt: FRESH }, { liveModeOptions, now: NOW });
  assert.equal(mini.available, true);
  assert.equal(mini.id, 'gpt-5.4-mini');
  assert.equal(mini.source, 'confirmed-request');
  assert.equal(mini.confirmedBy, 'desktopInternalRpc');
  assert.equal(spark.id, 'gpt-5.3-codex-spark');
  assert.equal(spark.key, 'spark');
});

test('confirmed settings atomically merge all fields without leaking values across threads', () => {
  const updatedAt = '2026-07-16T12:09:00.000Z';
  const sameThread = mergeConfirmedControlOverrides({
    threadId: 'test-thread-a', model: 'old-model', reasoning: 'low', speed: 'standard', updatedAt: 'old',
  }, {
    threadId: 'test-thread-a', model: 'gpt-5.5', effort: 'high', speed: 'fast',
  }, updatedAt);
  assert.deepEqual(sameThread, {
    threadId: 'test-thread-a', model: 'gpt-5.5', reasoning: 'high', speed: 'fast', updatedAt,
  });

  const otherThread = mergeConfirmedControlOverrides(sameThread, {
    threadId: 'test-thread-b', model: 'gpt-5.4-mini',
  }, updatedAt);
  assert.deepEqual(otherThread, {
    threadId: 'test-thread-b', model: 'gpt-5.4-mini', reasoning: '', speed: '', updatedAt,
  });
});

test('confirmed overrides are exact-thread scoped and expire instead of becoming permanent readback', () => {
  const override = { threadId: 'test-thread-a', model: 'gpt-5.4-mini', reasoning: 'high', updatedAt: FRESH };
  assert.equal(matchingOverridesForThread(override, 'test-thread-a'), override);
  assert.deepEqual(matchingOverridesForThread(override, 'other'), {});
  assert.equal(confirmedModelOverride(override, { now: NOW + 16 * 60 * 1000 }), null);
  assert.equal(confirmedModelOverride(override, { now: NOW, parsedUpdatedAt: '2026-07-16T12:09:30.000Z' }), null);
});

test('confirmed reasoning resolves the exact live option with honest RPC provenance', () => {
  const result = confirmedReasoningOverride({ reasoning: 'high', updatedAt: FRESH }, {
    now: NOW,
    liveModeOptions: { reasoningOptions: [{ key: 'low', value: 'low', label: '低', source: 'desktop-live' }] },
    fallbackOptions: [{ key: 'high', value: 'high', label: '高' }],
  });
  assert.equal(result.available, true);
  assert.equal(result.key, 'high');
  assert.equal(result.source, 'confirmed-request');
  assert.equal(result.confirmedBy, 'desktopInternalRpc');
});

