'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectGeneratedSchema } = require('./schema-profile');
const { negotiateSchemaProfile } = require('./schema-negotiator');

function observeInstalledSchema(executable, options = {}) {
  const command = String(executable || '').trim();
  if (!command) throw new TypeError('Schema observation requires a Codex executable.');
  const runtimeDirectory = path.resolve(String(options.runtimeDirectory || path.join(process.cwd(), '.runtime')));
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(runtimeDirectory, 'schema-observation-'));
  const run = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  try {
    const result = run(command, [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      outputDirectory,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000,
    });
    if (!result || result.status !== 0) {
      const error = new Error('Installed Codex schema generation failed.');
      error.code = 'APP_SERVER_SCHEMA_GENERATION_FAILED';
      throw error;
    }
    return inspectGeneratedSchema(outputDirectory);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function selectBridgeSchemaProfile(options = {}) {
  const executable = String(options.executable || '').trim();
  if (!executable) return { compatible: false, profile: null, reason: 'schema_unavailable' };
  const observeSchema = typeof options.observeSchema === 'function'
    ? options.observeSchema
    : command => observeInstalledSchema(command, {
        runtimeDirectory: options.runtimeDirectory,
        timeoutMs: options.timeoutMs,
      });
  let observation;
  try {
    observation = observeSchema(executable);
  } catch {
    return { compatible: false, profile: null, reason: 'schema_unavailable' };
  }
  const hashes = [
    observation && observation.schemaHash,
    ...Object.values(observation && observation.schemaFileHashes || {}),
  ].map(value => String(value || '').toLowerCase()).filter((value, index, values) => (
    value && values.indexOf(value) === index
  ));
  for (const schemaHash of hashes) {
    const result = negotiateSchemaProfile({
      cliVersion: String(options.cliVersion || ''),
      schemaHash,
      methods: observation && observation.requestMethods,
      types: observation && observation.typeUnions,
    });
    if (result.compatible || result.reason === 'schema_shape_mismatch') return result;
  }
  return { compatible: false, profile: null, reason: 'schema_mismatch' };
}

module.exports = {
  observeInstalledSchema,
  selectBridgeSchemaProfile,
};
