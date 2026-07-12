'use strict';

const crypto = require('node:crypto');

const REQUEST_KINDS = Object.freeze({
  'item/commandExecution/requestApproval': 'commandApproval',
  'item/fileChange/requestApproval': 'fileApproval',
  'item/permissions/requestApproval': 'permissionsApproval',
  'item/tool/requestUserInput': 'userInput',
  'mcpServer/elicitation/request': 'mcpElicitation',
  'item/tool/call': 'dynamicToolRequest',
});
const APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
const MCP_ACTIONS = new Set(['accept', 'decline', 'cancel']);
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const INTERNAL_FIELD_PATTERN = /^[A-Za-z0-9_.-]{1,256}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_PERMISSION_KINDS = new Map([
  ['network', 'network'],
  ['filesystem', 'filesystem'],
  ['fileSystem', 'filesystem'],
  ['computerUse', 'computerUse'],
  ['microphone', 'microphone'],
  ['camera', 'camera'],
  ['fullAccess', 'fullAccess'],
]);

class PendingRequestError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'PendingRequestError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = {};
  }
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeText(value, maxLength = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeInternalField(value) {
  const field = safeText(value, 256);
  return INTERNAL_FIELD_PATTERN.test(field) && !RESERVED_OBJECT_KEYS.has(field) ? field : '';
}

function assertOnlyKeys(value, allowed) {
  const object = objectOrNull(value);
  if (!object || Object.keys(object).some(key => !allowed.has(key))) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'The pending request response is invalid.',
    );
  }
  return object;
}

function approvalResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['decision']));
  const decision = String(response.decision || '');
  if (!APPROVAL_DECISIONS.has(decision) || (entry.allowedDecisions && !entry.allowedDecisions.has(decision))) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'Choose an allowed approval decision.',
    );
  }
  if (entry.kind !== 'permissionsApproval') return { decision };
  if (decision === 'decline' || decision === 'cancel') return { permissions: {}, scope: 'turn' };
  return {
    permissions: copy(entry.permissions),
    scope: decision === 'acceptForSession' ? 'session' : 'turn',
  };
}

function userInputResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['answers']));
  const answers = objectOrNull(response.answers);
  if (!answers) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'User input answers are required.',
    );
  }
  const result = {};
  for (const [handle, answerValues] of Object.entries(answers)) {
    const questionId = entry.fields.get(handle);
    if (!questionId || !Array.isArray(answerValues) || answerValues.length > 8
      || answerValues.some(answer => typeof answer !== 'string' || answer.length > 4000)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'User input answers do not match this request.',
      );
    }
    result[questionId] = { answers: [...answerValues] };
  }
  return { answers: result };
}

function validMcpValue(type, value) {
  if (type === 'string') return typeof value === 'string' && value.length <= 4000;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function mcpResult(entry, value) {
  const response = assertOnlyKeys(value, new Set(['action', 'values']));
  const action = String(response.action || '');
  if (!MCP_ACTIONS.has(action)) {
    throw new PendingRequestError(
      'PENDING_REQUEST_RESPONSE_INVALID',
      'Choose an allowed elicitation action.',
    );
  }
  if (action !== 'accept') {
    if (response.values !== undefined) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Declined elicitation cannot include values.',
      );
    }
    return { action };
  }
  const values = objectOrNull(response.values) || {};
  const content = {};
  for (const [handle, fieldValue] of Object.entries(values)) {
    const field = entry.fields.get(handle);
    if (!field || !validMcpValue(field.type, fieldValue)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Elicitation values do not match this request.',
      );
    }
    content[field.name] = fieldValue;
  }
  for (const field of entry.fields.values()) {
    if (field.required && !Object.hasOwn(content, field.name)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_RESPONSE_INVALID',
        'Required elicitation values are missing.',
      );
    }
  }
  return { action, content };
}

function dynamicToolResult(value) {
  const response = assertOnlyKeys(value, new Set(['contentItems', 'success']));
  if (typeof response.success !== 'boolean' || !Array.isArray(response.contentItems) || response.contentItems.length > 32) {
    throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
  }
  const contentItems = response.contentItems.map(itemValue => {
    const item = objectOrNull(itemValue);
    if (!item || (item.type !== 'inputText' && item.type !== 'inputImage')) {
      throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
    }
    const field = item.type === 'inputText' ? 'text' : 'imageUrl';
    assertOnlyKeys(item, new Set(['type', field]));
    const content = safeText(item[field], 64 * 1024);
    if (!content) throw new PendingRequestError('PENDING_REQUEST_RESPONSE_INVALID', 'The dynamic tool response is invalid.');
    return { type: item.type, [field]: content };
  });
  return { contentItems, success: response.success };
}

function cancellationResult(kind) {
  if (kind === 'dynamicToolRequest') return { contentItems: [], success: false };
  if (kind === 'mcpElicitation') return { action: 'cancel' };
  if (kind === 'userInput') return { answers: {} };
  if (kind === 'permissionsApproval') return { permissions: {}, scope: 'turn' };
  return { decision: 'cancel' };
}

function settleSilently(respond, result) {
  try {
    Promise.resolve(respond(result)).catch(() => {});
  } catch {}
}

class PendingRequestStore {
  constructor(options = {}) {
    this.ttlMs = Number.isSafeInteger(options.ttlMs)
      && options.ttlMs >= 1000 && options.ttlMs <= 30 * 60 * 1000
      ? options.ttlMs
      : 5 * 60 * 1000;
    this.maxEntries = Number.isSafeInteger(options.maxEntries)
      && options.maxEntries > 0 && options.maxEntries <= 512
      ? options.maxEntries
      : 64;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.createHandle = typeof options.createHandle === 'function'
      ? options.createHandle
      : () => crypto.randomBytes(24).toString('base64url');
    this.entries = new Map();
  }

  nowMs() {
    const value = this.now();
    const numeric = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
  }

  activeHandles() {
    const handles = new Set(this.entries.keys());
    for (const entry of this.entries.values()) {
      for (const handle of entry.fields.keys()) handles.add(handle);
    }
    return handles;
  }

  allocateHandle(reserved = []) {
    const active = this.activeHandles();
    for (const handle of reserved) active.add(handle);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const handle = String(this.createHandle() || '').trim();
      if (HANDLE_PATTERN.test(handle) && !active.has(handle)) return handle;
    }
    throw new PendingRequestError(
      'PENDING_REQUEST_HANDLE_UNAVAILABLE',
      'A pending request handle could not be created.',
      503,
    );
  }

  prune(nowMs = this.nowMs()) {
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.entries.delete(handle);
        settleSilently(entry.respond, cancellationResult(entry.kind));
      }
    }
  }

  capture(request = {}) {
    const method = String(request.method || '');
    const kind = REQUEST_KINDS[method];
    const params = objectOrNull(request.params);
    const threadId = safeText(params && params.threadId, 256);
    if (!kind || typeof request.respond !== 'function') return null;
    if (!params || !threadId) {
      settleSilently(request.respond, cancellationResult(kind));
      return null;
    }
    const nowMs = this.nowMs();
    this.prune(nowMs);
    if (this.entries.size >= this.maxEntries) {
      settleSilently(request.respond, cancellationResult(kind));
      return null;
    }

    const handle = this.allocateHandle();
    const fields = new Map();
    const dto = {
      handle,
      kind,
      state: 'pending',
      title: {
        commandApproval: '命令执行请求',
        fileApproval: '文件修改请求',
        permissionsApproval: '权限请求',
        userInput: '需要你的输入',
        mcpElicitation: 'MCP 请求输入',
      }[kind],
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
    };
    const entry = {
      handle,
      kind,
      method,
      threadId,
      fields,
      respond: request.respond,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      dto,
      permissions: {},
      allowedDecisions: null,
    };

    if (kind === 'commandApproval' || kind === 'fileApproval' || kind === 'permissionsApproval') {
      const advertised = Array.isArray(params.availableDecisions)
        ? params.availableDecisions.filter(decision => typeof decision === 'string' && APPROVAL_DECISIONS.has(decision))
        : [];
      dto.decisions = advertised.length > 0 ? [...new Set(advertised)] : [...APPROVAL_DECISIONS];
      entry.allowedDecisions = new Set(dto.decisions);
      if (kind === 'permissionsApproval') {
        entry.permissions = copy(objectOrNull(params.permissions) || {});
        dto.permissionKinds = [...new Set(Object.keys(entry.permissions)
          .map(key => SAFE_PERMISSION_KINDS.get(key))
          .filter(Boolean))];
      }
    } else if (kind === 'userInput') {
      const questions = Array.isArray(params.questions) ? params.questions.slice(0, 3) : [];
      const seenIds = new Set();
      dto.questions = [];
      for (const question of questions) {
        const raw = objectOrNull(question);
        const id = safeInternalField(raw && raw.id);
        const prompt = safeText(raw && raw.question, 2000);
        if (!id || !prompt || seenIds.has(id)) continue;
        seenIds.add(id);
        const fieldHandle = this.allocateHandle([handle, ...fields.keys()]);
        fields.set(fieldHandle, id);
        const publicQuestion = {
          handle: fieldHandle,
          header: safeText(raw.header, 120),
          question: prompt,
          options: (Array.isArray(raw.options) ? raw.options : []).slice(0, 3).map(option => ({
            label: safeText(option && option.label, 200),
            description: safeText(option && option.description, 500),
          })).filter(option => option.label),
        };
        dto.questions.push(publicQuestion);
      }
      if (dto.questions.length === 0) {
        settleSilently(request.respond, cancellationResult(kind));
        return null;
      }
    } else if (kind === 'mcpElicitation') {
      dto.message = safeText(params.message, 2000);
      dto.actions = [...MCP_ACTIONS];
      dto.fields = [];
      const schema = objectOrNull(params.requestedSchema)
        || objectOrNull(params.schema)
        || objectOrNull(objectOrNull(params.elicitation) && params.elicitation.schema);
      const properties = objectOrNull(schema && schema.properties) || {};
      const required = new Set(Array.isArray(schema && schema.required) ? schema.required.map(String) : []);
      for (const [name, definitionValue] of Object.entries(properties).slice(0, 20)) {
        const internalName = safeInternalField(name);
        const definition = objectOrNull(definitionValue);
        const type = String(definition && definition.type || '');
        if (!internalName || !['string', 'number', 'integer', 'boolean'].includes(type)) continue;
        const fieldHandle = this.allocateHandle([handle, ...fields.keys()]);
        const field = { name: internalName, type, required: required.has(name) };
        fields.set(fieldHandle, field);
        dto.fields.push({
          handle: fieldHandle,
          title: safeText(definition.title || name, 200),
          type,
          required: field.required,
        });
      }
    }

    this.entries.set(handle, entry);
    return copy(dto);
  }

  list(threadId) {
    const normalized = safeText(threadId, 256);
    this.prune();
    return [...this.entries.values()]
      .filter(entry => entry.threadId === normalized)
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .map(entry => copy(entry.dto));
  }

  requireEntry(threadId, handle) {
    this.prune();
    const entry = this.entries.get(String(handle || ''));
    if (!entry) {
      throw new PendingRequestError(
        'PENDING_REQUEST_NOT_FOUND',
        'The pending request is missing or expired.',
        404,
      );
    }
    if (entry.threadId !== safeText(threadId, 256)) {
      throw new PendingRequestError(
        'PENDING_REQUEST_THREAD_MISMATCH',
        'The pending request belongs to a different task.',
        409,
      );
    }
    return entry;
  }

  async respond(threadId, handle, value = {}) {
    const entry = this.requireEntry(threadId, handle);
    const result = entry.kind === 'userInput'
      ? userInputResult(entry, value)
      : entry.kind === 'mcpElicitation'
        ? mcpResult(entry, value)
        : entry.kind === 'dynamicToolRequest'
          ? dynamicToolResult(value)
          : approvalResult(entry, value);
    this.entries.delete(entry.handle);
    await entry.respond(result);
    return { handle: entry.handle, kind: entry.kind, state: 'resolved' };
  }
}

module.exports = {
  PendingRequestError,
  PendingRequestStore,
  REQUEST_KINDS,
};
