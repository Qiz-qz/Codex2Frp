'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS,
  confirmedModelOverride,
  confirmedReasoningOverride,
  mergeConfirmedControlOverrides,
  matchingOverridesForThread,
  preferConfirmedControlValue,
} = require('../lib/control/confirmed-control-override');
const { resolveNextTurnSettings } = require('../lib/windows/composer-next-turn-settings');

const NOW = Date.parse('2026-07-16T12:09:04.000Z');
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
    threadId: 'safe2', model: 'old-model', reasoning: 'low', speed: 'standard', updatedAt: 'old',
  }, {
    threadId: 'safe2', model: 'gpt-5.5', effort: 'high', speed: 'fast',
  }, updatedAt);
  assert.deepEqual(sameThread, {
    threadId: 'safe2', model: 'gpt-5.5', reasoning: 'high', speed: 'fast', updatedAt,
    modelUpdatedAt: updatedAt, reasoningUpdatedAt: updatedAt, speedUpdatedAt: updatedAt,
  });

  const otherThread = mergeConfirmedControlOverrides(sameThread, {
    threadId: 'safe3', model: 'gpt-5.4-mini',
  }, updatedAt);
  assert.deepEqual(otherThread, {
    threadId: 'safe3', model: 'gpt-5.4-mini', reasoning: '', speed: '', updatedAt,
    modelUpdatedAt: updatedAt, reasoningUpdatedAt: '', speedUpdatedAt: '',
  });
});

test('single-field confirmations renew only their own lease', () => {
  const modelAt = '2026-07-16T12:08:00.000Z';
  const effortAt = '2026-07-16T12:09:00.000Z';
  const modelOnly = mergeConfirmedControlOverrides({}, {
    threadId: 'safe2', model: 'gpt-5.6-sol',
  }, modelAt);
  const effortOnly = mergeConfirmedControlOverrides(modelOnly, {
    threadId: 'safe2', effort: 'ultra',
  }, effortAt);

  assert.equal(effortOnly.modelUpdatedAt, modelAt);
  assert.equal(effortOnly.reasoningUpdatedAt, effortAt);
  assert.equal(effortOnly.speedUpdatedAt, '');
  assert.equal(confirmedModelOverride(effortOnly, {
    now: NOW, parsedUpdatedAt: '2026-07-16T12:08:30.000Z',
  }), null, 'an effort mutation must not make the older model confirmation fresh again');
  assert.equal(confirmedReasoningOverride(effortOnly, {
    now: NOW,
    parsedUpdatedAt: '2026-07-16T12:08:30.000Z',
    fallbackOptions: [{ key: 'ultra', value: 'ultra', label: 'Ultra' }],
  }).key, 'ultra');
});

test('newer confirmed fields win over older authoritative observations but yield to newer authoritative observations', () => {
  const confirmed = { id: 'gpt-5.6-sol', source: 'confirmed-request', updatedAt: FRESH };
  const staleDom = { id: 'gpt-5.5', source: 'session-turn-context', updatedAt: '2026-07-16T12:08:00.000Z' };
  const freshDom = { ...staleDom, updatedAt: '2026-07-16T12:09:30.000Z' };

  assert.equal(preferConfirmedControlValue(confirmed, staleDom), confirmed);
  assert.equal(preferConfirmedControlValue(confirmed, freshDom), freshDom);
});

test('passive DOM sampling cannot supersede an unpropagated confirmation lease', () => {
  const confirmed = { id: 'gpt-5.6-sol', source: 'confirmed-request', updatedAt: FRESH };
  const oldDomSampledLater = {
    id: 'gpt-5.5', source: 'codex-desktop-composer-dom',
    updatedAt: '2026-07-16T12:09:00.050Z',
  };
  const convergedDom = { ...oldDomSampledLater, id: 'gpt-5.6-sol' };

  const provenance = {
    observedAt: oldDomSampledLater.updatedAt,
    observationSource: 'codex-desktop-composer-dom',
  };
  assert.equal(preferConfirmedControlValue(confirmed, oldDomSampledLater, provenance), confirmed);
  assert.equal(preferConfirmedControlValue(confirmed, convergedDom, provenance), convergedDom);
});

test('real composer DOM shape respects propagation lease, convergence, and bounded expiry', () => {
  const threadId = '11111111-2222-4333-8444-555555555555';
  const catalog = [
    { id: 'gpt-5.5', key: 'gpt-5.5', displayName: 'GPT-5.5', label: '5.5', source: 'catalog' },
    { id: 'gpt-5.6-sol', key: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', label: '5.6 Sol', source: 'catalog' },
  ];
  const sample = (modelText, effortText, speedSelected) => ({
    selectionEvidenceBefore: { route: `app://-/index.html#/threads/${threadId}` },
    selectionEvidenceAfter: { route: `app://-/index.html#/threads/${threadId}` },
    triggers: [{
      text: `${modelText} ${effortText}`,
      modelTexts: [modelText], effortTexts: [effortText],
      modelSelected: '', reasoningSelected: '', speedSelected,
    }],
  });
  const observation = (model, effort, speed, observedAt) => resolveNextTurnSettings(
    sample(model, effort, speed),
    { requestedThreadId: threadId, catalogOptions: catalog, observedAt },
  );
  const t0 = Date.parse(FRESH);
  const overrides = {
    threadId, model: 'gpt-5.6-sol', reasoning: 'high', speed: 'fast', updatedAt: FRESH,
    modelUpdatedAt: FRESH, reasoningUpdatedAt: FRESH, speedUpdatedAt: FRESH,
  };
  const oldDom = observation('5.5', '低', 'standard', '2026-07-16T12:09:00.050Z');
  const confirmedModel = confirmedModelOverride(overrides, { now: t0 + 50, catalogOptions: catalog });
  const confirmedReasoning = confirmedReasoningOverride(overrides, {
    now: t0 + 50, fallbackOptions: [{ key: 'high', value: 'high', label: '高' }],
  });
  const provenance = { observedAt: oldDom.observedAt, observationSource: oldDom.source };

  assert.equal(oldDom.source, 'codex-desktop-composer-dom');
  assert.equal(oldDom.model.source, 'catalog');
  assert.equal(oldDom.reasoningMode.source, undefined);
  assert.equal(preferConfirmedControlValue(confirmedModel, oldDom.model, provenance), confirmedModel);
  assert.equal(preferConfirmedControlValue(confirmedReasoning, oldDom.reasoningMode, provenance), confirmedReasoning);

  const converged = observation('5.6 Sol', '高', 'fast', '2026-07-16T12:09:00.100Z');
  assert.equal(preferConfirmedControlValue(confirmedModel, converged.model, {
    observedAt: converged.observedAt, observationSource: converged.source,
  }), converged.model);

  assert.equal(DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS, 15000);
  const protectedModel = confirmedModelOverride(overrides, {
    now: t0 + 14_999, catalogOptions: catalog,
  });
  assert.equal(preferConfirmedControlValue(protectedModel, oldDom.model, provenance), protectedModel);
  const expiredModel = confirmedModelOverride(overrides, {
    now: t0 + 15_001, catalogOptions: catalog,
  });
  assert.equal(expiredModel, null);
  assert.equal(preferConfirmedControlValue(expiredModel, oldDom.model, provenance), oldDom.model);
});

test('speed-only confirmation on another thread clears every field from the previous thread', () => {
  const previous = mergeConfirmedControlOverrides({}, {
    threadId: 'thread-a', model: 'gpt-5.6-sol', effort: 'ultra', speed: 'fast',
  }, FRESH);
  const next = mergeConfirmedControlOverrides(previous, {
    threadId: 'thread-b', speed: 'standard',
  }, '2026-07-16T12:09:30.000Z');

  assert.deepEqual(next, {
    threadId: 'thread-b', model: '', reasoning: '', speed: 'standard',
    updatedAt: '2026-07-16T12:09:30.000Z', modelUpdatedAt: '', reasoningUpdatedAt: '',
    speedUpdatedAt: '2026-07-16T12:09:30.000Z',
  });
});

test('confirmation TTL is inclusive and future timestamps fail closed', () => {
  const overrides = { model: 'gpt-5.6-sol', modelUpdatedAt: FRESH, updatedAt: FRESH };
  const freshMs = Date.parse(FRESH);
  assert.notEqual(confirmedModelOverride(overrides, { now: freshMs + DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS }), null);
  assert.equal(confirmedModelOverride(overrides, { now: freshMs + DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS + 1 }), null);
  assert.equal(confirmedModelOverride({
    model: 'gpt-5.6-sol', modelUpdatedAt: '2026-07-16T12:11:00.001Z',
  }, { now: NOW }), null);
});

test('confirmed overrides are exact-thread scoped and expire instead of becoming permanent readback', () => {
  const safe2 = { threadId: 'safe2', model: 'gpt-5.4-mini', reasoning: 'high', updatedAt: FRESH };
  assert.equal(matchingOverridesForThread(safe2, 'safe2'), safe2);
  assert.deepEqual(matchingOverridesForThread(safe2, 'other'), {});
  assert.equal(confirmedModelOverride(safe2, { now: NOW + 16 * 60 * 1000 }), null);
  assert.equal(confirmedModelOverride(safe2, { now: NOW, parsedUpdatedAt: '2026-07-16T12:09:30.000Z' }), null);
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
