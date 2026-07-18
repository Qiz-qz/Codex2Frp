'use strict';

const path = require('node:path');
const {
  attachmentHasSource,
  copyPrivateAttachmentSource,
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

const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
const MATERIALIZED_IMAGE_NAME_PATTERN = /^image-[a-z0-9_-]{6,}\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;

function attachmentDisplayName(value) {
  const raw = typeof value === 'string'
    ? value
    : value && (value.name || value.filePath || value.path || value.url);
  return path.posix.basename(String(raw || '').trim().replace(/\\/g, '/'));
}

function coalesceMaterializedImageSupplements(previous = [], incoming = []) {
  const paired = previous.slice();
  const wrapperImageIndexes = [];
  for (const [index, attachment] of previous.entries()) {
    const name = attachmentDisplayName(attachment);
    if (IMAGE_EXTENSION_PATTERN.test(name) && !MATERIALIZED_IMAGE_NAME_PATTERN.test(name)) {
      wrapperImageIndexes.push(index);
    }
  }
  const consumedIncoming = new Set();
  let wrapperOrdinal = 0;
  for (const [incomingIndex, attachment] of incoming.entries()) {
    const name = attachmentDisplayName(attachment);
    if (!attachment || typeof attachment !== 'object' || !MATERIALIZED_IMAGE_NAME_PATTERN.test(name)) continue;
    const wrapperIndex = wrapperImageIndexes[wrapperOrdinal];
    if (wrapperIndex === undefined) break;
    const displayName = attachmentDisplayName(previous[wrapperIndex]);
    paired[wrapperIndex] = copyPrivateAttachmentSource(attachment, { ...attachment, name: displayName });
    consumedIncoming.add(incomingIndex);
    wrapperOrdinal += 1;
  }
  return {
    previous: paired,
    incoming: incoming.filter((_attachment, index) => !consumedIncoming.has(index)),
  };
}

function mergeAttachments(previous = [], incoming = []) {
  const coalesced = coalesceMaterializedImageSupplements(previous, incoming);
  const result = [];
  const exactIndices = new Map();
  const ordinalIndices = new Map();
  function indexAttachment(attachment, ordinal, index) {
    const exactKey = privateAttachmentIdentity(attachment, ordinal);
    const ordinalKey = privateAttachmentOrdinalIdentity(attachment, ordinal);
    if (exactKey) exactIndices.set(exactKey, index);
    if (ordinalKey) ordinalIndices.set(ordinalKey, index);
  }
  for (const collection of [coalesced.previous, coalesced.incoming]) {
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

function mergePairedAttachments(preferred = [], supplement = []) {
  const result = [];
  const count = Math.max(preferred.length, supplement.length);
  for (let ordinal = 0; ordinal < count && result.length < 20; ordinal += 1) {
    const primary = preferred[ordinal];
    const secondary = supplement[ordinal];
    if (primary !== undefined && (attachmentHasSource(primary) || secondary === undefined)) {
      result.push(primary);
    } else if (secondary !== undefined) {
      result.push(secondary);
    } else if (primary !== undefined) {
      result.push(primary);
    }
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
      // The desktop emits the same user image twice: event_msg.images may be a
      // resized transport copy while response_item.input_image is canonical.
      // Pair complementary records by attachment ordinal so one visible image
      // never becomes two merely because their encoded bytes differ.
      attachments: mergePairedAttachments(preferred.attachments, supplement.attachments),
      timestamp: String(preferred.timestamp || supplement.timestamp || ''),
    },
  };
}

module.exports = {
  mergeAdjacentUserHistoryMessage,
  mergeUserHistoryAttachments: mergeAttachments,
};
