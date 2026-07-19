'use strict';

function createTurnState() {
  return {
    active: false,
    activeTurnId: '',
    activeUserCount: 0,
  };
}

function reduceTurnEvent(state, item = {}) {
  const current = state && typeof state === 'object' ? state : createTurnState();
  const payload = item.payload || {};
  const next = { ...current };

  if (item.type === 'turn_context' && payload.turn_id) {
    const turnId = String(payload.turn_id);
    if (turnId !== next.activeTurnId) next.activeUserCount = 0;
    next.activeTurnId = turnId;
    return next;
  }

  if (item.type !== 'event_msg') return next;
  if (payload.type === 'task_started') {
    const turnId = String(payload.turn_id || next.activeTurnId || '');
    if (turnId !== next.activeTurnId || next.active !== true) next.activeUserCount = 0;
    next.active = true;
    next.activeTurnId = turnId;
    return next;
  }
  if (payload.type === 'task_complete' || payload.type === 'task_failed' ||
    payload.type === 'task_interrupted' || payload.type === 'turn_aborted') {
    if (!payload.turn_id || !next.activeTurnId || String(payload.turn_id) === next.activeTurnId) {
      next.active = false;
      next.activeTurnId = '';
      next.activeUserCount = 0;
    }
  }
  return next;
}

function classifyUserDelivery(state, turnId = '') {
  if (!state || state.active !== true) return 'initial';
  const targetTurnId = String(turnId || '');
  if (targetTurnId && targetTurnId === state.activeTurnId) {
    return Number(state.activeUserCount) > 0 ? 'steer' : 'initial';
  }
  return 'queued';
}

function observeUserDelivery(state, turnId = '') {
  const current = state && typeof state === 'object' ? state : createTurnState();
  const targetTurnId = String(turnId || '');
  if (current.active !== true || !targetTurnId || targetTurnId !== current.activeTurnId) return current;
  return { ...current, activeUserCount: Math.max(0, Number(current.activeUserCount) || 0) + 1 };
}

module.exports = {
  classifyUserDelivery,
  createTurnState,
  observeUserDelivery,
  reduceTurnEvent,
};
