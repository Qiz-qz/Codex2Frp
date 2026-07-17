'use strict';

const path = require('node:path');
const {
  copyPrivateAttachmentSource,
  getPrivateAttachmentSource,
  setPrivateAttachmentSource,
} = require('./private-attachment-source');
const FILES_HEADER = '# Files mentioned by the user:';
const REQUEST_HEADER = '## My request for Codex:';
const privateEnvelopeAttachments = new WeakMap();

function safeAttachmentName(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  const basename = path.posix.basename(normalized).replace(/[\r\n\0]/g, '').trim();
  return basename.slice(0, 180);
}

function attachmentRecord(nameValue, sourceValue) {
  const name = safeAttachmentName(nameValue);
  if (!name) return null;
  return setPrivateAttachmentSource({ name }, String(sourceValue || '').trim());
}

function parseAttachmentRecords(block) {
  const records = [];
  const seenSources = new Set();
  for (const line of String(block || '').split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+?):\s+(.+)$/);
    if (!match) continue;
    const record = attachmentRecord(match[1], match[2]);
    const source = getPrivateAttachmentSource(record).replace(/\\/g, '/').toLowerCase();
    const key = `${record && record.name || ''}\0${source}`;
    if (!record || seenSources.has(key)) continue;
    seenSources.add(key);
    records.push(record);
    if (records.length >= 20) break;
  }
  return records;
}

function legacyPathRecords(block) {
  const records = [];
  const seenSources = new Set();
  for (const match of String(block || '').matchAll(/(?:path=(["'])(.*?)\1|:\s*([^\r\n]+))/g)) {
    const source = String(match[2] || match[3] || '').trim();
    const record = attachmentRecord(source, source);
    const key = source.replace(/\\/g, '/').toLowerCase();
    if (!record || seenSources.has(key)) continue;
    seenSources.add(key);
    records.push(record);
  }
  return records.slice(0, 20);
}

function withPrivateAttachments(result, records) {
  if (records.length) privateEnvelopeAttachments.set(result, records);
  return result;
}

function getPrivateEnvelopeAttachments(result) {
  return (privateEnvelopeAttachments.get(result) || []).map(record => (
    copyPrivateAttachmentSource(record, { name: record.name })
  ));
}

function parseUserMessageEnvelopeOnce(value) {
  const source = String(value || '').replace(/\r\n/g, '\n').trim();
  if (source !== FILES_HEADER && !source.startsWith(`${FILES_HEADER}\n`)) {
    const referenced = source.match(/(?:^|\n\n)Referenced image files:\n([\s\S]*)$/);
    if (referenced) {
      const records = legacyPathRecords(referenced[1]);
      return withPrivateAttachments({ text: source.slice(0, referenced.index).trim(), attachmentNames: records.map(item => item.name), recognized: true, malformed: false }, records);
    }
    // ChatGPT indents conversation-owned image blocks in some persisted
    // response_item records.  Treat those trailing blocks exactly like the
    // unindented desktop representation so the response_item and event_msg
    // copies coalesce into one visible user row.  Requiring a line boundary,
    // a complete closing tag, and end-of-input keeps ordinary prose intact.
    const image = source.match(/(?:^|\n)([ \t]*<image\s[^>]*>[\s\S]*)$/);
    if (image) {
      const block = image[1];
      const records = legacyPathRecords(block);
      const complete = /^(?:[ \t]*<image\s[^>]*>\s*<\/image>\s*)+$/.test(block);
      return withPrivateAttachments({ text: complete ? source.slice(0, image.index).trim() : '', attachmentNames: records.map(item => item.name), recognized: true, malformed: !complete }, records);
    }
    return { text: source, attachmentNames: [], recognized: false, malformed: false };
  }
  const marker = `\n${REQUEST_HEADER}`;
  const markerIndex = source.indexOf(marker);
  const fileBlock = markerIndex >= 0 ? source.slice(FILES_HEADER.length, markerIndex) : source.slice(FILES_HEADER.length);
  const records = parseAttachmentRecords(fileBlock);
  const attachmentNames = records.map(item => item.name);
  if (markerIndex < 0) return withPrivateAttachments({ text: '', attachmentNames, recognized: true, malformed: true }, records);
  return withPrivateAttachments({
    text: source.slice(markerIndex + marker.length).trim(),
    attachmentNames,
    recognized: true,
    malformed: false,
  }, records);
}

function mergeEnvelopeRecords(first = [], second = []) {
  const result = [];
  const seen = new Set();
  for (const record of [...first, ...second]) {
    const source = getPrivateAttachmentSource(record).replace(/\\/g, '/').toLowerCase();
    const key = `${record && record.name || ''}\0${source}`;
    if (!record || seen.has(key)) continue;
    seen.add(key);
    result.push(record);
    if (result.length >= 20) break;
  }
  return result;
}

function parseUserMessageEnvelope(value) {
  let current = String(value || '').replace(/\r\n/g, '\n').trim();
  let recognized = false;
  let malformed = false;
  let records = [];
  // A conversation response_item can itself be wrapped by the desktop's
  // "Files mentioned" envelope. Unwrap each complete layer so its companion
  // event_msg receives the same identity; keep the depth bounded and retain
  // every safe attachment record across layers.
  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = parseUserMessageEnvelopeOnce(current);
    records = mergeEnvelopeRecords(records, getPrivateEnvelopeAttachments(parsed));
    if (!parsed.recognized) break;
    recognized = true;
    malformed = malformed || parsed.malformed === true;
    const next = String(parsed.text || '').trim();
    if (parsed.malformed || next === current) {
      current = next;
      break;
    }
    current = next;
  }
  return withPrivateAttachments({
    text: malformed ? '' : current,
    attachmentNames: records.map(item => item.name),
    recognized,
    malformed,
  }, records);
}

module.exports = { getPrivateEnvelopeAttachments, parseUserMessageEnvelope, safeAttachmentName };
