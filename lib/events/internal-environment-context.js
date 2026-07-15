'use strict';

const STRUCTURAL_FIELD_PATTERN = /<(?:current_date|timezone|filesystem|workspace_roots|permission_profile|subagents)(?:\s[^<>]*)?>/;
const LEAF_PAIR_PATTERN = /<(cwd|shell|current_date|timezone|root|file_system|agent)(?:\s[^<>]*)?>[^<>]*<\/\1>/g;
const SELF_CLOSING_PATTERN = /<(?:cwd|shell|current_date|timezone|root|file_system|agent|filesystem|workspace_roots|permission_profile|subagents)(?:\s[^<>]*)?\/>/g;
const CONTAINER_TAG_PATTERN = /<\/?(?:filesystem|workspace_roots|permission_profile|subagents)(?:\s[^<>]*)?>/g;
const SUBAGENTS_CONTAINER_PATTERN = /<subagents(?:\s[^<>]*)?>([\s\S]*?)<\/subagents>/g;
const SUBAGENT_BULLET_PATTERN = /^[ \t]{0,8}- [A-Za-z0-9][A-Za-z0-9_.\/-]{0,63}: [A-Za-z0-9][A-Za-z0-9_.()\/ -]{0,63}$/;

function isStrictSubagentBulletList(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  const lines = value.replace(/\r\n/g, '\n').split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  return lines.length > 0 && lines.length <= 16
    && lines.every(line => line.length <= 160 && SUBAGENT_BULLET_PATTERN.test(line));
}

function isStrictInternalEnvironmentContext(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!/^<environment_context>\n[\s\S]*\n<\/environment_context>$/.test(text)) return false;
  const body = text.slice('<environment_context>\n'.length, -'\n</environment_context>'.length);
  if (!STRUCTURAL_FIELD_PATTERN.test(body)) return false;
  const remainder = body
    .replace(SUBAGENTS_CONTAINER_PATTERN, (match, content) =>
      isStrictSubagentBulletList(content) ? '' : match)
    .replace(LEAF_PAIR_PATTERN, '')
    .replace(SELF_CLOSING_PATTERN, '')
    .replace(CONTAINER_TAG_PATTERN, '');
  return remainder.trim().length === 0;
}

module.exports = { isStrictInternalEnvironmentContext };
