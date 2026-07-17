const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('shutdown handlers call only live cleanup functions', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const shutdown = source.slice(source.indexOf("process.on('exit'"));

  assert.match(shutdown, /process\.on\('SIGINT',[\s\S]*cleanupKeepAwake\(\);[\s\S]*stopV3Runtime\(\);[\s\S]*process\.exit\(130\);/);
  assert.match(shutdown, /process\.on\('SIGTERM',[\s\S]*cleanupKeepAwake\(\);[\s\S]*stopV3Runtime\(\);[\s\S]*process\.exit\(143\);/);
  assert.doesNotMatch(shutdown, /stopPushWatchTimer/);
});
