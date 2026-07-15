'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMenuItem, isExecutableMenuItem } = require('../lib/control/composer-menu-classifier');

test('stable composer attributes distinguish plugins, subagents, and built-in actions', () => {
  assert.equal(classifyMenuItem({ group: 'Subagents', action: 'spawnAgent', label: 'backend audit' }).kind, 'subagent');
  assert.equal(classifyMenuItem({ group: 'Plugins', pluginId: 'documents', label: 'Documents' }).kind, 'plugin');
  assert.equal(classifyMenuItem({ header: 'Add', actionIdentity: 'attachFile', ariaRole: 'menuitem' }).kind, 'filePicker');
  assert.equal(classifyMenuItem({ dataAttributes: { action: 'add-reference' }, label: 'Add context' }).kind, 'add');
  assert.equal(classifyMenuItem({ dataset: { kind: 'work-mode' }, label: 'Plan mode' }).kind, 'mode');
});

test('stable action identity outranks misleading row text', () => {
  assert.equal(classifyMenuItem({ action: 'spawnAgent', label: 'Install plugin helper' }).kind, 'subagent');
  assert.equal(classifyMenuItem({ pluginId: 'agent-tools', label: 'Subagent tools' }).kind, 'plugin');
});

test('text is only a last fallback and an unrecognized row fails closed', () => {
  assert.equal(classifyMenuItem({ label: 'Choose a file' }).kind, 'filePicker');
  const future = classifyMenuItem({ group: '', action: '', label: 'Future row' });
  assert.equal(future.kind, 'unknown');
  assert.equal(isExecutableMenuItem(future), false);
});

test('a generic Add header never makes an arbitrary future row executable', () => {
  const future = classifyMenuItem({ group: 'Add', label: 'Future row' });
  assert.deepEqual(future, { kind: 'unknown', executable: false });
});

test('audited multilingual plugin groups classify real plugin rows without trusting Add', () => {
  assert.deepEqual(classifyMenuItem({ group: '插件', label: 'Documents' }), { kind: 'plugin', executable: true });
  assert.deepEqual(classifyMenuItem({ header: 'Plugins', label: 'Documents' }), { kind: 'plugin', executable: true });
  assert.deepEqual(classifyMenuItem({ group: 'Add', label: 'Documents' }), { kind: 'unknown', executable: false });
  assert.equal(classifyMenuItem({ group: 'Subagents', label: 'Documents' }).kind, 'subagent');
});

test('aria and data metadata classify subagents without leaking opaque values', () => {
  const classified = classifyMenuItem({
    ariaRole: 'menuitem',
    ariaLabel: 'Start backend audit',
    dataAttributes: { itemType: 'subagent', agentPrompt: 'PRIVATE_PROMPT' },
    label: 'backend audit',
  });
  assert.deepEqual(classified, { kind: 'subagent', executable: true });
  assert.doesNotMatch(JSON.stringify(classified), /PRIVATE_PROMPT/);
});
