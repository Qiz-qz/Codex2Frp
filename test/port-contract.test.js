'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const launcherSource = fs.readFileSync(path.join(root, 'windows', 'launcher', 'Codex2FrpLauncher.cs'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const startScript = fs.readFileSync(path.join(root, 'scripts', 'start-windows-local.ps1'), 'utf8');

test('backend default port is 8988', () => {
  assert.match(launcherSource, /internal const int ServicePort = 8988;/, 'Windows launcher listens on port 8988');
  assert.match(launcherSource, /internal const string ServicePortDisplay = "8988";/, 'launcher displays port 8988 in URLs');
  assert.match(serverSource, /const PORT = Number\(process\.env\.PORT \|\| 8988\);/, 'server.js default port is 8988 outside the launcher');
  assert.match(startScript, /\[int\]\$Port = 8988,/, 'PowerShell local start default port is 8988');
  assert.doesNotMatch(launcherSource, /ServicePort = 8788|ServicePort = 8787/, 'launcher no longer defaults to the old ports');
});
