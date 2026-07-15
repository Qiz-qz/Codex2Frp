'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppServerCompatibilityError } = require('../codex/errors');

const NORMALIZED_SCHEMA_FILE_SEPARATOR = '\n---codex2frp-schema-file---\n';

function compatibilityError(code, message, details = {}, options = {}) {
  return new AppServerCompatibilityError(code, message, details, options);
}

function validateStringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', `${field} must be a non-empty array.`, { field });
  }
  const normalized = value.map(item => String(item || '').trim());
  if (normalized.some(item => !item) || new Set(normalized).size !== normalized.length) {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', `${field} contains empty or duplicate values.`, { field });
  }
  return normalized;
}

function validateSchemaProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile must be an object.');
  }
  for (const field of ['id', 'schemaVersion']) {
    if (typeof profile[field] !== 'string' || !profile[field].trim()) {
      throw compatibilityError('APP_SERVER_PROFILE_INVALID', `Schema profile is missing ${field}.`, { field });
    }
  }
  if (!profile.schema || !/^[a-f0-9]{64}$/i.test(String(profile.schema.sha256 || ''))) {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile has an invalid SHA-256.', { field: 'schema.sha256' });
  }
  validateStringList(profile.requiredRequestMethods, 'requiredRequestMethods');
  validateStringList(profile.requiredNotificationMethods, 'requiredNotificationMethods');
  if (profile.schemaHash !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(String(profile.schemaHash || ''))) {
      throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile has an invalid normalized hash.', {
        field: 'schemaHash',
      });
    }
    if (String(profile.schemaHash).toLowerCase() !== String(profile.schema.sha256).toLowerCase()) {
      throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile hash fields disagree.', {
        field: 'schemaHash',
      });
    }
    validateStringList(profile.cliVersions, 'cliVersions');
    validateStringList(profile.requestMethods, 'requestMethods');
    validateStringList(profile.notificationMethods, 'notificationMethods');
    if (!profile.typeUnions || typeof profile.typeUnions !== 'object' || Array.isArray(profile.typeUnions)) {
      throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'typeUnions must be an object.', {
        field: 'typeUnions',
      });
    }
    const unionNames = Object.keys(profile.typeUnions);
    if (unionNames.length === 0) {
      throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'typeUnions must not be empty.', {
        field: 'typeUnions',
      });
    }
    for (const name of unionNames) validateStringList(profile.typeUnions[name], `typeUnions.${name}`);
  }
  if (!profile.initialize || typeof profile.initialize.userAgentPattern !== 'string') {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile is missing initialize constraints.');
  }
  validateStringList(profile.initialize.platformFamilies, 'initialize.platformFamilies');
  validateStringList(profile.initialize.platformOs, 'initialize.platformOs');
  try {
    new RegExp(profile.initialize.userAgentPattern);
  } catch (error) {
    throw compatibilityError('APP_SERVER_PROFILE_INVALID', 'Schema profile has an invalid user-agent pattern.', {
      field: 'initialize.userAgentPattern',
    }, { cause: error });
  }
  return profile;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalizeJson(value[key])]),
  );
}

function listJsonFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsonFiles(root, file);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.json') ? [file] : [];
  });
}

function normalizedSchemaPayload(schemaDirectory) {
  const root = path.resolve(String(schemaDirectory || ''));
  const entries = listJsonFiles(root).map(file => ({
    relative: path.relative(root, file).replaceAll('\\', '/'),
    schema: JSON.parse(fs.readFileSync(file, 'utf8')),
  })).sort((left, right) => left.relative < right.relative ? -1 : (left.relative > right.relative ? 1 : 0));
  if (entries.length === 0) {
    throw compatibilityError('APP_SERVER_SCHEMA_INVALID', 'Generated schema directory contains no JSON files.');
  }
  return `${entries.map(entry => (
    `${entry.relative}\n${JSON.stringify(canonicalizeJson(entry.schema))}`
  )).join(NORMALIZED_SCHEMA_FILE_SEPARATOR)}\n`;
}

function methodInventory(schema) {
  return (Array.isArray(schema && schema.oneOf) ? schema.oneOf : [])
    .flatMap(variant => variant && variant.properties && variant.properties.method
      && Array.isArray(variant.properties.method.enum)
      ? variant.properties.method.enum.map(String)
      : []);
}

function unionVariantLabels(variant) {
  const values = (variant && Array.isArray(variant.enum) && variant.enum)
    || (variant && variant.properties && variant.properties.type
      && Array.isArray(variant.properties.type.enum) && variant.properties.type.enum)
    || (variant && variant.properties && variant.properties.method
      && Array.isArray(variant.properties.method.enum) && variant.properties.method.enum);
  if (values) return values.map(String);
  if (variant && variant.$ref) return [`$ref:${String(variant.$ref).split('/').pop()}`];
  if (variant && variant.title) return [`title:${variant.title}`];
  if (variant && typeof variant.type === 'string') return [`type:${variant.type}`];
  return [`sha256:${computeSchemaHash(Buffer.from(JSON.stringify(canonicalizeJson(variant)), 'utf8'))}`];
}

function typeUnionInventory(schema, prefix) {
  return Object.fromEntries(Object.entries(schema && schema.definitions || {})
    .filter(([, definition]) => Array.isArray(definition.oneOf) || Array.isArray(definition.anyOf))
    .map(([name, definition]) => [
      `${prefix}${name}`,
      (definition.oneOf || definition.anyOf).flatMap(unionVariantLabels),
    ]));
}

function readGeneratedJson(schemaDirectory, relativeFile) {
  return JSON.parse(fs.readFileSync(path.join(schemaDirectory, relativeFile), 'utf8'));
}

function inspectGeneratedSchema(schemaDirectory) {
  const payload = normalizedSchemaPayload(schemaDirectory);
  const protocol = readGeneratedJson(schemaDirectory, 'codex_app_server_protocol.schemas.json');
  const protocolV2 = readGeneratedJson(schemaDirectory, 'codex_app_server_protocol.v2.schemas.json');
  return {
    schemaHash: computeSchemaHash(Buffer.from(payload, 'utf8')),
    schemaFileHashes: {
      'codex_app_server_protocol.schemas.json': computeSchemaHash(
        fs.readFileSync(path.join(schemaDirectory, 'codex_app_server_protocol.schemas.json')),
      ),
    },
    requestMethods: methodInventory(readGeneratedJson(schemaDirectory, 'ClientRequest.json')),
    notificationMethods: methodInventory(readGeneratedJson(schemaDirectory, 'ServerNotification.json')),
    typeUnions: {
      ...typeUnionInventory(protocol, 'protocol/'),
      ...typeUnionInventory(protocolV2, 'v2/'),
    },
  };
}

function computeNormalizedSchemaHash(schemaDirectory) {
  return computeSchemaHash(Buffer.from(normalizedSchemaPayload(schemaDirectory), 'utf8'));
}

function loadSchemaProfile(file) {
  return validateSchemaProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function computeSchemaHash(schemaBytes) {
  return crypto.createHash('sha256').update(schemaBytes).digest('hex');
}

function verifySchemaHash(schemaBytes, profile) {
  validateSchemaProfile(profile);
  const actual = computeSchemaHash(schemaBytes);
  const expected = profile.schema.sha256.toLowerCase();
  if (actual !== expected) {
    throw compatibilityError(
      'APP_SERVER_SCHEMA_MISMATCH',
      'Generated app-server schema hash does not match the negotiated profile.',
      { expected, actual, profileId: profile.id },
    );
  }
  return actual;
}

function normalizeWindowsPath(value) {
  const normalized = path.win32.normalize(String(value || '').trim());
  if (normalized.length <= 3) return normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, '').toLowerCase();
}

function validateInitializeResponse(response, options = {}) {
  const profile = validateSchemaProfile(options.profile);
  if (!response || typeof response !== 'object') {
    throw compatibilityError('APP_SERVER_INITIALIZE_INVALID', 'Initialize response must be an object.');
  }
  const expectedCodexHome = String(options.expectedCodexHome || '').trim();
  const actualCodexHome = String(response.codexHome || '').trim();
  if (!path.win32.isAbsolute(actualCodexHome) || !path.win32.isAbsolute(expectedCodexHome)) {
    throw compatibilityError(
      'APP_SERVER_CODEX_HOME_INVALID',
      'Initialize CODEX_HOME values must be absolute Windows paths.',
    );
  }
  if (normalizeWindowsPath(actualCodexHome) !== normalizeWindowsPath(expectedCodexHome)) {
    throw compatibilityError(
      'APP_SERVER_CODEX_HOME_MISMATCH',
      'App-server initialized with a different CODEX_HOME.',
      { expected: expectedCodexHome, actual: actualCodexHome },
    );
  }

  const allowedFamilies = new Set(profile.initialize.platformFamilies);
  const allowedOs = new Set(profile.initialize.platformOs);
  if (!allowedFamilies.has(response.platformFamily) || !allowedOs.has(response.platformOs)) {
    throw compatibilityError(
      'APP_SERVER_PLATFORM_MISMATCH',
      'App-server platform does not match the negotiated schema profile.',
      { platformFamily: response.platformFamily, platformOs: response.platformOs },
    );
  }
  if (!new RegExp(profile.initialize.userAgentPattern).test(String(response.userAgent || ''))) {
    throw compatibilityError(
      'APP_SERVER_USER_AGENT_MISMATCH',
      'App-server user agent does not match the negotiated schema profile.',
      { profileId: profile.id, userAgent: String(response.userAgent || '') },
    );
  }
  return response;
}

module.exports = {
  canonicalizeJson,
  computeNormalizedSchemaHash,
  computeSchemaHash,
  inspectGeneratedSchema,
  loadSchemaProfile,
  normalizedSchemaPayload,
  validateInitializeResponse,
  validateSchemaProfile,
  verifySchemaHash,
};
