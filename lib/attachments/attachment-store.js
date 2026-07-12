'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{64}$/;

class AttachmentStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AttachmentStoreError';
    this.code = code;
    this.statusCode = code.includes('LIMIT') ? 413 : (code.endsWith('NOT_FOUND') ? 404 : 400);
    this.details = { ...details };
  }
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function sanitizeName(value) {
  const raw = String(value || '').trim().replace(/\0/g, '');
  const windowsBase = path.win32.basename(raw);
  const base = path.posix.basename(windowsBase).trim();
  return base.slice(0, 255) || 'attachment';
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) {
    throw new AttachmentStoreError(
      'ATTACHMENT_DATA_URL_INVALID',
      'Attachment must be a base64 data URL.',
    );
  }
  const mimeType = normalizeMimeType(match[1]);
  const payload = match[2];
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new AttachmentStoreError(
      'ATTACHMENT_BASE64_INVALID',
      'Attachment base64 payload is invalid.',
    );
  }
  const data = Buffer.from(payload, 'base64');
  if (data.length === 0 || data.toString('base64') !== payload) {
    throw new AttachmentStoreError(
      'ATTACHMENT_BASE64_INVALID',
      'Attachment base64 payload is invalid.',
    );
  }
  return { mimeType, data };
}

function matchesMagic(mimeType, data) {
  switch (mimeType) {
    case 'image/png':
      return data.length >= 8 && data.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
    case 'image/webp':
      return data.length >= 12
        && data.subarray(0, 4).toString('ascii') === 'RIFF'
        && data.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/bmp':
      return data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM';
    case 'image/heic':
      return data.length >= 12
        && data.subarray(4, 8).toString('ascii') === 'ftyp'
        && ['heic', 'heix', 'hevc', 'hevx'].includes(
          data.subarray(8, 12).toString('ascii').toLowerCase(),
        );
    case 'image/heif':
      return data.length >= 12
        && data.subarray(4, 8).toString('ascii') === 'ftyp'
        && ['mif1', 'msf1'].includes(data.subarray(8, 12).toString('ascii').toLowerCase());
    case 'application/pdf':
      return data.length >= 5 && data.subarray(0, 5).toString('ascii') === '%PDF-';
    default:
      return false;
  }
}

function attachmentId(mimeType, data) {
  const hash = crypto.createHash('sha256');
  hash.update(mimeType, 'utf8');
  hash.update(Buffer.from([0]));
  hash.update(data);
  return `att_${hash.digest('hex')}`;
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertAttachmentId(id) {
  const normalized = String(id || '');
  if (!ATTACHMENT_ID_PATTERN.test(normalized)) {
    throw new AttachmentStoreError('ATTACHMENT_ID_INVALID', 'Attachment id is invalid.');
  }
  return normalized;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
  }
}

class AttachmentStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(String(options.rootDir || '').trim());
    if (!String(options.rootDir || '').trim()) {
      throw new TypeError('AttachmentStore requires rootDir.');
    }
    this.contentDir = path.join(this.rootDir, 'content');
    this.metadataDir = path.join(this.rootDir, 'metadata');
    this.maxAttachments = Number.isInteger(options.maxAttachments) && options.maxAttachments > 0
      ? options.maxAttachments
      : 8;
    this.maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
      ? options.maxFileBytes
      : 10 * 1024 * 1024;
    this.maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0
      ? options.maxTotalBytes
      : 20 * 1024 * 1024;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? Number(options.ttlMs)
      : 24 * 60 * 60 * 1000;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  isoNow() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  prepare(row) {
    const parsed = parseDataUrl(row && row.dataUrl);
    if (!MIME_TYPES.includes(parsed.mimeType)) {
      throw new AttachmentStoreError(
        'ATTACHMENT_MIME_UNSUPPORTED',
        'Attachment MIME type is not supported.',
        { mimeType: parsed.mimeType },
      );
    }
    const declared = normalizeMimeType(row && row.mimeType);
    if (declared && declared !== parsed.mimeType) {
      throw new AttachmentStoreError(
        'ATTACHMENT_MIME_MISMATCH',
        'Declared attachment MIME type does not match the data URL.',
      );
    }
    if (!matchesMagic(parsed.mimeType, parsed.data)) {
      throw new AttachmentStoreError(
        'ATTACHMENT_MAGIC_MISMATCH',
        'Attachment bytes do not match the declared MIME type.',
        { mimeType: parsed.mimeType },
      );
    }
    if (parsed.data.length > this.maxFileBytes) {
      throw new AttachmentStoreError(
        'ATTACHMENT_FILE_SIZE_LIMIT',
        'Attachment exceeds the per-file byte limit.',
        { sizeBytes: parsed.data.length, maxFileBytes: this.maxFileBytes },
      );
    }
    return {
      id: attachmentId(parsed.mimeType, parsed.data),
      name: sanitizeName(row && row.name),
      mimeType: parsed.mimeType,
      data: parsed.data,
    };
  }

  saveBatch(rows) {
    if (!Array.isArray(rows)) {
      throw new AttachmentStoreError('ATTACHMENT_BATCH_INVALID', 'Attachments must be an array.');
    }
    if (rows.length > this.maxAttachments) {
      throw new AttachmentStoreError(
        'ATTACHMENT_COUNT_LIMIT',
        'Attachment count exceeds the batch limit.',
        { count: rows.length, maxAttachments: this.maxAttachments },
      );
    }
    const prepared = rows.map(row => this.prepare(row));
    const totalBytes = prepared.reduce((sum, item) => sum + item.data.length, 0);
    if (totalBytes > this.maxTotalBytes) {
      throw new AttachmentStoreError(
        'ATTACHMENT_TOTAL_SIZE_LIMIT',
        'Attachments exceed the total byte limit.',
        { totalBytes, maxTotalBytes: this.maxTotalBytes },
      );
    }

    const createdAt = this.isoNow();
    const expiresAt = new Date(Date.parse(createdAt) + this.ttlMs).toISOString();
    return prepared.map(item => {
      const existing = this.getMetadata(item.id);
      if (existing) return existing;
      const metadata = {
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.data.length,
        createdAt,
        expiresAt,
      };
      atomicWrite(path.join(this.contentDir, `${item.id}.bin`), item.data);
      atomicWrite(
        path.join(this.metadataDir, `${item.id}.json`),
        Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'),
      );
      return copy(metadata);
    });
  }

  getMetadata(id) {
    const normalized = assertAttachmentId(id);
    const file = path.join(this.metadataDir, `${normalized}.json`);
    try {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!metadata || metadata.id !== normalized || !MIME_TYPES.includes(metadata.mimeType)) {
        throw new Error('invalid metadata');
      }
      return copy({
        id: metadata.id,
        name: sanitizeName(metadata.name),
        mimeType: metadata.mimeType,
        sizeBytes: Number(metadata.sizeBytes) || 0,
        createdAt: String(metadata.createdAt || ''),
        expiresAt: String(metadata.expiresAt || ''),
      });
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new AttachmentStoreError(
        'ATTACHMENT_METADATA_INVALID',
        'Attachment metadata is invalid.',
        { id: normalized },
      );
    }
  }

  read(id) {
    const normalized = assertAttachmentId(id);
    const metadata = this.getMetadata(normalized);
    if (!metadata) return null;
    try {
      const data = fs.readFileSync(path.join(this.contentDir, `${normalized}.bin`));
      if (data.length !== metadata.sizeBytes || !matchesMagic(metadata.mimeType, data)) {
        throw new Error('content mismatch');
      }
      return { metadata, data };
    } catch (error) {
      throw new AttachmentStoreError(
        'ATTACHMENT_CONTENT_INVALID',
        'Attachment content is missing or invalid.',
        { id: normalized },
      );
    }
  }

  cleanupExpired() {
    if (!fs.existsSync(this.metadataDir)) return [];
    const nowMs = Date.parse(this.isoNow());
    const removed = [];
    for (const entry of fs.readdirSync(this.metadataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!ATTACHMENT_ID_PATTERN.test(id)) continue;
      const metadata = this.getMetadata(id);
      if (!metadata || !Number.isFinite(Date.parse(metadata.expiresAt))) continue;
      if (Date.parse(metadata.expiresAt) > nowMs) continue;
      for (const file of [
        path.join(this.metadataDir, `${id}.json`),
        path.join(this.contentDir, `${id}.bin`),
      ]) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
      }
      removed.push(id);
    }
    return removed.sort();
  }
}

module.exports = {
  ATTACHMENT_ID_PATTERN,
  AttachmentStore,
  AttachmentStoreError,
  MIME_TYPES,
  attachmentId,
  matchesMagic,
  parseDataUrl,
};
