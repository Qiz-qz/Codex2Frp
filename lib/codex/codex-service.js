'use strict';

const path = require('node:path');
const { REQUEST_METHODS } = require('../app-server/methods');
const {
  validateInitializeResponse,
  validateSchemaProfile,
} = require('../app-server/schema-profile');
const { CommandCoordinator } = require('../control/command-coordinator');
const { AppServerCompatibilityError } = require('./errors');

const ERROR_KINDS = Object.freeze({
  CONFLICT: 'conflict',
  FORBIDDEN: 'forbidden',
  INCOMPATIBLE: 'incompatible',
  INVALID_REQUEST: 'invalidRequest',
  NOT_FOUND: 'notFound',
  PROTOCOL: 'protocol',
  REMOTE: 'remote',
  TIMEOUT: 'timeout',
  UNAUTHORIZED: 'unauthorized',
  UNCERTAIN: 'uncertain',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

const INITIALIZE_FIELDS = Object.freeze(['clientInfo', 'capabilities']);
const THREAD_LIST_FIELDS = Object.freeze([
  'ancestorThreadId',
  'archived',
  'cursor',
  'cwd',
  'limit',
  'modelProviders',
  'parentThreadId',
  'searchTerm',
  'sortDirection',
  'sortKey',
  'sourceKinds',
  'useStateDbOnly',
]);
const THREAD_READ_FIELDS = Object.freeze(['threadId', 'includeTurns']);
const THREAD_TURNS_LIST_FIELDS = Object.freeze([
  'threadId',
  'cursor',
  'limit',
  'sortDirection',
  'itemsView',
]);
const THREAD_CONFIGURATION_FIELDS = Object.freeze([
  'allowProviderModelFallback',
  'approvalPolicy',
  'approvalsReviewer',
  'baseInstructions',
  'config',
  'cwd',
  'developerInstructions',
  'dynamicTools',
  'environments',
  'ephemeral',
  'experimentalRawEvents',
  'historyMode',
  'mockExperimentalField',
  'model',
  'modelProvider',
  'multiAgentMode',
  'permissions',
  'personality',
  'runtimeWorkspaceRoots',
  'sandbox',
  'selectedCapabilityRoots',
  'serviceName',
  'serviceTier',
  'sessionStartSource',
  'threadSource',
]);
const THREAD_RESUME_FIELDS = Object.freeze([
  'threadId',
  'approvalPolicy',
  'approvalsReviewer',
  'baseInstructions',
  'config',
  'cwd',
  'developerInstructions',
  'excludeTurns',
  'history',
  'initialTurnsPage',
  'model',
  'modelProvider',
  'path',
  'permissions',
  'personality',
  'runtimeWorkspaceRoots',
  'sandbox',
  'serviceTier',
]);
const THREAD_FORK_FIELDS = Object.freeze([
  'threadId',
  'approvalPolicy',
  'approvalsReviewer',
  'baseInstructions',
  'config',
  'cwd',
  'developerInstructions',
  'ephemeral',
  'excludeTurns',
  'lastTurnId',
  'model',
  'modelProvider',
  'path',
  'permissions',
  'runtimeWorkspaceRoots',
  'sandbox',
  'serviceTier',
  'threadSource',
]);
const THREAD_SETTINGS_FIELDS = Object.freeze([
  'threadId',
  'approvalPolicy',
  'approvalsReviewer',
  'collaborationMode',
  'cwd',
  'effort',
  'model',
  'multiAgentMode',
  'permissions',
  'personality',
  'sandboxPolicy',
  'serviceTier',
  'summary',
]);
const TURN_START_FIELDS = Object.freeze([
  'threadId',
  'input',
  'additionalContext',
  'approvalPolicy',
  'approvalsReviewer',
  'clientUserMessageId',
  'collaborationMode',
  'cwd',
  'effort',
  'environments',
  'model',
  'multiAgentMode',
  'outputSchema',
  'permissions',
  'personality',
  'responsesapiClientMetadata',
  'runtimeWorkspaceRoots',
  'sandboxPolicy',
  'serviceTier',
  'summary',
]);
const TURN_STEER_FIELDS = Object.freeze([
  'threadId',
  'expectedTurnId',
  'input',
  'additionalContext',
  'clientUserMessageId',
  'responsesapiClientMetadata',
]);
const MODEL_LIST_FIELDS = Object.freeze(['cursor', 'limit', 'includeHidden']);
const CONTROL_FIELDS = Object.freeze([
  'observedThreadId',
  'desktopThreadId',
  'requireObservedTargetMatch',
]);

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pickDefined(source, fields) {
  const input = objectOrEmpty(source);
  const result = {};
  for (const field of fields) {
    if (input[field] !== undefined) result[field] = input[field];
  }
  return result;
}

function normalizeThreadId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function targetParams(value, options = {}) {
  if (typeof value === 'string') {
    return { ...objectOrEmpty(options), threadId: value };
  }
  return objectOrEmpty(value);
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || '');
  }
}

function errorText(error) {
  return stableStringify({
    message: error && error.message,
    details: error && error.details,
    rpcData: error && error.rpcData,
  }).toLowerCase();
}

function rpcCodeFor(error) {
  const candidates = [
    error && error.rpcCode,
    error && error.rpcError && error.rpcError.code,
    error && error.details && error.details.rpcError && error.details.rpcError.code,
  ];
  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function classification(kind, error, options = {}) {
  return {
    kind,
    code: String((error && error.code) || 'UNKNOWN'),
    rpcCode: rpcCodeFor(error),
    retryable: options.retryable === true,
    uncertain: options.uncertain === true,
  };
}

function classifyCodexServiceError(error, options = {}) {
  const code = String((error && error.code) || '');
  const rpcCode = rpcCodeFor(error);
  const text = errorText(error);
  const mutation = options.mutation === true;

  if (code === 'PROTECTED_THREAD') {
    return classification(ERROR_KINDS.FORBIDDEN, error);
  }
  if ([
    'TARGET_THREAD_REQUIRED',
    'THREAD_TARGET_MISMATCH',
    'THREAD_NOT_ALLOWLISTED',
    'UNKNOWN_MUTATION_ACTION',
  ].includes(code)) {
    return classification(ERROR_KINDS.CONFLICT, error);
  }
  if (code === 'APP_SERVER_RPC_TIMEOUT' || code === 'DESKTOP_RPC_TIMEOUT') {
    return mutation
      ? classification(ERROR_KINDS.UNCERTAIN, error, { uncertain: true })
      : classification(ERROR_KINDS.TIMEOUT, error, { retryable: true });
  }
  if (code === 'APP_SERVER_EXITED' || code === 'APP_SERVER_CONNECTION_CLOSED'
    || code === 'DESKTOP_INTERNAL_RPC_UNAVAILABLE'
    || code === 'DESKTOP_BRIDGE_SEND_FAILED') {
    return mutation
      ? classification(ERROR_KINDS.UNCERTAIN, error, { uncertain: true })
      : classification(ERROR_KINDS.UNAVAILABLE, error, { retryable: true });
  }
  if (code === 'DESKTOP_BRIDGE_UNAVAILABLE') {
    return classification(ERROR_KINDS.UNAVAILABLE, error, { retryable: true });
  }
  if (code === 'APP_SERVER_PROTOCOL_ERROR') {
    return classification(ERROR_KINDS.PROTOCOL, error);
  }
  if (code.startsWith('APP_SERVER_') && (
    code.includes('PROFILE')
    || code.includes('SCHEMA')
    || code.includes('INITIALIZE')
    || code.includes('CODEX_HOME')
    || code.includes('PLATFORM')
    || code.includes('USER_AGENT')
  )) {
    return classification(ERROR_KINDS.INCOMPATIBLE, error);
  }
  if (code === 'CAPABILITY_UNAVAILABLE' || rpcCode === -32601) {
    return classification(ERROR_KINDS.UNAVAILABLE, error);
  }
  if (text.includes('activeturnnotsteerable')
    || text.includes('active turn not steerable')
    || text.includes('expectedturnid')
    || text.includes('expected turn')
    || text.includes('turn mismatch')) {
    return classification(ERROR_KINDS.CONFLICT, error);
  }
  if (rpcCode === -32602 || rpcCode === -32600 || rpcCode === -32700) {
    return classification(ERROR_KINDS.INVALID_REQUEST, error);
  }
  if (mutation && code === 'APP_SERVER_RPC_ERROR'
    && text.includes('failed to read unarchived thread')) {
    return classification(ERROR_KINDS.UNCERTAIN, error, { uncertain: true });
  }
  if (text.includes('not found')) {
    return classification(ERROR_KINDS.NOT_FOUND, error);
  }
  if (text.includes('unauthorized') || text.includes('forbidden')) {
    return classification(ERROR_KINDS.UNAUTHORIZED, error);
  }
  if (code === 'APP_SERVER_RPC_ERROR') {
    return classification(ERROR_KINDS.REMOTE, error);
  }
  return classification(ERROR_KINDS.UNKNOWN, error);
}

function invalidCodexHome(codexHome) {
  return new AppServerCompatibilityError(
    'APP_SERVER_CODEX_HOME_INVALID',
    'Configured CODEX_HOME must be an absolute Windows path.',
    { codexHome: String(codexHome || '') },
  );
}

class CodexService {
  constructor(options = {}) {
    if (!options.rpcClient || typeof options.rpcClient.request !== 'function') {
      throw new TypeError('CodexService requires a JsonlRpcClient-compatible rpcClient.');
    }
    this.rpcClient = options.rpcClient;
    this.schemaProfile = validateSchemaProfile(options.schemaProfile || options.profile);
    this.codexHome = String(options.codexHome || '').trim();

    if (options.commandCoordinator) {
      if (typeof options.commandCoordinator.run !== 'function') {
        throw new TypeError('CodexService commandCoordinator must expose run(context, operation).');
      }
      this.commandCoordinator = options.commandCoordinator;
    } else {
      const guard = options.protectedThreadGuard || options.guard;
      if (!guard || typeof guard.assertAllowed !== 'function') {
        throw new TypeError('CodexService mutations require a CommandCoordinator or protected thread guard.');
      }
      this.commandCoordinator = new CommandCoordinator({ guard });
    }
  }

  async initialize(params = {}) {
    if (!path.win32.isAbsolute(this.codexHome)) throw invalidCodexHome(this.codexHome);
    const response = await this.rpcClient.request(
      REQUEST_METHODS.INITIALIZE,
      pickDefined(params, INITIALIZE_FIELDS),
    );
    const validated = validateInitializeResponse(response, {
      profile: this.schemaProfile,
      expectedCodexHome: this.codexHome,
    });
    if (typeof this.rpcClient.notify !== 'function') {
      throw new TypeError('CodexService initialize requires rpcClient.notify().');
    }
    this.rpcClient.notify('initialized');
    return validated;
  }

  listThreads(params = {}) {
    return this.rpcClient.request(REQUEST_METHODS.THREAD_LIST, pickDefined(params, THREAD_LIST_FIELDS));
  }

  readThread(threadOrParams, options = {}) {
    const params = targetParams(threadOrParams, options);
    return this.rpcClient.request(REQUEST_METHODS.THREAD_READ, pickDefined(params, THREAD_READ_FIELDS));
  }

  listThreadTurns(threadOrParams, options = {}) {
    const params = targetParams(threadOrParams, options);
    return this.rpcClient.request(
      REQUEST_METHODS.THREAD_TURNS_LIST,
      pickDefined(params, THREAD_TURNS_LIST_FIELDS),
    );
  }

  startThread(params = {}, control = {}) {
    return this._mutate(
      'thread.start',
      REQUEST_METHODS.THREAD_START,
      pickDefined(params, THREAD_CONFIGURATION_FIELDS),
      control,
    );
  }

  resumeThread(params, control = {}) {
    return this._mutate(
      'thread.resume',
      REQUEST_METHODS.THREAD_RESUME,
      pickDefined(params, THREAD_RESUME_FIELDS),
      control,
    );
  }

  forkThread(params, control = {}) {
    return this._mutate(
      'thread.fork',
      REQUEST_METHODS.THREAD_FORK,
      pickDefined(params, THREAD_FORK_FIELDS),
      control,
    );
  }

  archiveThread(threadOrParams, control = {}) {
    const params = targetParams(threadOrParams);
    return this._mutate(
      'thread.archive',
      REQUEST_METHODS.THREAD_ARCHIVE,
      pickDefined(params, ['threadId']),
      control,
    );
  }

  unarchiveThread(threadOrParams, control = {}) {
    const params = targetParams(threadOrParams);
    return this._mutate(
      'thread.unarchive',
      REQUEST_METHODS.THREAD_UNARCHIVE,
      pickDefined(params, ['threadId']),
      control,
    );
  }

  setThreadName(params, control = {}) {
    return this._mutate(
      'thread.rename',
      REQUEST_METHODS.THREAD_SET_NAME,
      pickDefined(params, ['threadId', 'name']),
      control,
    );
  }

  compactThread(threadOrParams, control = {}) {
    const params = targetParams(threadOrParams);
    return this._mutate(
      'thread.compact',
      REQUEST_METHODS.THREAD_COMPACT,
      pickDefined(params, ['threadId']),
      control,
    );
  }

  updateThreadSettings(params, control = {}) {
    return this._mutate(
      'thread.settings',
      REQUEST_METHODS.THREAD_SETTINGS_UPDATE,
      pickDefined(params, THREAD_SETTINGS_FIELDS),
      control,
    );
  }

  startTurn(params, control = {}) {
    return this._mutate(
      'turn.start',
      REQUEST_METHODS.TURN_START,
      pickDefined(params, TURN_START_FIELDS),
      control,
    );
  }

  interruptTurn(params, control = {}) {
    return this._mutate(
      'turn.interrupt',
      REQUEST_METHODS.TURN_INTERRUPT,
      pickDefined(params, ['threadId', 'turnId']),
      control,
    );
  }

  steerTurn(params, control = {}) {
    return this._mutate(
      'turn.steer',
      REQUEST_METHODS.TURN_STEER,
      pickDefined(params, TURN_STEER_FIELDS),
      control,
    );
  }

  listModels(params = {}) {
    return this.rpcClient.request(REQUEST_METHODS.MODEL_LIST, pickDefined(params, MODEL_LIST_FIELDS));
  }

  listCollaborationModes() {
    return this.rpcClient.request(REQUEST_METHODS.COLLABORATION_MODE_LIST, {});
  }

  _mutate(action, method, params, control = {}) {
    const context = {
      action,
      mode: 'rpc',
      threadId: normalizeThreadId(params.threadId),
      ...pickDefined(control, CONTROL_FIELDS),
    };
    if (Object.hasOwn(params, 'threadId')) params.threadId = context.threadId;
    return this.commandCoordinator.run(context, () => this.rpcClient.request(method, params));
  }
}

module.exports = {
  CodexService,
  ERROR_KINDS,
  classifyCodexServiceError,
};
