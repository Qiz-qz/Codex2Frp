'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSchemaProfile } = require('./schema-profile');

function profiles() {
  const directory = path.join(__dirname, 'profiles');
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('-profile.json'))
    .map(entry => validateSchemaProfile(JSON.parse(
      fs.readFileSync(path.join(directory, entry.name), 'utf8'),
    )))
    .filter(profile => typeof profile.schemaHash === 'string');
}

function sameStringList(expected, actual) {
  if (!Array.isArray(actual)) return false;
  const actualValues = new Set(actual.map(String));
  return actual.length === expected.length
    && actualValues.size === expected.length
    && expected.every(value => actualValues.has(value));
}

function hasRequiredShape(profile, observation) {
  if (!sameStringList(profile.requestMethods, observation && observation.methods)) return false;
  if (!observation || !observation.types || typeof observation.types !== 'object') return false;
  return Object.entries(profile.typeUnions).every(([name, values]) => {
    const actual = observation.types[name];
    return Array.isArray(actual)
      && actual.length === values.length
      && actual.every((value, index) => String(value) === values[index]);
  });
}

function negotiateSchemaProfile(observation = {}) {
  const schemaHash = String(observation.schemaHash || '').toLowerCase();
  const profile = profiles().find(candidate => candidate.schemaHash.toLowerCase() === schemaHash);
  if (!profile) return { compatible: false, profile: null, reason: 'schema_mismatch' };
  if (!hasRequiredShape(profile, observation)) {
    return { compatible: false, profile: null, reason: 'schema_shape_mismatch' };
  }
  return { compatible: true, profile, reason: null };
}

module.exports = {
  hasRequiredShape,
  negotiateSchemaProfile,
  profiles,
};
