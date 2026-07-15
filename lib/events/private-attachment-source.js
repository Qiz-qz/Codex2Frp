'use strict';

const crypto = require('node:crypto');

const sources = new WeakMap();

function setPrivateAttachmentSource(attachment, filePath) {
  if (!attachment || typeof attachment !== 'object') return attachment;
  const source = typeof filePath === 'string' ? filePath : '';
  if (source) sources.set(attachment, source);
  return attachment;
}

function getPrivateAttachmentSource(attachment) {
  if (!attachment || typeof attachment !== 'object') return '';
  return sources.get(attachment) || '';
}

function copyPrivateAttachmentSource(source, target) {
  return setPrivateAttachmentSource(target, getPrivateAttachmentSource(source));
}

function copyPrivateAttachmentSourcesDeep(source, target, visited = new WeakSet()) {
  if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return target;
  if (visited.has(source)) return target;
  visited.add(source);
  copyPrivateAttachmentSource(source, target);
  if (Array.isArray(source) && Array.isArray(target)) {
    for (let index = 0; index < Math.min(source.length, target.length); index += 1) {
      copyPrivateAttachmentSourcesDeep(source[index], target[index], visited);
    }
    return target;
  }
  for (const key of Object.keys(source)) {
    copyPrivateAttachmentSourcesDeep(source[key], target[key], visited);
  }
  return target;
}

function cloneWithPrivateAttachmentSources(value) {
  return copyPrivateAttachmentSourcesDeep(value, structuredClone(value));
}

function privateAttachmentSourceDigest(value) {
  const entries = [];
  const visited = new WeakSet();
  function visit(current, location) {
    if (!current || typeof current !== 'object' || visited.has(current)) return;
    visited.add(current);
    const source = getPrivateAttachmentSource(current);
    if (source) entries.push(`${location}\0${source}`);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    for (const key of Object.keys(current).sort()) visit(current[key], `${location}.${key}`);
  }
  visit(value, '$');
  return entries.length
    ? crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    : '';
}

function normalizedAttachmentSource(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function attachmentSourceValue(attachment) {
  const objectValue = attachment && typeof attachment === 'object' ? attachment : null;
  const explicitSource = objectValue
    ? getPrivateAttachmentSource(objectValue) || objectValue.filePath || objectValue.path || ''
    : '';
  const rawValue = typeof attachment === 'string' ? attachment : '';
  const locatedSource = explicitSource || (/[/\\]|^[a-z]+:/i.test(rawValue) ? rawValue : '');
  if (locatedSource) return normalizedAttachmentSource(locatedSource);
  return String(objectValue && (objectValue.url || objectValue.dataUrl || '') || '').trim();
}

function attachmentHasSource(attachment) {
  return Boolean(attachmentSourceValue(attachment));
}

function privateAttachmentOrdinalIdentity(attachment, ordinal = 0) {
  const objectValue = attachment && typeof attachment === 'object' ? attachment : null;
  const rawValue = objectValue ? objectValue.name : attachment;
  const normalized = normalizedAttachmentSource(rawValue);
  const name = normalized.split('/').pop() || '';
  return name ? `name:${name}:${Math.max(0, Number(ordinal) || 0)}` : '';
}

function privateAttachmentIdentity(attachment, ordinal = 0) {
  const source = attachmentSourceValue(attachment);
  if (source) return `source:${crypto.createHash('sha256').update(source).digest('hex')}`;
  return privateAttachmentOrdinalIdentity(attachment, ordinal);
}

module.exports = {
  cloneWithPrivateAttachmentSources,
  copyPrivateAttachmentSource,
  copyPrivateAttachmentSourcesDeep,
  getPrivateAttachmentSource,
  attachmentHasSource,
  privateAttachmentIdentity,
  privateAttachmentOrdinalIdentity,
  privateAttachmentSourceDigest,
  setPrivateAttachmentSource,
};
