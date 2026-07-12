'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ProtectedThreadGuard } = require('./protected-thread-guard');

const SCHEMA_VERSION = 1;

class ThreadProtectionError extends Error {
  constructor(code, message, statusCode, details = {}) {
    super(message);
    this.name = 'ThreadProtectionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = { ...details };
  }
}

function normalizeThreadId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeThreadIds(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeThreadId)
      .filter(Boolean),
  );
}

function requireThreadId(value) {
  const normalized = normalizeThreadId(value);
  if (!normalized) {
    throw new ThreadProtectionError(
      'PROTECTION_TARGET_REQUIRED',
      'A concrete task target is required.',
      400,
    );
  }
  return normalized;
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    userProtectedThreadIds: [],
  };
}

function invalidStore() {
  return new ThreadProtectionError(
    'PROTECTION_STORE_INVALID',
    'Task protection persistence is invalid.',
    503,
  );
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidStore();
  if (value.schemaVersion !== SCHEMA_VERSION) throw invalidStore();
  if (!Number.isInteger(value.revision) || value.revision < 0) throw invalidStore();
  if (!Array.isArray(value.userProtectedThreadIds)) throw invalidStore();
  const normalized = value.userProtectedThreadIds.map(normalizeThreadId);
  if (normalized.some((threadId, index) => (
    !threadId
    || typeof value.userProtectedThreadIds[index] !== 'string'
    || threadId !== value.userProtectedThreadIds[index]
  ))) throw invalidStore();
  if (new Set(normalized).size !== normalized.length) throw invalidStore();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision,
    userProtectedThreadIds: [...normalized],
  };
}

function readState(file, fileSystem) {
  let source;
  try {
    source = fileSystem.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    throw new ThreadProtectionError(
      'PROTECTION_STORE_UNAVAILABLE',
      'Task protection persistence is unavailable.',
      503,
    );
  }
  try {
    return validateState(JSON.parse(source));
  } catch (error) {
    if (error instanceof ThreadProtectionError) throw error;
    throw invalidStore();
  }
}

function writeStateAtomic(file, state, fileSystem) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fileSystem.renameSync(temporary, file);
  } finally {
    try {
      fileSystem.unlinkSync(temporary);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

class ThreadProtectionRegistry {
  constructor(options = {}) {
    this.file = String(options.file || '').trim();
    this.fs = options.fs || fs;
    const environment = options.environment && typeof options.environment === 'object'
      ? options.environment
      : process.env;
    this.environmentThreadId = normalizeThreadId(environment.CODEX_THREAD_ID);
    this.permanentThreadIds = normalizeThreadIds(options.protectedThreadIds);
    if (this.environmentThreadId) this.permanentThreadIds.add(this.environmentThreadId);
    this.failure = null;
    try {
      this.state = readState(this.file, this.fs);
    } catch (error) {
      this.failure = error;
      throw error;
    }
    this.userThreadIds = normalizeThreadIds(this.state.userProtectedThreadIds);
  }

  _assertHealthy() {
    if (this.failure) throw this.failure;
  }

  isProtected(threadId) {
    this._assertHealthy();
    const normalized = normalizeThreadId(threadId);
    return Boolean(
      normalized
      && (this.permanentThreadIds.has(normalized) || this.userThreadIds.has(normalized)),
    );
  }

  status(threadId) {
    const normalized = requireThreadId(threadId);
    return {
      protected: this.isProtected(normalized),
      ...this.summary(),
    };
  }

  summary() {
    this._assertHealthy();
    const all = new Set([...this.permanentThreadIds, ...this.userThreadIds]);
    return {
      protectedCount: all.size,
      environmentProtected: Boolean(this.environmentThreadId),
      revision: Number(this.state.revision || 0),
    };
  }

  refresh() {
    try {
      const next = readState(this.file, this.fs);
      this.state = next;
      this.userThreadIds = normalizeThreadIds(next.userProtectedThreadIds);
      this.failure = null;
      return this.summary();
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  protect(threadId, options = {}) {
    return this._mutate('protect', threadId, options);
  }

  unprotect(threadId, options = {}) {
    return this._mutate('unprotect', threadId, options);
  }

  _mutate(operation, threadId, options) {
    this._assertHealthy();
    const normalized = requireThreadId(threadId);
    const mutationOptions = options && typeof options === 'object' ? options : {};
    if (Object.hasOwn(mutationOptions, 'expectedRevision') && (
      !Number.isInteger(mutationOptions.expectedRevision)
      || mutationOptions.expectedRevision < 0
    )) {
      throw new ThreadProtectionError(
        'PROTECTION_REVISION_INVALID',
        'Task protection revision is invalid.',
        400,
      );
    }
    if (operation === 'unprotect' && this.permanentThreadIds.has(normalized)) {
      throw new ThreadProtectionError(
        'PROTECTION_IMMUTABLE',
        'Permanent task protection cannot be removed remotely.',
        403,
      );
    }
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lockFile = `${this.file}.lock`;
    let lockHandle;
    let operationCommitted = false;
    try {
      try {
        lockHandle = this.fs.openSync(lockFile, 'wx', 0o600);
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw new ThreadProtectionError(
            'PROTECTION_STORE_BUSY',
            'Task protection persistence is busy.',
            409,
          );
        }
        throw new ThreadProtectionError(
          'PROTECTION_STORE_UNAVAILABLE',
          'Task protection persistence is unavailable.',
          503,
        );
      }
      let current;
      try {
        current = readState(this.file, this.fs);
      } catch (error) {
        this.failure = error;
        throw error;
      }
      const currentIds = normalizeThreadIds(current.userProtectedThreadIds);
      const revision = Number(current.revision || 0);
      this.state = current;
      this.userThreadIds = new Set(currentIds);
      if (Object.hasOwn(mutationOptions, 'expectedRevision')
        && mutationOptions.expectedRevision !== revision) {
        throw new ThreadProtectionError(
          'PROTECTION_REVISION_CONFLICT',
          'Task protection revision is stale.',
          409,
          { expectedRevision: mutationOptions.expectedRevision, actualRevision: revision },
        );
      }
      const existed = currentIds.has(normalized) || this.permanentThreadIds.has(normalized);
      if (operation === 'protect') currentIds.add(normalized);
      else currentIds.delete(normalized);
      for (const permanent of this.permanentThreadIds) currentIds.delete(permanent);
      const changed = operation === 'protect' ? !existed : existed;
      const next = changed
        ? {
          schemaVersion: SCHEMA_VERSION,
          revision: revision + 1,
          userProtectedThreadIds: [...currentIds].sort(),
        }
        : current;
      if (changed) {
        try {
          writeStateAtomic(this.file, next, this.fs);
        } catch {
          throw new ThreadProtectionError(
            'PROTECTION_STORE_WRITE_FAILED',
            'Task protection persistence could not be updated.',
            503,
          );
        }
      }
      this.state = next;
      this.userThreadIds = normalizeThreadIds(next.userProtectedThreadIds);
      const response = { ...this.status(normalized), changed };
      operationCommitted = true;
      return response;
    } finally {
      if (lockHandle !== undefined) {
        let cleanupFailed = false;
        try {
          this.fs.closeSync(lockHandle);
        } catch {
          cleanupFailed = true;
        }
        try {
          this.fs.unlinkSync(lockFile);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') cleanupFailed = true;
        }
        if (cleanupFailed) {
          throw new ThreadProtectionError(
            'PROTECTION_STORE_CLEANUP_FAILED',
            'Task protection persistence cleanup failed.',
            503,
            { committed: operationCommitted },
          );
        }
      }
    }
  }
}

class DynamicProtectedThreadGuard extends ProtectedThreadGuard {
  constructor(options = {}) {
    super(options);
    if (!options.registry || typeof options.registry.isProtected !== 'function') {
      throw new TypeError('DynamicProtectedThreadGuard requires a protection registry.');
    }
    this.registry = options.registry;
  }

  isProtected(threadId) {
    return super.isProtected(threadId) || this.registry.isProtected(threadId);
  }
}

function createDynamicProtectedThreadGuard(options = {}) {
  return new DynamicProtectedThreadGuard(options);
}

module.exports = {
  DynamicProtectedThreadGuard,
  SCHEMA_VERSION,
  ThreadProtectionError,
  ThreadProtectionRegistry,
  createDynamicProtectedThreadGuard,
  emptyState,
  normalizeThreadId,
};
