'use strict';

const os = require('node:os');
const path = require('node:path');

function displayPathName(cwd, options = {}) {
  if (!cwd) return '对话';
  const homeDir = options.homeDir || os.homedir();
  const normalized = path.normalize(cwd);
  if (normalized === homeDir) return '~';
  if (normalized === path.parse(normalized).root) return normalized;
  return path.basename(normalized) || normalized;
}

function classifyThreadProject(cwd, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const normalized = cwd ? path.normalize(cwd) : '';
  const codexScratchRoot = path.join(homeDir, 'Documents', 'Codex');
  const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : '';
  const isGeneratedProjectless = Boolean(
    normalized &&
    relativeToScratch &&
    !relativeToScratch.startsWith('..') &&
    !path.isAbsolute(relativeToScratch) &&
    /^\d{4}-\d{2}-\d{2}(?:$|[\\/])/.test(relativeToScratch)
  );

  if (!normalized || isGeneratedProjectless) {
    return {
      isProjectThread: false,
      projectKey: 'conversation',
      projectName: '对话',
      projectPath: '',
    };
  }

  return {
    isProjectThread: true,
    projectKey: normalized,
    projectName: displayPathName(normalized, { homeDir }),
    projectPath: normalized,
  };
}

function isSubagentSessionMeta(meta = {}) {
  const threadSource = String(meta && (meta.thread_source || meta.threadSource || '') || '').trim().toLowerCase();
  if (threadSource === 'subagent') return true;
  const source = meta && meta.source;
  return Boolean(source && typeof source === 'object' && source.subagent);
}

function normalizeThreadListLimit(value, fallback = 500) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'all') return 1000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, Math.round(parsed)));
}

module.exports = {
  classifyThreadProject,
  displayPathName,
  isSubagentSessionMeta,
  normalizeThreadListLimit,
};
