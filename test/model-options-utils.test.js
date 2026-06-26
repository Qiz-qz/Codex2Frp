'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  modelInfoFromId,
  modelOptionFromMenuText,
  modelOptionsForClient,
  modelSupportsSpeed,
  normalizeModelOption,
} = require('../lib/model-options');

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
