'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppServerCompatibilityError } = require('../codex/errors');

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
  computeSchemaHash,
  loadSchemaProfile,
  validateInitializeResponse,
  validateSchemaProfile,
  verifySchemaHash,
};
