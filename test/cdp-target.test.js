'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectCodexCdpTarget } = require('../lib/windows/cdp-target');

function target(overrides = {}) {
  const id = overrides.id || 'target-1';
  return {
    id,
    type: 'page',
    title: 'Codex',
    url: 'app://-/index.html',
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
    ...overrides,
  };
}

test('selector accepts only page targets with a ws or wss debugger endpoint', () => {
  const valid = target({ id: 'valid' });
  const selected = selectCodexCdpTarget([
    target({ id: 'worker', type: 'service_worker' }),
    target({ id: 'missing-websocket', webSocketDebuggerUrl: '' }),
    target({ id: 'http-endpoint', webSocketDebuggerUrl: 'http://127.0.0.1:9222/page' }),
    valid,
  ]);

  assert.equal(selected, valid);
});

test('selector rejects devtools, about, extension, overlay, and quick-chat surfaces', () => {
  const rejected = [
    target({ id: 'devtools', url: 'devtools://devtools/bundled/inspector.html' }),
    target({ id: 'about', url: 'about:blank' }),
    target({ id: 'extension', url: 'chrome-extension://abcdefghijklmnop/popup.html' }),
    target({ id: 'moz-extension', url: 'moz-extension://abcdefghijklmnop/popup.html' }),
    target({ id: 'overlay', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }),
    target({ id: 'quick-chat', title: 'Codex Quick Chat', url: 'app://-/index.html?initialRoute=%2Fquick-chat' }),
  ];

  for (const candidate of rejected) {
    assert.equal(selectCodexCdpTarget([candidate]), null, candidate.id);
  }

  const valid = target({ id: 'main' });
  assert.equal(selectCodexCdpTarget([...rejected, valid]), valid);
});

test('explicit main hints disambiguate otherwise equivalent Codex pages', () => {
  const secondary = target({
    id: 'secondary',
    title: 'Codex',
    url: 'https://chatgpt.com/codex/tasks/secondary',
  });
  const explicitMain = target({
    id: 'explicit-main',
    title: 'Codex',
    url: 'https://chatgpt.com/codex/tasks/main',
    isMainWindow: true,
  });

  assert.equal(selectCodexCdpTarget([secondary, explicitMain]), explicitMain);
  assert.equal(selectCodexCdpTarget([secondary, explicitMain], {
    mainTargetIds: ['secondary'],
  }), secondary);
});

test('canonical main route outranks secondary Codex or ChatGPT identity matches', () => {
  const titleMatch = target({
    id: 'title-match',
    title: 'ChatGPT Codex',
    url: 'https://chatgpt.com/codex/tasks/1',
  });
  const canonicalMain = target({
    id: 'canonical-main',
    title: 'OpenAI',
    url: 'app://-/index.html',
  });

  assert.equal(selectCodexCdpTarget([titleMatch, canonicalMain]), canonicalMain);
});

test('Codex or ChatGPT title and URL identity beats unrelated valid pages', () => {
  const unrelated = target({
    id: 'settings',
    title: 'Settings',
    url: 'app://-/settings',
  });
  const identified = target({
    id: 'identified',
    title: 'ChatGPT',
    url: 'app://-/conversation/codex',
  });

  assert.equal(selectCodexCdpTarget([unrelated, identified]), identified);
});

test('selector returns null for tied best candidates instead of choosing an arbitrary page', () => {
  const first = target({
    id: 'first',
    title: 'Codex',
    url: 'https://chatgpt.com/codex/tasks/1',
  });
  const second = target({
    id: 'second',
    title: 'Codex',
    url: 'https://chatgpt.com/codex/tasks/2',
  });

  assert.equal(selectCodexCdpTarget([first, second]), null);
  assert.equal(selectCodexCdpTarget([
    target({ id: 'main-a', isMainWindow: true }),
    target({ id: 'main-b', isMainWindow: true }),
  ]), null);
});

test('selector never falls back to an arbitrary valid page without Codex identity or a main hint', () => {
  assert.equal(selectCodexCdpTarget([
    target({ id: 'settings', title: 'Settings', url: 'app://-/settings' }),
    target({ id: 'blank', title: '', url: 'https://example.test/' }),
  ]), null);
  assert.equal(selectCodexCdpTarget([]), null);
  assert.equal(selectCodexCdpTarget(null), null);
});
