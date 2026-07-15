'use strict';

const { matchesMagic, parseDataUrl } = require('../attachments/attachment-store');

const MAX_EXEC_IMAGE_DECODED_BYTES = 10 * 1024 * 1024;
const MAX_EXEC_IMAGE_DATA_URL_CHARS = 14 * 1024 * 1024;

function isVerifiedImageDataUrl(value) {
  const source = typeof value === 'string' ? value : '';
  if (!source || source.length > MAX_EXEC_IMAGE_DATA_URL_CHARS) return false;
  const comma = source.indexOf(',');
  if (comma < 0) return false;
  const payloadLength = source.length - comma - 1;
  if (payloadLength < 4 || payloadLength % 4 !== 0) return false;
  const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0;
  const decodedBytes = payloadLength / 4 * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_EXEC_IMAGE_DECODED_BYTES) return false;
  try {
    const parsed = parseDataUrl(source);
    return parsed.mimeType.startsWith('image/') && matchesMagic(parsed.mimeType, parsed.data);
  } catch {
    return false;
  }
}

module.exports = {
  isVerifiedImageDataUrl,
};
