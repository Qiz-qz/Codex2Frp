'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyThreadProject,
  displayPathName,
  isSubagentSessionMeta,
  normalizeThreadListLimit,
} = require('../lib/thread-utils');

test('detects Codex subagent session metadata', () => {
  assert.equal(isSubagentSessionMeta({
    thread_source: 'subagent',
    source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
  }), true);
  assert.equal(isSubagentSessionMeta({
    thread_source: 'user',
    source: 'vscode',
  }), false);
  assert.equal(isSubagentSessionMeta({
    source: { subagent: { thread_spawn: '@{parent_thread_id=abc; depth=1}' } },
  }), true);
});

test('classifies scratch dated Codex folders as conversation threads', () => {
  const homeDir = 'C:\\Users\\fixture-user';
  const project = classifyThreadProject('C:\\Users\\fixture-user\\Documents\\Codex\\2026-06-14\\scratch', { homeDir });
  assert.deepEqual(project, {
    isProjectThread: false,
    projectKey: 'conversation',
    projectName: '对话',
    projectPath: '',
  });
});

test('classifies real project folders with stable names', () => {
  const homeDir = 'C:\\Users\\fixture-user';
  const project = classifyThreadProject('E:\\SampleWorkspace\\projects\\mobile-bridge', { homeDir });
  assert.equal(project.isProjectThread, true);
  assert.equal(project.projectName, 'mobile-bridge');
  assert.equal(project.projectPath, 'E:\\SampleWorkspace\\projects\\mobile-bridge');
  assert.equal(displayPathName('E:\\SampleWorkspace\\projects\\mobile-bridge', { homeDir }), 'mobile-bridge');
});

test('normalizes thread list limits high enough to include older projects', () => {
  assert.equal(normalizeThreadListLimit(undefined), 500);
  assert.equal(normalizeThreadListLimit('120'), 120);
  assert.equal(normalizeThreadListLimit('2000'), 1000);
  assert.equal(normalizeThreadListLimit('all'), 1000);
});
