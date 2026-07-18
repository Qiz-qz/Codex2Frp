'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reasoningKey,
  resolveNextTurnSettings,
  uniqueCatalogModel,
} = require('../lib/windows/composer-next-turn-settings');

const THREAD_A = '11111111-2222-4333-8444-555555555555';
const THREAD_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OBSERVED_AT = '2026-07-15T03:00:00.000Z';
const CATALOG = [
  { id: 'gpt-5.6-sol', key: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', label: '5.6-Sol', source: 'catalog' },
  { id: 'gpt-5.6-pro', key: 'gpt-5.6-pro', displayName: 'GPT-5.6-Pro', label: '5.6-Pro', source: 'catalog' },
];

function exactSample(threadId = THREAD_A, trigger = {}) {
  return {
    selectionEvidenceBefore: { route: `app://-/index.html#/threads/${threadId}` },
    selectionEvidenceAfter: { route: `app://-/index.html#/threads/${threadId}` },
    triggers: [{
      text: 'Spark 高 5.6 Sol 极高',
      modelTexts: ['5.6 Sol'],
      effortTexts: ['极高'],
      modelSelected: '',
      reasoningSelected: 'xhigh',
      speedSelected: '',
      ...trigger,
    }],
  };
}

test('exact composer selection resolves one catalog model and xhigh reasoning for the requested desktop task', () => {
  const result = resolveNextTurnSettings(exactSample(), {
    requestedThreadId: THREAD_A,
    catalogOptions: CATALOG,
    observedAt: OBSERVED_AT,
  });

  assert.equal(result.available, true);
  assert.equal(result.source, 'codex-desktop-composer-dom');
  assert.equal(result.confidence, 'exact');
  assert.equal(result.exactThreadId, THREAD_A);
  assert.equal(result.observedAt, OBSERVED_AT);
  assert.equal(result.model.id, 'gpt-5.6-sol');
  assert.equal(result.reasoningMode.key, 'xhigh');
  assert.equal(result.reasoningMode.label, '极高');
});

test('composer settings fail closed for a different exact desktop task', () => {
  const result = resolveNextTurnSettings(exactSample(THREAD_B), {
    requestedThreadId: THREAD_A,
    catalogOptions: CATALOG,
    observedAt: OBSERVED_AT,
  });
  assert.equal(result.available, false);
  assert.equal(result.source, 'codex-desktop-composer-dom');
  assert.equal(result.confidence, 'unavailable');
  assert.equal(result.reason, 'THREAD_MISMATCH');
  assert.equal(result.observedAt, OBSERVED_AT);
});

test('composer settings require exactly one visible closed intelligence trigger', () => {
  const absent = resolveNextTurnSettings({
    selectionEvidenceBefore: exactSample().selectionEvidenceBefore,
    selectionEvidenceAfter: exactSample().selectionEvidenceAfter,
    triggers: [],
  }, { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(absent.available, false);
  assert.equal(absent.reason, 'TRIGGER_NOT_FOUND');

  const multiple = resolveNextTurnSettings({
    selectionEvidenceBefore: exactSample().selectionEvidenceBefore,
    selectionEvidenceAfter: exactSample().selectionEvidenceAfter,
    triggers: [exactSample().triggers[0], exactSample().triggers[0]],
  }, { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(multiple.available, false);
  assert.equal(multiple.reason, 'AMBIGUOUS_TRIGGER');
});

test('unknown or ambiguous desktop model text never falls back to config or a guessed catalog row', () => {
  const unknown = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: ['Future Model'], modelSelected: 'future-model',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, 'MODEL_TEXT_UNAVAILABLE');

  const ambiguous = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: ['5.6'], modelSelected: '',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(ambiguous.available, false);
  assert.equal(ambiguous.reason, 'MODEL_AMBIGUOUS');
});

test('one catalog candidate cannot turn stale partial model text into an exact selection', () => {
  assert.deepEqual(uniqueCatalogModel('5.6', [CATALOG[0]]), {
    option: null,
    reason: 'MODEL_TEXT_UNAVAILABLE',
  });
  assert.deepEqual(uniqueCatalogModel('gpt-5.6', [CATALOG[0]]), {
    option: null,
    reason: 'MODEL_TEXT_UNAVAILABLE',
  });
});

test('a reliable exact model attribute resolves without guessing from an unrecognized visible label', () => {
  const result = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: ['Current model'],
    modelSelected: 'gpt-5.6-sol',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });

  assert.equal(result.available, true);
  assert.equal(result.confidence, 'exact');
  assert.equal(result.model.id, 'gpt-5.6-sol');
  assert.equal(result.model.visibleLabel, 'Current model');
});

test('conflicting exact visible and attribute model identities fail closed', () => {
  const result = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: ['5.6 Pro'],
    modelSelected: 'gpt-5.6-sol',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'MODEL_CONFLICT');
});

test('reasoning selection recognizes installed Chinese 极高 and rejects missing selection', () => {
  const chinese = resolveNextTurnSettings(exactSample(THREAD_A, {
    reasoningSelected: '极高',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(chinese.reasoningMode.key, 'xhigh');

  const missing = resolveNextTurnSettings(exactSample(THREAD_A, {
    reasoningSelected: '', effortTexts: [],
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'REASONING_UNAVAILABLE');
});

test('reasoning selection recognizes current desktop Light labels', () => {
  assert.equal(reasoningKey('Light'), 'low');
  assert.equal(reasoningKey('轻度'), 'low');
});

test('current desktop speed attributes preserve fast capability in the exact composer sample', () => {
  const result = resolveNextTurnSettings(exactSample(THREAD_A, {
    speedSelected: 'priority',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });

  assert.equal(result.available, true);
  assert.equal(result.speed.key, 'fast');
  assert.equal(result.speed.serviceTier, 'priority');
});

test('hidden measurement candidates in trigger text cannot override the one visible model and effort label', () => {
  const result = resolveNextTurnSettings(exactSample(THREAD_A, {
    text: 'GPT-5.3-Codex-Spark 高 GPT-5.6-Sol 极高 GPT-5.6-Pro 中',
    modelTexts: ['5.6 Sol'],
    effortTexts: ['极高'],
    reasoningSelected: '',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });

  assert.equal(result.available, true);
  assert.equal(result.model.id, 'gpt-5.6-sol');
  assert.equal(result.reasoningMode.key, 'xhigh');
});

test('zero or multiple visible model labels fail closed even when the trigger contains recognizable hidden text', () => {
  const absent = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: [], text: 'GPT-5.6-Sol 极高',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(absent.available, false);
  assert.equal(absent.reason, 'MODEL_TEXT_UNAVAILABLE');

  const multiple = resolveNextTurnSettings(exactSample(THREAD_A, {
    modelTexts: ['5.6 Sol', '5.6 Pro'], text: 'GPT-5.6-Sol GPT-5.6-Pro',
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(multiple.available, false);
  assert.equal(multiple.reason, 'MODEL_AMBIGUOUS');
});

test('reasoning attribute and visible label must agree exactly', () => {
  const conflict = resolveNextTurnSettings(exactSample(THREAD_A, {
    reasoningSelected: 'high', effortTexts: ['极高'],
  }), { requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT });
  assert.equal(conflict.available, false);
  assert.equal(conflict.reason, 'REASONING_CONFLICT');
});

test('desktop selection changing during the composer sample fails closed', () => {
  const sample = exactSample();
  sample.selectionEvidenceAfter = exactSample(THREAD_B).selectionEvidenceAfter;
  const changed = resolveNextTurnSettings(sample, {
    requestedThreadId: THREAD_A, catalogOptions: CATALOG, observedAt: OBSERVED_AT,
  });
  assert.equal(changed.available, false);
  assert.equal(changed.reason, 'SELECTION_CHANGED');
});
