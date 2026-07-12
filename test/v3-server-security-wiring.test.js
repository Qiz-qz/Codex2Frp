'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server constructs the v3 attachment store and Windows-aware production queue store', () => {
  assert.match(source, /const \{ AttachmentStore \} = require\('\.\/lib\/attachments\/attachment-store'\)/);
  assert.match(source, /const \{ createProductionQueueStore \} = require\('\.\/lib\/queue\/queue-store'\)/);
  assert.match(source, /const ATTACHMENT_STORE_DIR = path\.join\(STATE_DIR, 'attachments'\)/);
  assert.match(source, /new AttachmentStore\(\{[\s\S]*?rootDir: ATTACHMENT_STORE_DIR,[\s\S]*?maxAttachments: MAX_ATTACHMENTS,[\s\S]*?maxFileBytes: MAX_ATTACHMENT_BYTES,[\s\S]*?maxTotalBytes: MAX_TOTAL_ATTACHMENT_BYTES,[\s\S]*?\}\)/);
  assert.match(source, /attachmentStore\.cleanupExpired\(\)/);
  assert.match(source, /createProductionQueueStore\(\{ file: TURN_INPUT_QUEUE_FILE \}\)/);
  assert.match(source, /new V3ApiRouter\(\{[\s\S]*?attachmentStore,[\s\S]*?diagnosticContext:[\s\S]*?diagnosticTokens: \[TOKEN\]/);
});

test('v3 diagnostics remains behind the shared authenticated request handler', () => {
  assert.match(source, /async function handleV3ApiRequest\(req, res\) \{\s*if \(!isAuthorized\(req\)\)/);
  assert.match(source, /req\.url\.startsWith\('\/codex\/v3\/'\)[\s\S]*?handleV3ApiRequest\(req, res\)/);
});
