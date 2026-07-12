const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function bodyOf(functionName) {
  const start = serverSource.indexOf(`function ${functionName}`);
  assert.ok(start >= 0, `${functionName} exists`);
  const end = serverSource.indexOf('\nfunction ', start + 1);
  return serverSource.slice(start, end > start ? end : serverSource.length);
}

{
  const body = bodyOf('findModelOption');
  assert.match(body, /availableModelOptionsForSwitch\(\)/, 'model switching can resolve targets from live client model options');
}

{
  const body = bodyOf('modelSwitchTargetForCurrent');
  assert.match(body, /availableModelOptionsForSwitch\(\)/, 'implicit model switch targets also use live client model options');
}

assert.doesNotMatch(
  serverSource,
  /server\.listen\([\s\S]*warmCodexModeOptionsAfterStart\(\)/,
  'backend startup never activates Codex to warm client-menu options'
);

{
  const body = bodyOf('handleClientConfig');
  assert.doesNotMatch(
    body,
    /readLiveCodexModeOptionsBounded/,
    'background config reads never turn a refresh query into desktop UI automation'
  );
  assert.match(body, /cachedLiveModeOptions\(\)/, 'config can use the last passive cache without focusing Codex');
}
