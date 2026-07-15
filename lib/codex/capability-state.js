'use strict';

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function capabilityState(options = {}) {
  const available = Boolean(options.methodPresent);
  const ready = Boolean(available && options.runtimeReady);
  return {
    available,
    ready,
    confirmed: Boolean(options.confirmed),
    readbackSupported: Boolean(options.readbackSupported),
    source: String(options.source || 'unknown'),
    reason: options.reason ?? (!available
      ? 'method_missing'
      : (!ready ? 'runtime_not_ready' : null)),
  };
}

function startedThreadId(response) {
  return String(response && (
    response.threadId
    || (response.thread && response.thread.id)
    || response.id
  ) || '').trim();
}

function startedTurnId(response) {
  return String(response && (
    response.turnId
    || (response.turn && response.turn.id)
    || response.id
  ) || '').trim();
}

function completePreset(row) {
  const value = row && typeof row === 'object' && row.value && typeof row.value === 'object'
    ? row.value
    : row;
  return Boolean(value
    && typeof value.mode === 'string'
    && value.mode.trim()
    && value.settings
    && typeof value.settings === 'object'
    && !Array.isArray(value.settings));
}

function validateCollaborationCatalog(catalog) {
  const rows = catalog && Array.isArray(catalog.data)
    ? catalog.data
    : (Array.isArray(catalog) ? catalog : null);
  if (!rows) {
    throw new TypeError('Collaboration presets require both mode and settings.');
  }
  const completeRows = rows.filter(completePreset);
  return Array.isArray(catalog)
    ? completeRows
    : { ...catalog, data: completeRows };
}

function unavailable(operation, reason) {
  return { status: 'unavailable', operation, reason };
}

function createConfirmedControls(service) {
  if (!service || typeof service !== 'object') {
    throw new TypeError('Confirmed controls require a Codex service.');
  }
  const controls = Object.create(service);

  controls.startThread = async (params = {}, control = {}) => {
    if (typeof service.startThread !== 'function' || typeof service.readThread !== 'function') {
      return unavailable('thread.start', 'method_missing');
    }
    const started = await service.startThread(params, control);
    const threadId = startedThreadId(started);
    if (!threadId) {
      return {
        status: 'uncertain',
        operation: 'thread.start',
        reason: 'thread_id_missing',
      };
    }
    try {
      const observed = await service.readThread({ threadId, includeTurns: false });
      if (startedThreadId(observed) !== threadId) {
        return {
          status: 'uncertain',
          operation: 'thread.start',
          reason: 'thread_readback_mismatch',
          observation: { threadId },
        };
      }
      return {
        status: 'confirmed',
        operation: 'thread.start',
        observation: { threadId },
      };
    } catch {
      return {
        status: 'uncertain',
        operation: 'thread.start',
        reason: 'thread_readback_failed',
        observation: { threadId },
      };
    }
  };

  controls.updateThreadSettings = async (params = {}, control = {}) => {
    if (typeof service.updateThreadSettings !== 'function') {
      return unavailable('thread.settings', 'method_missing');
    }
    await service.updateThreadSettings(params, control);
    const settings = copy(params) || {};
    delete settings.threadId;
    return {
      status: 'confirmed',
      operation: 'thread.settings',
      observation: {
        source: 'confirmedRequest',
        readbackSupported: false,
        settings,
      },
    };
  };

  controls.startTurn = async (params = {}, control = {}) => {
    if (typeof service.startTurn !== 'function') return unavailable('turn.start', 'method_missing');
    const started = await service.startTurn(params, control);
    const turnId = startedTurnId(started);
    return {
      status: turnId ? 'confirmed' : 'uncertain',
      operation: 'turn.start',
      ...(turnId
        ? { observation: { turnId } }
        : { reason: 'turn_id_missing' }),
    };
  };

  for (const [method, operation] of [
    ['steerTurn', 'turn.steer'],
    ['interruptTurn', 'turn.interrupt'],
  ]) {
    controls[method] = async (params = {}, control = {}) => {
      if (typeof service[method] !== 'function') return unavailable(operation, 'method_missing');
      const observation = await service[method](params, control);
      return {
        status: 'confirmed',
        operation,
        ...(observation === undefined ? {} : { observation: copy(observation) }),
      };
    };
  }

  if (typeof service.listCollaborationModes === 'function') {
    controls.listCollaborationModes = async () => validateCollaborationCatalog(
      await service.listCollaborationModes(),
    );
  }

  return controls;
}

module.exports = {
  capabilityState,
  createConfirmedControls,
  startedTurnId,
  startedThreadId,
  validateCollaborationCatalog,
};
