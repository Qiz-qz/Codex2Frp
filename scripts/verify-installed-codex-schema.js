'use strict';

const path = require('node:path');
const {
  detectCodexCliVersion,
  discoverCodexExecutable,
} = require('../lib/app-server/discovery');
const { negotiateSchemaProfile } = require('../lib/app-server/schema-negotiator');
const { inspectGeneratedSchema } = require('../lib/app-server/schema-profile');

function parseArgs(argv) {
  const options = { schemaDirectory: '', executable: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--schema-dir') options.schemaDirectory = String(argv[++index] || '');
    else if (argument === '--codex-exe') options.executable = String(argv[++index] || '');
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const executable = discoverCodexExecutable({ explicitPath: options.executable });
  const cliVersion = detectCodexCliVersion(executable);
  const schemaDirectory = path.resolve(options.schemaDirectory
    || path.join(__dirname, '..', '.runtime', `schema-${cliVersion}`));
  const observation = inspectGeneratedSchema(schemaDirectory);
  const result = negotiateSchemaProfile({
    cliVersion,
    schemaHash: observation.schemaHash,
    methods: observation.requestMethods,
    types: observation.typeUnions,
  });
  const report = {
    compatible: result.compatible,
    reason: result.reason,
    cliVersion,
    schemaHash: observation.schemaHash,
    requestMethodCount: observation.requestMethods.length,
    notificationMethodCount: observation.notificationMethods.length,
    profile: result.profile ? result.profile.id : null,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return result.compatible ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : 'Schema verification failed.'}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
