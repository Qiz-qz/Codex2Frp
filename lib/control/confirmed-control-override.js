'use strict';

const { modelInfoFromId } = require('../model-options');

const DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS = 15 * 60 * 1000;

function clean(value) {
  return String(value || '').trim();
}

function matchingOverridesForThread(overrides = {}, threadId = '') {
  const requested = clean(threadId);
  return requested && clean(overrides.threadId) === requested ? overrides : {};
}

function mergeConfirmedControlOverrides(previous = {}, settings = {}, updatedAt = '') {
  const threadId = clean(settings.threadId);
  const sameThread = threadId && clean(previous.threadId) === threadId;
  const next = sameThread
    ? { ...previous }
    : { model: '', reasoning: '', speed: '', threadId };
  next.threadId = threadId;
  next.updatedAt = clean(updatedAt);
  if (clean(settings.model)) next.model = clean(settings.model);
  if (clean(settings.effort)) next.reasoning = clean(settings.effort);
  if (clean(settings.speed)) next.speed = clean(settings.speed);
  return next;
}

function overrideIsFresh(overrides = {}, parsedUpdatedAt = '', options = {}) {
  const overrideMs = Date.parse(overrides.updatedAt || '');
  const parsedMs = Date.parse(parsedUpdatedAt || '');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, options.maxAgeMs)
    : DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS;
  if (!Number.isFinite(overrideMs) || overrideMs > now + 60_000 || now - overrideMs > maxAgeMs) return false;
  return !Number.isFinite(parsedMs) || overrideMs >= parsedMs;
}

function exactOption(options = [], target = '', fields = []) {
  const wanted = clean(target);
  if (!wanted) return null;
  return (Array.isArray(options) ? options : []).find(option => option && fields.some(field => clean(option[field]) === wanted)) || null;
}

function confirmedModelOverride(overrides = {}, options = {}) {
  if (!overrides.model || !overrideIsFresh(overrides, options.parsedUpdatedAt, options)) return null;
  const liveOptions = options.liveModeOptions && Array.isArray(options.liveModeOptions.modelOptions)
    ? options.liveModeOptions.modelOptions
    : [];
  const live = exactOption(liveOptions, overrides.model, ['id', 'key']);
  const info = modelInfoFromId(
    overrides.model,
    live ? [live] : (Array.isArray(options.catalogOptions) ? options.catalogOptions : []),
    overrides.updatedAt,
  );
  if (!info || info.available !== true) return null;
  return {
    ...info,
    source: 'confirmed-request',
    catalogSource: live ? clean(live.source) : clean(info.source),
    confirmedBy: 'desktopInternalRpc',
  };
}

function confirmedReasoningOverride(overrides = {}, options = {}) {
  if (!overrides.reasoning || !overrideIsFresh(overrides, options.parsedUpdatedAt, options)) return null;
  const liveOptions = options.liveModeOptions && Array.isArray(options.liveModeOptions.reasoningOptions)
    ? options.liveModeOptions.reasoningOptions
    : [];
  const option = exactOption(liveOptions, overrides.reasoning, ['id', 'key', 'value'])
    || exactOption(options.fallbackOptions, overrides.reasoning, ['id', 'key', 'value']);
  if (!option) return null;
  return {
    ...option,
    available: true,
    key: clean(option.key || option.value || option.id || overrides.reasoning),
    value: clean(option.value || option.key || option.id || overrides.reasoning),
    label: clean(option.label || option.displayName || overrides.reasoning),
    displayName: clean(option.displayName || option.label || overrides.reasoning),
    source: 'confirmed-request',
    catalogSource: clean(option.source),
    confirmedBy: 'desktopInternalRpc',
    updatedAt: overrides.updatedAt,
  };
}

module.exports = {
  DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS,
  confirmedModelOverride,
  confirmedReasoningOverride,
  mergeConfirmedControlOverrides,
  matchingOverridesForThread,
  overrideIsFresh,
};
