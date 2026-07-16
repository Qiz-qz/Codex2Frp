'use strict';

const { modelInfoFromId } = require('../model-options');

const DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS = 15_000;

function clean(value) {
  return String(value || '').trim();
}

function matchingOverridesForThread(overrides = {}, threadId = '') {
  const requested = clean(threadId);
  return requested && clean(overrides.threadId) === requested ? overrides : {};
}

function fieldUpdatedAt(overrides = {}, field = '') {
  const explicit = clean(overrides[`${field}UpdatedAt`]);
  if (explicit) return explicit;
  return clean(overrides[field]) ? clean(overrides.updatedAt) : '';
}

function mergeConfirmedControlOverrides(previous = {}, settings = {}, updatedAt = '') {
  const threadId = clean(settings.threadId);
  const sameThread = threadId && clean(previous.threadId) === threadId;
  const next = sameThread
    ? { ...previous }
    : {
      model: '', reasoning: '', speed: '', threadId,
      modelUpdatedAt: '', reasoningUpdatedAt: '', speedUpdatedAt: '',
    };
  next.threadId = threadId;
  next.updatedAt = clean(updatedAt);
  if (clean(settings.model)) {
    next.model = clean(settings.model);
    next.modelUpdatedAt = next.updatedAt;
  }
  if (clean(settings.effort)) {
    next.reasoning = clean(settings.effort);
    next.reasoningUpdatedAt = next.updatedAt;
  }
  if (clean(settings.speed)) {
    next.speed = clean(settings.speed);
    next.speedUpdatedAt = next.updatedAt;
  }
  return next;
}

function overrideIsFresh(overrides = {}, parsedUpdatedAt = '', options = {}) {
  const overrideMs = Date.parse(options.updatedAt || overrides.updatedAt || '');
  const parsedMs = Date.parse(parsedUpdatedAt || '');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(0, options.maxAgeMs)
    : DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS;
  if (!Number.isFinite(overrideMs) || overrideMs > now + 60_000 || now - overrideMs > maxAgeMs) return false;
  return !Number.isFinite(parsedMs) || overrideMs >= parsedMs;
}

function preferConfirmedControlValue(confirmed, observed, observation = '') {
  if (!confirmed) return observed || null;
  if (!observed) return confirmed;
  const observedAt = observation && typeof observation === 'object'
    ? clean(observation.observedAt)
    : clean(observation);
  const observationSource = observation && typeof observation === 'object'
    ? clean(observation.observationSource)
    : '';
  const confirmedKey = clean(confirmed.id || confirmed.key || confirmed.value || confirmed.serviceTier);
  const observedKey = clean(observed.id || observed.key || observed.value || observed.serviceTier);
  if (observationSource === 'codex-desktop-composer-dom') {
    return confirmedKey && confirmedKey === observedKey ? observed : confirmed;
  }
  const confirmedMs = Date.parse(confirmed.updatedAt || '');
  const observedMs = Date.parse(observed.updatedAt || observedAt || '');
  if (!Number.isFinite(confirmedMs)) return observed;
  return !Number.isFinite(observedMs) || confirmedMs >= observedMs ? confirmed : observed;
}

function exactOption(options = [], target = '', fields = []) {
  const wanted = clean(target);
  if (!wanted) return null;
  return (Array.isArray(options) ? options : []).find(option => option && fields.some(field => clean(option[field]) === wanted)) || null;
}

function confirmedModelOverride(overrides = {}, options = {}) {
  const updatedAt = fieldUpdatedAt(overrides, 'model');
  if (!overrides.model || !overrideIsFresh(overrides, options.parsedUpdatedAt, { ...options, updatedAt })) return null;
  const liveOptions = options.liveModeOptions && Array.isArray(options.liveModeOptions.modelOptions)
    ? options.liveModeOptions.modelOptions
    : [];
  const live = exactOption(liveOptions, overrides.model, ['id', 'key']);
  const info = modelInfoFromId(
    overrides.model,
    live ? [live] : (Array.isArray(options.catalogOptions) ? options.catalogOptions : []),
    updatedAt,
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
  const updatedAt = fieldUpdatedAt(overrides, 'reasoning');
  if (!overrides.reasoning || !overrideIsFresh(overrides, options.parsedUpdatedAt, { ...options, updatedAt })) return null;
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
    updatedAt,
  };
}

module.exports = {
  DEFAULT_CONTROL_OVERRIDE_MAX_AGE_MS,
  confirmedModelOverride,
  confirmedReasoningOverride,
  mergeConfirmedControlOverrides,
  matchingOverridesForThread,
  overrideIsFresh,
  preferConfirmedControlValue,
};
