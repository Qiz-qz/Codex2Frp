'use strict';

const fs = require('node:fs');
const path = require('node:path');

function redirectStream(streamName, envName) {
  const file = process.env[envName];
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = fs.createWriteStream(file, { flags: 'a' });
  const stream = process[streamName];
  const originalWrite = stream.write.bind(stream);
  target.on('error', error => {
    try {
      originalWrite(`[Codex2Frp] log redirect failed: ${error && error.message || error}\n`);
    } catch {}
  });
  stream.write = function writeToLog(chunk, encoding, callback) {
    return target.write(chunk, encoding, callback);
  };
}

redirectStream('stdout', 'CODEX2FRP_STDOUT');
redirectStream('stderr', 'CODEX2FRP_STDERR');

require(path.join(process.cwd(), 'server.js'));
