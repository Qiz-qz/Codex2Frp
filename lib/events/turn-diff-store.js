'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeDisplayText } = require('./display-text');
const { safeDisplayDetail } = require('./display-detail');

const SCHEMA_VERSION = 1;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 512;
const MAX_THREADS = 100;
const MAX_TURNS_PER_THREAD = 128;
const THREAD_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

function decodeGitPath(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (!source.startsWith('"')) return source.includes('"') ? '' : source;
  if (!source.endsWith('"') || source.length < 2) return '';
  const bytes = [];
  const escapedBytes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "'": 39, '\\': 92, '?': 63 };
  for (let index = 1; index < source.length - 1;) {
    const character = source[index];
    if (character === '"') return '';
    if (character !== '\\') {
      const codePoint = source.codePointAt(index);
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(literal, 'utf8'));
      index += literal.length;
      continue;
    }
    index += 1;
    if (index >= source.length - 1) return '';
    const escaped = source[index];
    if (/[0-7]/.test(escaped)) {
      let octal = '';
      while (index < source.length - 1 && octal.length < 3 && /[0-7]/.test(source[index])) {
        octal += source[index];
        index += 1;
      }
      const byte = Number.parseInt(octal, 8);
      if (!Number.isInteger(byte) || byte > 255) return '';
      bytes.push(byte);
      continue;
    }
    if (!Object.hasOwn(escapedBytes, escaped)) return '';
    bytes.push(escapedBytes[escaped]);
    index += 1;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return ''; }
}

function safeRepositoryLabel(value) {
  let source = decodeGitPath(value).replace(/\\/g, '/');
  if (source === '/dev/null') return '';
  if (source.startsWith('a/') || source.startsWith('b/')) source = source.slice(2);
  if (!source || /[\u0000-\u001f\u007f-\u009f]/u.test(source) || source.startsWith('/') || /^[A-Za-z]:\//.test(source)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) || source.split('/').includes('..')) return '';
  const label = sanitizeDisplayText(source).trim().slice(0, 512);
  if (!label || safeDisplayDetail(label) === '<redacted command>') return '';
  return label;
}

function parseDiffHeaderPaths(value) {
  const source = String(value || '');
  const candidates = [];
  const append = (previousValue, currentValue) => {
    const previousPath = decodeGitPath(previousValue);
    const currentPath = decodeGitPath(currentValue);
    if (!previousPath.startsWith('a/') || !currentPath.startsWith('b/')) return;
    const previous = safeRepositoryLabel(previousPath);
    const current = safeRepositoryLabel(currentPath);
    if (!previous || !current || candidates.some(item => item.previous === previous && item.current === current)) return;
    candidates.push({ previous, current });
  };
  if (source.startsWith('"')) {
    let offset = 1;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') break;
    }
    if (source[offset - 1] !== '"') return [];
    const separatorStart = offset;
    while (offset < source.length && /\s/.test(source[offset])) offset += 1;
    if (separatorStart === offset || source[offset] !== '"') return [];
    const currentStart = offset;
    offset += 1;
    escaped = false;
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') break;
    }
    if (source[offset - 1] !== '"' || source.slice(offset).trim()) return [];
    append(source.slice(0, separatorStart), source.slice(currentStart, offset));
    return candidates;
  }
  if (!source.startsWith('a/')) return [];
  for (let offset = 0; offset < source.length - 2; offset += 1) {
    if (!/\s/.test(source[offset]) || source.slice(offset + 1, offset + 3) !== 'b/') continue;
    append(source.slice(0, offset), source.slice(offset + 1));
  }
  return candidates;
}

function lineStats(lines) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of lines) {
    if (/^@@(?:\s|$)/.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function parseTurnDiff(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DIFF_BYTES) return null;
  if (value.length === 0) return { schemaVersion: SCHEMA_VERSION, fileCount: 0, additions: 0, deletions: 0, files: [] };
  const sections = value.replace(/\r\n/g, '\n').split(/^diff --git /m).slice(1);
  if (sections.length === 0 || sections.length > MAX_FILES) return null;
  const files = [];
  for (const [index, section] of sections.entries()) {
    const lines = section.split('\n');
    let headerCandidates = parseDiffHeaderPaths(lines[0]);
    if (headerCandidates.length === 0) return null;
    const added = lines.some(line => line.startsWith('new file mode '));
    const deleted = lines.some(line => line.startsWith('deleted file mode '));
    const renameFromLine = lines.find(line => line.startsWith('rename from '));
    const renameToLine = lines.find(line => line.startsWith('rename to '));
    if (Boolean(renameFromLine) !== Boolean(renameToLine)) return null;
    const renamed = Boolean(renameFromLine && renameToLine);
    if ((added && deleted) || (renamed && (added || deleted))) return null;
    let renameFrom = '';
    let renameTo = '';
    if (renamed) {
      renameFrom = safeRepositoryLabel(renameFromLine.slice('rename from '.length));
      renameTo = safeRepositoryLabel(renameToLine.slice('rename to '.length));
      if (!renameFrom || !renameTo) return null;
      headerCandidates = headerCandidates.filter(item => item.previous === renameFrom && item.current === renameTo);
    } else {
      headerCandidates = headerCandidates.filter(item => item.previous === item.current);
    }
    const pathLine = deleted
      ? lines.find(line => line.startsWith('--- ') && line.slice(4).trim() !== '/dev/null')
      : lines.find(line => line.startsWith('+++ ') && line.slice(4).trim() !== '/dev/null');
    const pathLabel = pathLine ? safeRepositoryLabel(pathLine.slice(4)) : '';
    if (pathLine && !pathLabel) return null;
    if (pathLabel) headerCandidates = headerCandidates.filter(item => pathLabel === (deleted ? item.previous : item.current));
    if (headerCandidates.length !== 1) return null;
    const headerPaths = headerCandidates[0];
    const fallbackLabel = deleted ? headerPaths.previous : headerPaths.current;
    const fileLabel = pathLabel || fallbackLabel;
    if (!fileLabel) return null;
    if (fileLabel !== fallbackLabel) return null;
    const changeKind = added ? 'added' : deleted ? 'deleted' : renamed ? 'renamed' : 'modified';
    const operation = added ? 'create' : deleted ? 'delete' : renamed ? 'rename' : 'edit';
    const { additions, deletions } = lineStats(lines);
    files.push({
      id: `file-${index + 1}`,
      fileLabel,
      changeKind,
      operation,
      additions,
      deletions,
      displayDetail: `+${additions} -${deletions}`,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
}

function validSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(value.files) || value.files.length > MAX_FILES
    || value.fileCount !== value.files.length) return null;
  const files = [];
  for (const [index, file] of value.files.entries()) {
    const fileLabel = safeRepositoryLabel(file && file.fileLabel);
    const changeKind = String(file && file.changeKind || '');
    const operation = String(file && file.operation || '');
    const additions = Number(file && file.additions);
    const deletions = Number(file && file.deletions);
    if (!fileLabel || !['added', 'deleted', 'modified', 'renamed'].includes(changeKind)
      || !['create', 'delete', 'edit', 'rename'].includes(operation)
      || !Number.isSafeInteger(additions) || additions < 0
      || !Number.isSafeInteger(deletions) || deletions < 0) return null;
    files.push({ id: `file-${index + 1}`, fileLabel, changeKind, operation, additions, deletions,
      displayDetail: `+${additions} -${deletions}` });
  }
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
  if (snapshot.additions !== value.additions || snapshot.deletions !== value.deletions) return null;
  return snapshot;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

class TurnDiffStore {
  constructor(options = {}) {
    const configured = String(options.file || '').trim();
    if (!configured) throw new TypeError('TurnDiffStore requires file.');
    this.file = path.resolve(configured);
  }

  readState() {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { schemaVersion: SCHEMA_VERSION, rows: [] }; }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.rows)) {
      return { schemaVersion: SCHEMA_VERSION, rows: [] };
    }
    const rows = [];
    for (const row of parsed.rows) {
      const threadId = String(row && row.threadId || '');
      const turnId = String(row && row.turnId || '');
      const turnDiff = validSnapshot(row && row.turnDiff);
      if (!THREAD_ID_PATTERN.test(threadId) || !TURN_ID_PATTERN.test(turnId) || !turnDiff) continue;
      rows.push({ threadId, turnId, updatedAt: String(row.updatedAt || ''), turnDiff });
    }
    return { schemaVersion: SCHEMA_VERSION, rows };
  }

  save(threadIdValue, turnIdValue, snapshotValue) {
    const threadId = String(threadIdValue || '').trim();
    const turnId = String(turnIdValue || '').trim();
    const turnDiff = validSnapshot(snapshotValue);
    if (!THREAD_ID_PATTERN.test(threadId) || !TURN_ID_PATTERN.test(turnId) || !turnDiff) {
      throw new TypeError('A valid authoritative turn diff is required.');
    }
    const state = this.readState();
    let rows = state.rows.filter(row => !(row.threadId === threadId && row.turnId === turnId));
    rows.push({ threadId, turnId, updatedAt: new Date().toISOString(), turnDiff });
    const threadOrder = [...new Set(rows.slice().reverse().map(row => row.threadId))].slice(0, MAX_THREADS);
    const allowedThreads = new Set(threadOrder);
    const perThread = new Map();
    rows = rows.slice().reverse().filter(row => {
      if (!allowedThreads.has(row.threadId)) return false;
      const count = perThread.get(row.threadId) || 0;
      if (count >= MAX_TURNS_PER_THREAD) return false;
      perThread.set(row.threadId, count + 1);
      return true;
    }).reverse();
    atomicWrite(this.file, { schemaVersion: SCHEMA_VERSION, rows });
    return turnDiff;
  }

  get(threadId, turnId) {
    const row = this.readState().rows.find(candidate => candidate.threadId === threadId && candidate.turnId === turnId);
    return row ? row.turnDiff : null;
  }

  entriesForThread(threadIdValue) {
    const threadId = String(threadIdValue || '').trim();
    return this.readState().rows.filter(row => row.threadId === threadId).map((row, index) => ({
      nextOffset: Number.MAX_SAFE_INTEGER - MAX_TURNS_PER_THREAD + index,
      item: {
        type: 'response_item',
        timestamp: row.updatedAt,
        _eventSourceKey: `turn-diff:${row.turnId}`,
        payload: {
          type: 'turnDiff',
          id: `turn-diff:${row.turnId}`,
          lifecycle_state: 'succeeded',
          turnDiff: row.turnDiff,
          internal_chat_message_metadata_passthrough: { turn_id: row.turnId },
        },
      },
    }));
  }
}

module.exports = { TurnDiffStore, parseTurnDiff, sanitizeTurnDiff: validSnapshot };
