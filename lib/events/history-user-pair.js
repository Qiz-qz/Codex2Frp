'use strict';

const path = require('node:path');
const {
  attachmentHasSource,
  privateAttachmentIdentity,
  privateAttachmentOrdinalIdentity,
} = require('./private-attachment-source');

function comparableText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function attachmentName(value) {
  const raw = typeof value === 'string'
    ? value
    : value && (value.name || value.filePath || value.path || value.url);
  return path.posix.basename(String(raw || '').trim().replace(/\\/g, '/')).toLowerCase();
}

function hasAttachmentLocation(value) {
  if (typeof value === 'string') return /[\\/]/.test(value) || /^[a-z]+:/i.test(value);
  return Boolean(value && (value.filePath || value.path || value.url));
}

function mergeAttachments(previous = [], incoming = []) {
  const result = [];
  const exactIndices = new Map();
  const ordinalIndices = new Map();
  function indexAttachment(attachment, ordinal, index) {
    const exactKey = privateAttachmentIdentity(attachment, ordinal);
    const ordinalKey = privateAttachmentOrdinalIdentity(attachment, ordinal);
    if (exactKey) exactIndices.set(exactKey, index);
    if (ordinalKey) ordinalIndices.set(ordinalKey, index);
  }
  for (const collection of [previous, incoming]) {
    for (const [ordinal, attachment] of collection.entries()) {
      const exactKey = privateAttachmentIdentity(attachment, ordinal) || attachmentName(attachment);
      const ordinalKey = privateAttachmentOrdinalIdentity(attachment, ordinal);
      let existingIndex = exactIndices.get(exactKey);
      if (existingIndex === undefined && ordinalIndices.has(ordinalKey)) {
        const candidateIndex = ordinalIndices.get(ordinalKey);
        if (!attachmentHasSource(attachment) || !attachmentHasSource(result[candidateIndex])) {
          existingIndex = candidateIndex;
        }
      }
      if (existingIndex === undefined) {
        const index = result.length;
        result.push(attachment);
        indexAttachment(attachment, ordinal, index);
      } else if (hasAttachmentLocation(attachment) && !hasAttachmentLocation(result[existingIndex])) {
        result[existingIndex] = attachment;
        indexAttachment(attachment, ordinal, existingIndex);
      }
      if (result.length >= 20) break;
    }
    if (result.length >= 20) break;
  }
  return result;
}

function canonicalRepresentation(value = {}) {
  return value.representation === 'response_item';
}

function mergeAdjacentUserHistoryMessage(previous, next, timestamp = '') {
  const incoming = { ...(next || {}), timestamp: timestamp || next && next.timestamp || '' };
  if (!previous || !next) return { duplicate: false, message: incoming };
  const complementary = Boolean(previous.representation && next.representation)
    && previous.representation !== next.representation;
  const sameText = comparableText(previous.text) === comparableText(next.text);
  const previousTime = Date.parse(previous.timestamp || '');
  const nextTime = Date.parse(incoming.timestamp || '');
  const closeInTime = !Number.isFinite(previousTime) || !Number.isFinite(nextTime)
    || Math.abs(previousTime - nextTime) <= 1500;
  if (!complementary || !sameText || !closeInTime) {
    return { duplicate: false, message: incoming };
  }
  const preferred = canonicalRepresentation(previous) && !canonicalRepresentation(incoming)
    ? previous
    : incoming;
  const supplement = preferred === incoming ? previous : incoming;
  return {
    duplicate: true,
    message: {
      ...supplement,
      ...preferred,
      text: String(preferred.text || supplement.text || ''),
      attachments: mergeAttachments(previous.attachments, incoming.attachments),
      timestamp: String(preferred.timestamp || supplement.timestamp || ''),
    },
  };
}

module.exports = {
  mergeAdjacentUserHistoryMessage,
  mergeUserHistoryAttachments: mergeAttachments,
};
