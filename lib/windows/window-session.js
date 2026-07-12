'use strict';

const WINDOW_SHOW_STATES = Object.freeze({
  NORMAL: 'normal',
  MINIMIZED: 'minimized',
  MAXIMIZED: 'maximized',
});

function clonePlacement(value) {
  return value == null ? value : structuredClone(value);
}

function assertAdapter(adapter) {
  for (const method of [
    'getForegroundWindow',
    'getWindowPlacement',
    'setWindowPlacement',
    'activateWindow',
    'setForegroundWindow',
  ]) {
    if (!adapter || typeof adapter[method] !== 'function') {
      throw new TypeError(`Window session adapter requires ${method}().`);
    }
  }
}

class WindowSession {
  constructor(adapter, targetWindow) {
    assertAdapter(adapter);
    if (!targetWindow) throw new TypeError('WindowSession requires a target window.');
    this.adapter = adapter;
    this.targetWindow = targetWindow;
    this.originalForegroundWindow = adapter.getForegroundWindow();
    this.originalTargetPlacement = clonePlacement(adapter.getWindowPlacement(targetWindow));
    if (!this.originalTargetPlacement) {
      throw new TypeError('WindowSession could not capture target window placement.');
    }
    this.activated = false;
    this.restoreResult = null;
  }

  activate() {
    if (this.restoreResult) throw new Error('A restored window session cannot be activated again.');
    this.activated = true;
    return this.adapter.activateWindow(this.targetWindow);
  }

  restore() {
    if (this.restoreResult) return { ...this.restoreResult };
    const restoreErrors = [];
    let currentForeground = null;
    let foregroundObserved = true;
    try {
      currentForeground = this.adapter.getForegroundWindow();
    } catch {
      foregroundObserved = false;
      restoreErrors.push('foreground-capture');
    }
    const userFocusChanged = this.activated && (
      !foregroundObserved
      || (
        currentForeground !== this.targetWindow
        && currentForeground !== this.originalForegroundWindow
      )
    );

    let targetPlacementRestored = false;
    try {
      targetPlacementRestored = this.adapter.setWindowPlacement(
        this.targetWindow,
        clonePlacement(this.originalTargetPlacement),
      ) !== false;
      if (!targetPlacementRestored) restoreErrors.push('target-placement');
    } catch {
      restoreErrors.push('target-placement');
    }
    let foregroundRestored = false;

    if (!userFocusChanged && this.originalForegroundWindow) {
      let originalStillExists = typeof this.adapter.isWindow !== 'function';
      try {
        originalStillExists = originalStillExists
          || this.adapter.isWindow(this.originalForegroundWindow);
      } catch {
        restoreErrors.push('foreground-validity');
      }
      if (originalStillExists) {
        if (currentForeground === this.originalForegroundWindow) {
          foregroundRestored = true;
        } else {
          try {
            foregroundRestored = this.adapter.setForegroundWindow(this.originalForegroundWindow) !== false;
          } catch {
            foregroundRestored = false;
          }
        }
        if (!foregroundRestored) {
          restoreErrors.push('foreground');
        }
      } else {
        restoreErrors.push('foreground-missing');
      }
    }

    this.restoreResult = {
      targetPlacementRestored,
      foregroundRestored,
      userFocusChanged,
    };
    if (restoreErrors.length > 0) {
      this.restoreResult.restoreErrors = [...restoreErrors];
    }
    return {
      ...this.restoreResult,
      ...(this.restoreResult.restoreErrors
        ? { restoreErrors: [...this.restoreResult.restoreErrors] }
        : {}),
    };
  }
}

function captureWindowSession(adapter, targetWindow) {
  return new WindowSession(adapter, targetWindow);
}

module.exports = {
  WINDOW_SHOW_STATES,
  WindowSession,
  captureWindowSession,
};
