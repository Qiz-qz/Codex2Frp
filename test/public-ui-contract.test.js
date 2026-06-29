'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const indexPath = path.join(publicDir, 'index.html');
const cssPath = path.join(publicDir, 'styles', 'codex2frp-console.css');
const jsPath = path.join(publicDir, 'scripts', 'codex2frp-client.js');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const assetVersionPattern = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('browser frontend uses standalone assets instead of legacy inline monolith', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.match(html, /data-shell="operations-board"/, 'HTML exposes the redesigned operations-board shell marker');
  assert.match(html, new RegExp(`href="styles/codex2frp-console\\.css\\?v=${assetVersionPattern}"`), 'HTML loads the versioned standalone browser stylesheet');
  assert.match(html, new RegExp(`src="scripts/codex2frp-client\\.js\\?v=${assetVersionPattern}"`), 'HTML loads the versioned standalone browser client script');
  assert.match(html, /class="[^"]*\boperations-mast\b/, 'top controls use the redesigned floating operations mast');
  assert.match(html, /class="[^"]*\bmessage-stage\b/, 'messages use the redesigned framed message stage');
  assert.match(html, /class="[^"]*\binput-harbor\b/, 'composer uses the redesigned input harbor');
  assert.doesNotMatch(html, /composer-signature|Relay Console/i, 'browser UI does not render the old decorative footer signature');
  assert.doesNotMatch(html, /relay-console-app|control-deck|command-dock|data-shell="relay-console"/, 'HTML no longer uses the previous relay-console layout class names');
  assert.doesNotMatch(html, /<style\b/i, 'browser UI no longer carries inherited inline stylesheet blocks');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'browser UI no longer carries inherited inline script blocks');
  for (const id of ['thread', 'composer', 'text', 'send', 'stop', 'thread-menu', 'route-badge']) {
    assert.match(html, new RegExp(`id="${id}"`), `keeps required UI control #${id}`);
  }
});

test('browser frontend exposes only the reduced public console surface', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const removedIds = [
    'new-thread',
    'keep-awake',
    'reasoning-badge',
    'model-badge',
    'speed-badge',
    'reasoning-menu-card',
    'model-menu-card',
    'speed-menu-card',
    'context-quick-card',
    'thread-action-card',
    'thread-action-archive',
    'thread-action-rename',
    'thread-action-pin-toggle',
    'attach',
    'file-input',
    'attachment-tray',
  ];
  for (const id of removedIds) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `reduced browser UI should not leave #${id} in the DOM`);
  }
  assert.match(html, /<div class="route-badge" id="route-badge"/, 'route badge is a read-only status element');
  assert.doesNotMatch(html, /id="route-badge"[^>]*(type="button"|role="button"|tabindex=)/, 'route badge is not interactive');
  assert.doesNotMatch(js, /ROUTE_BADGE_COMPACT_STORAGE_KEY|toggleRouteBadgeCompact|routeBadge\.addEventListener\('click'/, 'route badge click no longer changes display mode');
  assert.doesNotMatch(css, /\.route-badge\.is-compact|route-badge:active/, 'stylesheet does not keep the old clickable compact route state');
});

test('browser frontend assets define the new control-console skin and keep runtime hooks', () => {
  assert.equal(fs.existsSync(cssPath), true, 'standalone browser stylesheet exists');
  assert.equal(fs.existsSync(jsPath), true, 'standalone browser script exists');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  assert.match(css, /--ops-bg/, 'stylesheet defines the new operations-board palette');
  assert.match(css, /\.operations-mast/, 'stylesheet contains the redesigned floating operations mast');
  assert.match(css, /\.message-stage/, 'stylesheet contains the redesigned framed message stage');
  assert.match(css, /\.input-harbor/, 'stylesheet contains the redesigned input harbor');
  assert.doesNotMatch(css, /\.composer-signature|signatureColorFlow|--composer-signature/, 'stylesheet has removed the old footer signature system');
  assert.doesNotMatch(js, /composerSignature|composer-signature|positionComposerSignature/, 'client script no longer tracks a decorative footer signature');
  assert.match(js, /async function bootApp\(\)/, 'client script preserves existing startup lifecycle');
  assert.match(js, /function fetchApi\(/, 'client script preserves backend API access');
  assert.match(js, /\/codex\/threads/, 'client script preserves thread API usage');
  assert.match(js, /\/send/, 'client script preserves send API usage');
});
