'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROFILE_BY_CLI_VERSION = Object.freeze({
  '0.144.0-alpha.4': path.join(__dirname, 'profiles', 'v0144-profile.json'),
  '0.144.2': path.join(__dirname, 'profiles', 'v0144_2-profile.json'),
  '0.144.5': path.join(__dirname, 'profiles', 'v0144_2-profile.json'),
});

function safeStat(file) {
  try {
    const value = fs.statSync(file);
    return { isFile: value.isFile(), mtimeMs: value.mtimeMs };
  } catch {
    return null;
  }
}

function bundledCandidates(localAppData) {
  const root = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.win32.join(root, entry.name, 'codex.exe'));
  } catch {
    return [];
  }
}

function discoverCodexExecutable(options = {}) {
  const stat = typeof options.stat === 'function' ? options.stat : safeStat;
  const explicitPath = String(options.explicitPath || process.env.CODEX2FRP_CODEX_EXE || '').trim();
  if (explicitPath) {
    const explicitStat = stat(explicitPath);
    if (explicitStat && explicitStat.isFile === true) return explicitPath;
  }

  const localAppData = String(
    options.localAppData
      || process.env.LOCALAPPDATA
      || path.win32.join(os.homedir(), 'AppData', 'Local'),
  );
  const listCandidates = typeof options.listCandidates === 'function'
    ? options.listCandidates
    : bundledCandidates;
  const candidates = listCandidates(localAppData)
    .map(file => ({ file: String(file), stat: stat(String(file)) }))
    .filter(candidate => candidate.stat && candidate.stat.isFile === true)
    .sort((left, right) => {
      const timeDifference = Number(right.stat.mtimeMs || 0) - Number(left.stat.mtimeMs || 0);
      return timeDifference || left.file.localeCompare(right.file);
    });
  return candidates.length > 0 ? candidates[0].file : '';
}

function normalizeCodexCliVersion(value) {
  const match = String(value || '').trim().match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/i);
  return match ? match[1] : '';
}

function detectCodexCliVersion(executable, options = {}) {
  const command = String(executable || '').trim();
  if (!command) return '';
  const run = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  try {
    const result = run(command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000,
    });
    if (!result || result.status !== 0) return '';
    return normalizeCodexCliVersion(result.stdout);
  } catch {
    return '';
  }
}

function profileFileForCliVersion(value) {
  const version = normalizeCodexCliVersion(`codex ${String(value || '').trim()}`);
  return PROFILE_BY_CLI_VERSION[version] || '';
}

module.exports = {
  PROFILE_BY_CLI_VERSION,
  detectCodexCliVersion,
  discoverCodexExecutable,
  normalizeCodexCliVersion,
  profileFileForCliVersion,
};
