'use strict';

const path = require('node:path');
const FILES_HEADER = '# Files mentioned by the user:';
const REQUEST_HEADER = '## My request for Codex:';

function safeAttachmentName(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  const basename = path.posix.basename(normalized).replace(/[\r\n\0]/g, '').trim();
  return basename.slice(0, 180);
}

function parseAttachmentNames(block) {
  const names = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+?):\s+(.+)$/);
    if (!match) continue;
    const name = safeAttachmentName(match[1]);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 20) break;
  }
  return names;
}

function legacyPathNames(block) {
  const names = [];
  for (const match of String(block || '').matchAll(/(?:path=(["'])(.*?)\1|:\s*([^\r\n]+))/g)) {
    const name = safeAttachmentName(match[2] || match[3]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 20);
}

function parseUserMessageEnvelope(value) {
  const source = String(value || '').replace(/\r\n/g, '\n').trim();
  if (source !== FILES_HEADER && !source.startsWith(`${FILES_HEADER}\n`)) {
    const referenced = source.match(/(?:^|\n\n)Referenced image files:\n([\s\S]*)$/);
    if (referenced) {
      return { text: source.slice(0, referenced.index).trim(), attachmentNames: legacyPathNames(referenced[1]), recognized: true, malformed: false };
    }
    const image = source.match(/(?:^|\n\n)(<image\s[^>]*>[\s\S]*)$/);
    if (image) {
      const block = image[1];
      const attachmentNames = legacyPathNames(block);
      const complete = /^(?:<image\s[^>]*>\s*<\/image>\s*)+$/.test(block);
      return { text: complete ? source.slice(0, image.index).trim() : '', attachmentNames, recognized: true, malformed: !complete };
    }
    return { text: source, attachmentNames: [], recognized: false, malformed: false };
  }
  const marker = `\n${REQUEST_HEADER}`;
  const markerIndex = source.indexOf(marker);
  const fileBlock = markerIndex >= 0 ? source.slice(FILES_HEADER.length, markerIndex) : source.slice(FILES_HEADER.length);
  const attachmentNames = parseAttachmentNames(fileBlock);
  if (markerIndex < 0) return { text: '', attachmentNames, recognized: true, malformed: true };
  return {
    text: source.slice(markerIndex + marker.length).trim(),
    attachmentNames,
    recognized: true,
    malformed: false,
  };
}

module.exports = { parseUserMessageEnvelope, safeAttachmentName };
