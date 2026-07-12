'use strict';

const { CodexControlError } = require('../codex/errors');
const { discoverCodexWindow } = require('../windows/codex-window-discovery');
const { captureWindowSession } = require('../windows/window-session');

const EXPLICIT_UI_INTENT = Symbol('explicit-ui-intent');
const PROCESS_CONTROL_REPLACEMENT = Symbol('process-control-replacement');
const consumedIntents = new WeakSet();

class AsyncUiLock {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }
}

const GLOBAL_UI_ACTION_LOCK = new AsyncUiLock();

function uiError(code, message, details = {}, options = {}) {
  const error = new CodexControlError(code, message, details, options);
  if (Number.isInteger(options.statusCode)) error.statusCode = options.statusCode;
  return error;
}

class UiActionCircuitBreaker {
  constructor() {
    this.quarantine = null;
  }

  trip(details = {}) {
    if (!this.quarantine) this.quarantine = Object.freeze({ ...details });
    return this.quarantine;
  }

  assertClosed(context = {}) {
    if (!this.quarantine) return;
    throw uiError(
      'UI_ACTION_QUARANTINED',
      'UI automation is quarantined because a timed-out action did not settle.',
      {
        action: context.action,
        threadId: context.threadId,
        timeoutMs: this.quarantine.timeoutMs,
        timeoutGraceMs: this.quarantine.timeoutGraceMs,
      },
      { statusCode: 503 },
    );
  }
}

class UiSideEffectFence {
  constructor(signal) {
    this.signal = signal;
  }

  assertAllowed() {
    if (!this.signal || this.signal.aborted !== true) return true;
    if (this.signal.reason instanceof Error) throw this.signal.reason;
    throw uiError('UI_ACTION_ABORTED', 'The UI side-effect capability was aborted.');
  }
}

const GLOBAL_UI_ACTION_CIRCUIT_BREAKER = new UiActionCircuitBreaker();

function attachProcessControlReplacement(value, replacement = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Process control replacement metadata requires an object result.');
  }
  const handle = replacement.handle == null ? '' : String(replacement.handle).trim();
  const processId = Number(replacement.processId);
  if (!handle && (!Number.isSafeInteger(processId) || processId <= 0)) {
    throw new TypeError('Process control replacement requires a handle or processId.');
  }
  Object.defineProperty(value, PROCESS_CONTROL_REPLACEMENT, {
    value: Object.freeze({
      ...(handle ? { handle } : {}),
      ...(Number.isSafeInteger(processId) && processId > 0 ? { processId } : {}),
    }),
    enumerable: false,
  });
  return value;
}

function normalizedObservedThread(value) {
  if (typeof value === 'string') return value.trim();
  return value && typeof value.threadId === 'string' ? value.threadId.trim() : '';
}

async function lockedGuardContext(context, resolveObservedThread) {
  if (typeof resolveObservedThread !== 'function') return { ...context, mode: 'ui' };
  const observedThreadId = normalizedObservedThread(await resolveObservedThread(context));
  return {
    ...context,
    mode: 'ui',
    observedThreadId,
    desktopThreadId: observedThreadId,
  };
}

async function readyGuardContext(context, resolveObservedThread, options = {}) {
  if (typeof resolveObservedThread !== 'function') return { ...context, mode: 'ui' };
  const timeoutMs = Math.min(2000, Math.max(0, Number(options.timeoutMs) || 0));
  const intervalMs = Math.min(250, Math.max(10, Number(options.intervalMs) || 50));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const startedAt = now();
  let first = true;
  while (true) {
    if (!first && now() - startedAt >= timeoutMs) {
      throw uiError('UI_ACTIVE_THREAD_UNKNOWN', 'The active Codex task did not become ready in time.', { action: context.action });
    }
    first = false;
    try {
      const ready = await lockedGuardContext(context, resolveObservedThread);
      if (ready.observedThreadId) return ready;
    } catch (error) {
      if (!error || error.code !== 'UI_ACTIVE_THREAD_UNKNOWN') throw error;
    }
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      throw uiError('UI_ACTIVE_THREAD_UNKNOWN', 'The active Codex task did not become ready in time.', { action: context.action });
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}

function createExplicitUiIntent(options = {}) {
  const id = String(options.id || '').trim();
  const action = String(options.action || '').trim();
  const threadId = String(options.threadId || '').trim();
  if (!id || !action || !threadId) {
    throw new TypeError('Explicit UI intent requires id, action, and threadId.');
  }
  return Object.freeze({
    id,
    action,
    threadId,
    [EXPLICIT_UI_INTENT]: true,
  });
}

function consumeExplicitUiIntent(intent, context) {
  if (!intent || intent[EXPLICIT_UI_INTENT] !== true) {
    throw uiError(
      'UI_EXPLICIT_INTENT_REQUIRED',
      'UI actions require a server-issued explicit user intent.',
      { action: context.action, threadId: context.threadId },
    );
  }
  if (consumedIntents.has(intent)) {
    throw uiError(
      'UI_EXPLICIT_INTENT_CONSUMED',
      'Explicit UI intent has already been consumed.',
      { intentId: intent.id, action: context.action, threadId: context.threadId },
    );
  }
  if (intent.action !== context.action || intent.threadId !== context.threadId) {
    throw uiError(
      'UI_EXPLICIT_INTENT_MISMATCH',
      'Explicit UI intent does not match the requested action target.',
      { intentId: intent.id, action: context.action, threadId: context.threadId },
    );
  }
  consumedIntents.add(intent);
  return intent;
}

async function runWithTimeout(operation, timeoutMs, controller, details, options = {}) {
  let timer;
  let timedOut = false;
  const timeoutError = uiError(
    'UI_ACTION_TIMEOUT',
    'Explicit UI action timed out.',
    { ...details, timeoutMs },
  );
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (!timedOut) throw error;
    const timeoutGraceMs = Number(options.timeoutGraceMs) >= 0
      ? Number(options.timeoutGraceMs)
      : 1000;
    let graceTimer;
    const settlement = await Promise.race([
      operationPromise.then(
        value => ({ settled: true, fulfilled: true, value }),
        () => ({ settled: true, fulfilled: false }),
      ),
      new Promise(resolve => {
        graceTimer = setTimeout(() => resolve({ settled: false }), timeoutGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    if (settlement.fulfilled) {
      Object.defineProperty(timeoutError, 'settledValue', {
        value: settlement.value,
        enumerable: false,
      });
    }
    if (!settlement.settled && typeof options.onQuarantine === 'function') {
      options.onQuarantine({ ...details, timeoutMs, timeoutGraceMs });
    }
    throw timeoutError;
  } finally {
    clearTimeout(timer);
  }
}

class UiActionTransaction {
  constructor(options = {}) {
    if (!options.adapter) throw new TypeError('UiActionTransaction requires a Win32 adapter.');
    if (!options.guard || typeof options.guard.assertAllowed !== 'function') {
      throw new TypeError('UiActionTransaction requires a protected thread guard.');
    }
    this.adapter = options.adapter;
    this.guard = options.guard;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
    this.timeoutGraceMs = Number(options.timeoutGraceMs) >= 0 ? Number(options.timeoutGraceMs) : 1000;
    this.discoverWindow = options.discoverWindow || discoverCodexWindow;
    this.resolveObservedThread = options.resolveObservedThread;
    this.observedThreadReadyTimeoutMs = Math.min(2000, Math.max(0,
      Number(options.observedThreadReadyTimeoutMs) || 2000));
    this.observedThreadPollIntervalMs = Math.min(250, Math.max(10,
      Number(options.observedThreadPollIntervalMs) || 50));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.sleep = options.sleep;
    this.circuitBreaker = options.circuitBreaker || GLOBAL_UI_ACTION_CIRCUIT_BREAKER;
  }

  async run(context = {}, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('UiActionTransaction.run requires an operation.');
    }
    this.circuitBreaker.assertClosed(context);
    if (context.background === true) {
      throw uiError(
        'UI_BACKGROUND_ACTION_FORBIDDEN',
        'Background actions cannot enter an explicit UI transaction.',
        { action: context.action, threadId: context.threadId },
      );
    }

    consumeExplicitUiIntent(context.intent, context);
    const readOnly = context.access === 'readOnly';
    if (!readOnly) {
      const guardContext = { ...context, mode: 'ui' };
      this.guard.assertAllowed(guardContext);
    }

    return GLOBAL_UI_ACTION_LOCK.run(async () => {
      this.circuitBreaker.assertClosed(context);
      const targetWindow = this.discoverWindow(this.adapter);
      if (!targetWindow || !targetWindow.handle) {
        throw uiError(
          'CODEX_WINDOW_NOT_FOUND',
          'No supported Codex desktop window is available for the explicit UI action.',
          { action: context.action, threadId: context.threadId },
        );
      }

      const session = captureWindowSession(this.adapter, targetWindow.handle);
      const controller = new AbortController();
      const fence = new UiSideEffectFence(controller.signal);
      let result;
      let operationError = null;
      try {
        const activated = session.activate();
        if (activated === false) {
          throw uiError(
            'UI_WINDOW_ACTIVATION_FAILED',
            'Codex could not be activated for the explicit UI action.',
            { action: context.action, threadId: context.threadId },
          );
        }
        if (!readOnly) {
          let currentGuardContext = await readyGuardContext(context, this.resolveObservedThread, {
            timeoutMs: this.observedThreadReadyTimeoutMs,
            intervalMs: this.observedThreadPollIntervalMs,
            now: this.now,
            sleep: this.sleep,
          });
          if (context.resolveTargetFromObserved === true) {
            if (!currentGuardContext.observedThreadId) {
              throw uiError(
                'UI_ACTIVE_THREAD_UNKNOWN',
                'The active Codex task could not be verified safely.',
                { action: context.action },
              );
            }
            currentGuardContext = {
              ...currentGuardContext,
              threadId: currentGuardContext.observedThreadId,
              requireObservedTargetMatch: true,
            };
          }
          this.guard.assertAllowed(currentGuardContext);
        }
        const timeoutMs = Number(context.timeoutMs) > 0
          ? Number(context.timeoutMs)
          : this.timeoutMs;
        result = await runWithTimeout(
          () => operation({
            window: targetWindow,
            signal: controller.signal,
            fence,
            intent: context.intent,
          }),
          timeoutMs,
          controller,
          { action: context.action, threadId: context.threadId },
          {
            timeoutGraceMs: this.timeoutGraceMs,
            onQuarantine: details => this.circuitBreaker.trip(details),
          },
        );
      } catch (error) {
        if (Object.hasOwn(error, 'settledValue')) result = error.settledValue;
        operationError = error;
      }

      const restoreResult = session.restore();
      const foregroundRestoreRequired = Boolean(session.originalForegroundWindow)
        && !restoreResult.userFocusChanged;
      if ((restoreResult.restoreErrors && restoreResult.restoreErrors.length > 0)
        || !restoreResult.targetPlacementRestored
        || (foregroundRestoreRequired && !restoreResult.foregroundRestored)) {
        throw uiError(
          'UI_STATE_RESTORE_FAILED',
          'The explicit UI action finished, but the original window state could not be fully restored.',
          {
            action: context.action,
            threadId: context.threadId,
            targetPlacementRestored: restoreResult.targetPlacementRestored,
            foregroundRestored: restoreResult.foregroundRestored,
            userFocusChanged: restoreResult.userFocusChanged,
            restoreErrors: restoreResult.restoreErrors,
          },
          operationError ? { cause: operationError } : {},
        );
      }
      if (operationError) throw operationError;
      return result;
    });
  }
}

class ExplicitProcessControlTransaction {
  constructor(options = {}) {
    if (!options.adapter) throw new TypeError('ExplicitProcessControlTransaction requires a Win32 adapter.');
    if (!options.guard || typeof options.guard.assertAllowed !== 'function') {
      throw new TypeError('ExplicitProcessControlTransaction requires a protected thread guard.');
    }
    this.adapter = options.adapter;
    this.guard = options.guard;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
    this.timeoutGraceMs = Number(options.timeoutGraceMs) >= 0 ? Number(options.timeoutGraceMs) : 1000;
    this.discoverWindow = options.discoverWindow || discoverCodexWindow;
    this.resolveObservedThread = options.resolveObservedThread;
    this.circuitBreaker = options.circuitBreaker || GLOBAL_UI_ACTION_CIRCUIT_BREAKER;
  }

  async run(context = {}, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('ExplicitProcessControlTransaction.run requires an operation.');
    }
    this.circuitBreaker.assertClosed(context);
    if (context.background === true) {
      throw uiError(
        'UI_BACKGROUND_ACTION_FORBIDDEN',
        'Background actions cannot enter an explicit process control transaction.',
        { action: context.action, threadId: context.threadId },
      );
    }

    consumeExplicitUiIntent(context.intent, context);
    const guardContext = { ...context, mode: 'ui' };
    this.guard.assertAllowed(guardContext);

    return GLOBAL_UI_ACTION_LOCK.run(async () => {
      this.circuitBreaker.assertClosed(context);
      const currentGuardContext = await lockedGuardContext(context, this.resolveObservedThread);
      this.guard.assertAllowed(currentGuardContext);
      const beforeWindow = this.discoverWindow(this.adapter);
      if (!beforeWindow || !beforeWindow.handle) {
        throw uiError(
          'CODEX_WINDOW_NOT_FOUND',
          'No supported Codex desktop window is available for explicit process control.',
          { action: context.action, threadId: context.threadId },
        );
      }
      const beforeHandle = beforeWindow.handle;
      const originalForegroundWindow = this.adapter.getForegroundWindow();
      const originalTargetPlacement = structuredClone(
        this.adapter.getWindowPlacement(beforeHandle),
      );
      if (!originalTargetPlacement) {
        throw uiError(
          'UI_PROCESS_CONTROL_CAPTURE_FAILED',
          'Codex window state could not be captured for explicit process control.',
          { action: context.action, threadId: context.threadId },
        );
      }

      const controller = new AbortController();
      const fence = new UiSideEffectFence(controller.signal);
      let value;
      let operationError = null;
      try {
        const timeoutMs = Number(context.timeoutMs) > 0
          ? Number(context.timeoutMs)
          : this.timeoutMs;
        value = await runWithTimeout(
          () => operation({
            window: beforeWindow,
            signal: controller.signal,
            fence,
            intent: context.intent,
          }),
          timeoutMs,
          controller,
          { action: context.action, threadId: context.threadId },
          {
            timeoutGraceMs: this.timeoutGraceMs,
            onQuarantine: details => this.circuitBreaker.trip(details),
          },
        );
      } catch (error) {
        if (Object.hasOwn(error, 'settledValue')) value = error.settledValue;
        operationError = error;
      }

      const restoreErrors = [];
      let afterWindow = null;
      try {
        const windows = this.adapter.listTopLevelWindows() || [];
        const replacement = value && value[PROCESS_CONTROL_REPLACEMENT];
        const candidates = replacement
          ? windows.filter(window => (
            (!replacement.handle || String(window && window.handle) === replacement.handle)
            && (!replacement.processId || Number(window && window.processId) === replacement.processId)
          ))
          : windows.filter(window => (
            String(window && window.handle) === String(beforeHandle)
            && (!beforeWindow.processId || Number(window && window.processId) === Number(beforeWindow.processId))
          ));
        afterWindow = this.discoverWindow({ listTopLevelWindows: () => candidates });
      } catch {}
      const afterHandle = afterWindow && afterWindow.handle;
      if (!afterHandle) restoreErrors.push('target-window');

      let currentForeground = null;
      let foregroundObserved = true;
      try {
        currentForeground = this.adapter.getForegroundWindow();
      } catch {
        foregroundObserved = false;
        restoreErrors.push('foreground-capture');
      }
      const userFocusChanged = !foregroundObserved || Boolean(
        currentForeground
        && currentForeground !== beforeHandle
        && currentForeground !== afterHandle
        && currentForeground !== originalForegroundWindow,
      );

      let targetPlacementRestored = false;
      if (afterHandle) {
        try {
          targetPlacementRestored = this.adapter.setWindowPlacement(
            afterHandle,
            structuredClone(originalTargetPlacement),
          ) !== false;
          if (!targetPlacementRestored) restoreErrors.push('target-placement');
        } catch {
          restoreErrors.push('target-placement');
        }
      }

      const desiredForeground = originalForegroundWindow === beforeHandle
        ? afterHandle
        : originalForegroundWindow;
      const foregroundRestoreRequired = Boolean(desiredForeground) && !userFocusChanged;
      let foregroundRestored = false;
      if (foregroundRestoreRequired) {
        let foregroundExists = typeof this.adapter.isWindow !== 'function';
        try {
          foregroundExists = foregroundExists || this.adapter.isWindow(desiredForeground);
        } catch {
          restoreErrors.push('foreground-validity');
        }
        if (foregroundExists) {
          if (currentForeground === desiredForeground) {
            foregroundRestored = true;
          } else {
            try {
              foregroundRestored = this.adapter.setForegroundWindow(desiredForeground) !== false;
            } catch {}
          }
          if (!foregroundRestored) restoreErrors.push('foreground');
        } else {
          restoreErrors.push('foreground-missing');
        }
      }

      const processControl = {
        targetRebound: Boolean(afterHandle && afterHandle !== beforeHandle),
        targetPlacementRestored,
        foregroundRestored,
        userFocusChanged,
      };
      if (restoreErrors.length > 0
        || !targetPlacementRestored
        || (foregroundRestoreRequired && !foregroundRestored)) {
        throw uiError(
          'UI_PROCESS_CONTROL_STATE_RESTORE_FAILED',
          'Explicit process control finished, but the replacement Codex window state could not be fully restored.',
          {
            action: context.action,
            threadId: context.threadId,
            ...processControl,
            restoreErrors,
          },
          operationError ? { cause: operationError } : {},
        );
      }
      if (operationError) throw operationError;
      return { value, processControl };
    });
  }
}

module.exports = {
  ExplicitProcessControlTransaction,
  GLOBAL_UI_ACTION_LOCK,
  UiActionCircuitBreaker,
  UiActionTransaction,
  attachProcessControlReplacement,
  createExplicitUiIntent,
};
