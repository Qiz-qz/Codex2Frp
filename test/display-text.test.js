'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAssistantDisplayText } = require('../lib/events/display-text');

test('removes supported standalone Codex UI directives from assistant display text', () => {
  const input = [
    '发布完成。',
    '::git-stage{cwd="E:\\\\repo"}',
    '::git-commit{cwd="E:\\\\repo"}',
    '::git-create-branch{cwd="E:\\\\repo" branch="codex/release"}',
    '::git-push{cwd="E:\\\\repo" branch="codex/release"}',
    '::git-create-pr{cwd="E:\\\\repo" branch="codex/release" url="https://example.test/pr/1" isDraft=false}',
    '::created-thread{threadId="thread-1"}',
    '::code-comment{title="Fix" body="Details" file="E:\\\\repo\\\\a.js" start=1 priority=2}',
    '正文结束。',
  ].join('\n');

  assert.equal(sanitizeAssistantDisplayText(input), '发布完成。\n正文结束。');
});

test('keeps directive-like prose, unsupported directives, and fenced examples verbatim', () => {
  const input = [
    '前缀 ::git-commit{cwd="E:\\\\repo"}',
    '::git-commit{cwd="E:\\\\repo"} 后缀',
    '::future-widget{value="keep"}',
    '```text',
    '::git-commit{cwd="E:\\\\repo"}',
    '```',
  ].join('\n');

  assert.equal(sanitizeAssistantDisplayText(input), input);
});
