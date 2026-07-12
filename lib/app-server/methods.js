'use strict';

const REQUEST_METHODS = Object.freeze({
  INITIALIZE: 'initialize',
  THREAD_LIST: 'thread/list',
  THREAD_READ: 'thread/read',
  THREAD_TURNS_LIST: 'thread/turns/list',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_FORK: 'thread/fork',
  THREAD_ARCHIVE: 'thread/archive',
  THREAD_UNARCHIVE: 'thread/unarchive',
  THREAD_SET_NAME: 'thread/name/set',
  THREAD_COMPACT: 'thread/compact/start',
  THREAD_SETTINGS_UPDATE: 'thread/settings/update',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  TURN_STEER: 'turn/steer',
  MODEL_LIST: 'model/list',
  COLLABORATION_MODE_LIST: 'collaborationMode/list',
});

const NOTIFICATION_METHODS = Object.freeze({
  THREAD_STARTED: 'thread/started',
  THREAD_STATUS_CHANGED: 'thread/status/changed',
  THREAD_ARCHIVED: 'thread/archived',
  THREAD_UNARCHIVED: 'thread/unarchived',
  THREAD_NAME_UPDATED: 'thread/name/updated',
  THREAD_SETTINGS_UPDATED: 'thread/settings/updated',
  THREAD_COMPACTED: 'thread/compacted',
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  TURN_PLAN_UPDATED: 'turn/plan/updated',
  ITEM_STARTED: 'item/started',
  ITEM_COMPLETED: 'item/completed',
});

module.exports = {
  NOTIFICATION_METHODS,
  REQUEST_METHODS,
};
