'use strict';

function createTurnState() {
  return {
    active: false,
    activeTurnId: '',
  };
}

function reduceTurnEvent(state, item = {}) {
  const current = state && typeof state === 'object' ? state : createTurnState();
  const payload = item.payload || {};
  const next = { ...current };

  if (item.type === 'turn_context' && payload.turn_id) {
    next.activeTurnId = String(payload.turn_id);
    return next;
  }

  if (item.type !== 'event_msg') return next;
  if (payload.type === 'task_started') {
    next.active = true;
    next.activeTurnId = String(payload.turn_id || next.activeTurnId || '');
    return next;
  }
  if (payload.type === 'task_complete' || payload.type === 'task_failed' ||
    payload.type === 'task_interrupted' || payload.type === 'turn_aborted') {
    if (!payload.turn_id || !next.activeTurnId || String(payload.turn_id) === next.activeTurnId) {
      next.active = false;
      next.activeTurnId = '';
    }
  }
  return next;
}

function classifyUserDelivery(state, turnId = '') {
  if (!state || state.active !== true) return 'initial';
  const targetTurnId = String(turnId || '');
  if (targetTurnId && targetTurnId === state.activeTurnId) return 'steer';
  return 'queued';
}

module.exports = {
  classifyUserDelivery,
  createTurnState,
  reduceTurnEvent,
};
