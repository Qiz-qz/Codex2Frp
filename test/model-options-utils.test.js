'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalModelId,
  canonicalizeThreadSettings,
  modelInfoFromId,
  modelOptionFromMenuText,
  modelOptionsForClient,
  reasoningOptionsForModel,
  modelSupportsSpeed,
  normalizeModelOption,
} = require('../lib/model-options');

test('desktop display labels canonicalize to catalog ids before settings RPC', () => {
  const catalog = [
    normalizeModelOption({ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' }),
    normalizeModelOption({ slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini' }),
  ];

  assert.equal(canonicalModelId('GPT-5.6-Sol', catalog), 'gpt-5.6-sol');
  assert.equal(canonicalModelId('5.4-Mini', catalog), 'gpt-5.4-mini');
  assert.deepEqual(canonicalizeThreadSettings({
    threadId: 'thread-a', model: 'GPT-5.6-Sol', effort: 'ultra',
  }, catalog), {
    threadId: 'thread-a', model: 'gpt-5.6-sol', effort: 'ultra',
  });
});

test('ambiguous display aliases fail closed while exact and forward canonical ids remain usable', () => {
  const catalog = [
    normalizeModelOption({ slug: 'gpt-5.6-sol', display_name: 'Shared Model' }),
    normalizeModelOption({ slug: 'gpt-5.6-team', display_name: 'Shared Model' }),
  ];

  assert.equal(canonicalModelId('gpt-5.6-sol', catalog), 'gpt-5.6-sol');
  assert.equal(canonicalModelId('gpt-6.0-forward-preview', catalog), 'gpt-6.0-forward-preview');
  assert.equal(canonicalModelId('o3', catalog), 'o3');
  assert.equal(canonicalModelId('shared', catalog), '');
  assert.equal(canonicalModelId('Shared Model', catalog), '');
  assert.throws(
    () => canonicalizeThreadSettings({ threadId: 'thread-a', model: 'Shared Model' }, catalog),
    error => error && error.code === 'MODEL_ID_AMBIGUOUS',
  );
});

test('models_cache reasoning metadata preserves default, max, and ultra exactly', () => {
  const option = normalizeModelOption({
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    default_reasoning_level: 'max',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast' },
      { effort: 'max', description: 'Maximum' },
      { effort: 'ultra', description: 'Delegated maximum' },
    ],
  });

  assert.equal(option.defaultReasoningEffort, 'max');
  assert.deepEqual(option.supportedReasoningEfforts, ['low', 'max', 'ultra']);
});

test('max and ultra are published only from authoritative model metadata', () => {
  const ordinary = normalizeModelOption({ slug: 'gpt-5.5', display_name: 'GPT-5.5' });
  const extended = normalizeModelOption({
    slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol',
    supported_reasoning_levels: ['low', 'medium', 'max', 'ultra'],
  });

  assert.deepEqual(reasoningOptionsForModel(ordinary).map(item => item.key), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reasoningOptionsForModel(extended).map(item => item.key), ['low', 'medium', 'max', 'ultra']);
});

test('current model metadata filters a global live reasoning cache', () => {
  const model = normalizeModelOption({
    slug: 'gpt-5.5', display_name: 'GPT-5.5',
    supported_reasoning_levels: ['low', 'medium'],
  });
  const globalLive = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map(key => ({ key, value: key, label: key, source: 'desktop-live' }));

  const options = reasoningOptionsForModel(model, {}, globalLive);
  assert.deepEqual(options.map(item => item.key), ['low', 'medium']);
  assert.ok(options.every(item => item.source === 'desktop-live'));
});

test('menu model text keeps suffix variants distinct from their base model', () => {
  const catalog = [
    normalizeModelOption({ slug: 'gpt-5.4', display_name: 'GPT-5.4' }),
    normalizeModelOption({ slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini' }),
  ];

  const match = modelOptionFromMenuText('GPT-5.4 Mini', catalog);

  assert.equal(match.id, 'gpt-5.4-mini');
  assert.equal(match.displayName, 'GPT-5.4-Mini');
});

test('client model options merge live menu entries with the Codex catalog', () => {
  const live = {
    modelOptions: [
      normalizeModelOption({ slug: 'gpt-5.5', display_name: 'GPT-5.5' }, 'live-menu'),
      normalizeModelOption({ slug: 'gpt-5.4', display_name: 'GPT-5.4' }, 'live-menu'),
    ],
  };
  const catalog = [
    normalizeModelOption({ slug: 'gpt-5.5', display_name: 'GPT-5.5' }),
    normalizeModelOption({ slug: 'gpt-5.4', display_name: 'GPT-5.4' }),
    normalizeModelOption({ slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini' }),
  ];

  const options = modelOptionsForClient(live, catalog);

  assert.deepEqual(options.map(option => option.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
});

test('model info is generated from arbitrary Codex model ids without fixed branches', () => {
  const info = modelInfoFromId('gpt-6.1-research-preview', [], '2026-06-20T00:00:00.000Z');

  assert.equal(info.available, true);
  assert.equal(info.id, 'gpt-6.1-research-preview');
  assert.equal(info.displayName, 'GPT-6.1-Research-Preview');
  assert.equal(info.label, '6.1-Research-Preview');
});

test('speed support is read from model catalog metadata', () => {
  const catalog = [
    normalizeModelOption({
      slug: 'gpt-6.1-fast',
      display_name: 'GPT-6.1-Fast',
      service_tiers: [{ id: 'priority' }],
    }),
  ];

  assert.equal(modelSupportsSpeed('gpt-6.1-fast', catalog), true);
  assert.equal(modelSupportsSpeed('gpt-6.1-mini', catalog), false);
});
