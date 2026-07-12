'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const launcherSource = fs.readFileSync(path.join(root, 'scripts', 'launch-main-codex-cdp.ps1'), 'utf8');
const windowDiscoverySource = fs.readFileSync(
  path.join(root, 'lib', 'windows', 'codex-window-discovery.js'),
  'utf8',
);

test('strict Windows automation recognizes the current ChatGPT host without enumerating every window for activation', () => {
  assert.match(windowDiscoverySource, /'chatgpt\.exe'[\s\S]*'codex\.exe'/,
    'transaction window discovery recognizes current and legacy host processes');
  assert.doesNotMatch(serverSource, /Get-Process ChatGPT,Codex/,
    'explicit actions do not activate every Codex process');
  assert.match(serverSource, /name = 'ChatGPT\.exe' OR name = 'Codex\.exe'/, 'CDP process discovery recognizes current and legacy host processes');
  assert.equal(serverSource.includes("\\\\app\\\\(ChatGPT|Codex)\\.exe"), true, 'server validates the packaged desktop executable path');
});

test('CDP launcher resolves ChatGPT.exe first and retains explicit legacy candidates', () => {
  assert.match(launcherSource, /app\\ChatGPT\.exe/, 'AppX candidate uses the current ChatGPT executable');
  assert.match(launcherSource, /app\\Codex\.exe/, 'legacy AppX candidate remains available');
  assert.match(launcherSource, /name = 'ChatGPT\.exe' OR name = 'Codex\.exe'/, 'all process queries include both host names');
  assert.equal(launcherSource.includes("\\\\app\\\\(ChatGPT|Codex)\\.exe"), true, 'launcher validates both packaged executable names');
});
