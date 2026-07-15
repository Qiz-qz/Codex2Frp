'use strict';

const modelOptions = require('../model-options');
const { normalizeVerifiedDesktopSelection } = require('../control/desktop-selection-adapter');

const REASONING = Object.freeze({
  low: { key: 'low', value: 'low', label: '低', displayName: '低' },
  medium: { key: 'medium', value: 'medium', label: '中', displayName: '中' },
  high: { key: 'high', value: 'high', label: '高', displayName: '高' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '极高', displayName: '极高' },
});

function unavailable(reason, observedAt = '', details = {}) {
  return {
    available: false,
    source: 'codex-desktop-composer-dom',
    confidence: 'unavailable',
    reason,
    ...(observedAt ? { observedAt } : {}),
    ...details,
  };
}

function optionMatch(text, option) {
  const textKey = modelOptions.modelCompareKey(text);
  if (!textKey) return { exact: false, partial: false };
  let exact = false;
  let partial = false;
  for (const candidate of modelOptions.modelTextCandidates(option)) {
    const candidateKey = modelOptions.modelCompareKey(candidate);
    if (!candidateKey) continue;
    if (textKey === candidateKey) exact = true;
    else if (textKey.includes(candidateKey) || candidateKey.includes(textKey)) partial = true;
  }
  return { exact, partial };
}

function uniqueCatalogModel(value, catalogOptions = []) {
  const catalog = modelOptions.uniqueModelOptions(Array.isArray(catalogOptions) ? catalogOptions : []);
  const matches = catalog.map(option => ({ option, ...optionMatch(value, option) }));
  const exact = matches.filter(row => row.exact);
  if (exact.length === 1) return { option: exact[0].option, reason: '' };
  if (exact.length > 1 || matches.filter(row => row.partial).length > 1) {
    return { option: null, reason: 'MODEL_AMBIGUOUS' };
  }
  return { option: null, reason: 'MODEL_TEXT_UNAVAILABLE' };
}

function sameCatalogModel(left, right) {
  const leftKey = modelOptions.modelCompareKey(left && (left.id || left.key));
  const rightKey = modelOptions.modelCompareKey(right && (right.id || right.key));
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function reasoningKey(value = '') {
  const compact = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!compact) return '';
  if (compact === 'xhigh' || compact === 'extrahigh' || compact === 'extremelyhigh'
    || compact === 'extreme' || compact === 'max'
    || compact.includes('极高') || compact.includes('超高')) return 'xhigh';
  if (compact === 'high' || compact === '高') return 'high';
  if (compact === 'medium' || compact === '中') return 'medium';
  if (compact === 'low' || compact === '低') return 'low';
  return '';
}

function speedValue(value = '') {
  const compact = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (['fast', 'priority', 'high', '1.5x', '快速', '高速'].includes(compact)) {
    return { key: 'fast', value: 'fast', serviceTier: 'priority', label: '快速', displayName: '快速' };
  }
  if (['standard', 'default', '标准', '默认'].includes(compact)) {
    return { key: 'standard', value: 'standard', serviceTier: 'default', label: '标准', displayName: '标准' };
  }
  return null;
}

function resolvedModel(option, observedAt) {
  return {
    ...option,
    available: true,
    id: String(option.id || option.key || ''),
    key: String(option.key || option.id || ''),
    source: String(option.source || 'catalog'),
    updatedAt: observedAt,
  };
}

function resolveNextTurnSettings(sample, options = {}) {
  const observedAt = String(options.observedAt || new Date().toISOString());
  const requestedThreadId = String(options.requestedThreadId || '').trim().toLowerCase();
  const requestedDetails = requestedThreadId ? { requestedThreadId } : {};
  if (!sample || typeof sample !== 'object') {
    return unavailable('DESKTOP_SELECTION_UNAVAILABLE', observedAt, requestedDetails);
  }
  const before = normalizeVerifiedDesktopSelection(sample.selectionEvidenceBefore, {
    now: () => Date.parse(observedAt),
  });
  const after = normalizeVerifiedDesktopSelection(sample.selectionEvidenceAfter, {
    now: () => Date.parse(observedAt),
  });
  if (!before || !after) {
    return unavailable('DESKTOP_SELECTION_UNAVAILABLE', observedAt, requestedDetails);
  }
  if (before.threadId !== after.threadId) {
    return unavailable('SELECTION_CHANGED', observedAt, {
      ...requestedDetails,
      observedThreadIdBefore: before.threadId,
      observedThreadIdAfter: after.threadId,
    });
  }
  if (!requestedThreadId || before.threadId !== requestedThreadId) {
    return unavailable('THREAD_MISMATCH', observedAt, {
      ...requestedDetails,
      observedThreadId: before.threadId,
    });
  }
  const triggers = Array.isArray(sample.triggers) ? sample.triggers.filter(Boolean) : [];
  if (triggers.length === 0) return unavailable('TRIGGER_NOT_FOUND', observedAt, requestedDetails);
  if (triggers.length !== 1) return unavailable('AMBIGUOUS_TRIGGER', observedAt, requestedDetails);

  const trigger = triggers[0];
  const modelTexts = Array.isArray(trigger.modelTexts)
    ? trigger.modelTexts.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (modelTexts.length === 0) return unavailable('MODEL_TEXT_UNAVAILABLE', observedAt, requestedDetails);
  if (modelTexts.length !== 1) return unavailable('MODEL_AMBIGUOUS', observedAt, requestedDetails);
  const visibleModelMatch = uniqueCatalogModel(modelTexts[0], options.catalogOptions);
  const attributeValue = String(trigger.modelSelected || '').trim();
  const attributeModelMatch = attributeValue
    ? uniqueCatalogModel(attributeValue, options.catalogOptions)
    : null;
  if (attributeModelMatch && !attributeModelMatch.option) {
    return unavailable(attributeModelMatch.reason, observedAt, requestedDetails);
  }
  if (attributeModelMatch && visibleModelMatch.option
    && !sameCatalogModel(attributeModelMatch.option, visibleModelMatch.option)) {
    return unavailable('MODEL_CONFLICT', observedAt, requestedDetails);
  }
  const selectedModelMatch = attributeModelMatch || visibleModelMatch;
  if (!selectedModelMatch.option) return unavailable(selectedModelMatch.reason, observedAt, requestedDetails);

  const effortTexts = Array.isArray(trigger.effortTexts)
    ? trigger.effortTexts.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  if (effortTexts.length !== 1) return unavailable('REASONING_UNAVAILABLE', observedAt, requestedDetails);
  const reasoningAttributeValue = String(trigger.reasoningSelected || '').trim();
  const attributeReasoning = reasoningKey(reasoningAttributeValue);
  const visibleReasoning = reasoningKey(effortTexts[0]);
  if (!visibleReasoning || (reasoningAttributeValue && !attributeReasoning)) {
    return unavailable('REASONING_UNAVAILABLE', observedAt, requestedDetails);
  }
  if (attributeReasoning && attributeReasoning !== visibleReasoning) {
    return unavailable('REASONING_CONFLICT', observedAt, requestedDetails);
  }
  const selectedReasoning = attributeReasoning || visibleReasoning;

  const speed = speedValue(trigger.speedSelected);
  return {
    available: true,
    source: 'codex-desktop-composer-dom',
    confidence: 'exact',
    exactThreadId: before.threadId,
    observedAt,
    model: { ...resolvedModel(selectedModelMatch.option, observedAt), visibleLabel: modelTexts[0] },
    reasoningMode: {
      ...REASONING[selectedReasoning],
      available: true,
      rawValue: reasoningAttributeValue,
      updatedAt: observedAt,
    },
    composerState: String(trigger.state || ''),
    ...(speed ? { speed: { ...speed, available: true, updatedAt: observedAt } } : {}),
  };
}

module.exports = {
  reasoningKey,
  resolveNextTurnSettings,
  uniqueCatalogModel,
};
