'use strict';

function cleanText(value = '') {
  return String(value || '').trim();
}

function labelFromModelName(name = '') {
  const text = cleanText(name);
  if (!text) return '';
  return text
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^GPT-/i, '')
    .replace(/^gpt-/i, '')
    .replace(/^codex-/i, '')
    .trim() || text;
}

function displayNameFromModelId(id = '') {
  const text = cleanText(id);
  if (!text) return '';
  return text
    .replace(/_/g, '-')
    .split('-')
    .filter(Boolean)
    .map(part => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^[0-9.]+$/.test(part)) return part;
      return part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('-');
}

function modelIdFromMenuText(text = '') {
  return cleanText(text)
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => cleanText(item)).filter(Boolean);
}

function normalizeServiceTierIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.id || item.key || item.value || item.name || '';
    })
    .map(item => cleanText(item))
    .filter(Boolean);
}

function reasoningEffortValue(value) {
  if (typeof value === 'string') return cleanText(value);
  if (!value || typeof value !== 'object') return '';
  return cleanText(value.effort || value.key || value.value || value.mode || value.id);
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(reasoningEffortValue).filter(Boolean))];
}

function normalizeModelOption(row = {}, source = 'local') {
  const id = cleanText(row.slug || row.id || row.model || row.key);
  if (!id) return null;
  const displayName = cleanText(row.display_name || row.displayName || row.name || row.label || displayNameFromModelId(id) || id);
  const additionalSpeedTiers = normalizeStringArray(row.additional_speed_tiers || row.additionalSpeedTiers);
  const serviceTiers = normalizeServiceTierIds(row.service_tiers || row.serviceTiers);
  const supportedReasoningEfforts = normalizeReasoningEfforts(
    row.supported_reasoning_levels || row.supportedReasoningLevels
      || row.supported_reasoning_efforts || row.supportedReasoningEfforts
      || row.reasoningEfforts,
  );
  const defaultReasoningEffort = reasoningEffortValue(
    row.default_reasoning_level || row.defaultReasoningLevel
      || row.default_reasoning_effort || row.defaultReasoningEffort,
  );
  const speedSupported = row.speedSupported === true ||
    additionalSpeedTiers.length > 0 ||
    serviceTiers.some(tier => !/^(default|standard)$/i.test(tier));
  const option = {
    key: cleanText(row.key || id),
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: cleanText(row.source || source) || 'local',
  };
  if (additionalSpeedTiers.length) option.additionalSpeedTiers = additionalSpeedTiers;
  if (serviceTiers.length) option.serviceTiers = serviceTiers;
  if (speedSupported) option.speedSupported = true;
  if (supportedReasoningEfforts.length) option.supportedReasoningEfforts = supportedReasoningEfforts;
  if (defaultReasoningEffort) option.defaultReasoningEffort = defaultReasoningEffort;
  return option;
}

function modelCompareKey(value = '') {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelTextCandidates(model = {}) {
  if (typeof model === 'string') return [model].filter(Boolean);
  return [
    model.id,
    model.key,
    model.model,
    model.slug,
    model.displayName,
    model.display_name,
    model.label,
    model.name,
  ].map(value => cleanText(value)).filter(Boolean);
}

function canonicalModelId(value = '', catalogOptions = []) {
  const raw = cleanText(value);
  const wanted = modelCompareKey(raw);
  if (!wanted) return '';
  const exactIds = (Array.isArray(catalogOptions) ? catalogOptions : [])
    .filter(Boolean)
    .map(option => cleanText(option.id || option.slug || option.model || option.key))
    .filter(id => id === raw);
  if (exactIds.length === 1) return exactIds[0];
  const matches = [];
  for (const option of (Array.isArray(catalogOptions) ? catalogOptions : []).filter(Boolean)) {
    if (!modelTextCandidates(option).some(candidate => modelCompareKey(candidate) === wanted)) continue;
    const id = cleanText(option.id || option.slug || option.model || option.key);
    if (id && !matches.includes(id)) matches.push(id);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return '';
  return /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)+|[a-z]+[0-9][a-z0-9]*)$/.test(raw) ? raw : '';
}

function canonicalizeThreadSettings(params = {}, catalogOptions = []) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  if (!cleanText(params.model)) return { ...params };
  const model = canonicalModelId(params.model, catalogOptions);
  if (!model) {
    const error = new Error('Model display alias is ambiguous or is not a canonical model id.');
    error.code = 'MODEL_ID_AMBIGUOUS';
    throw error;
  }
  return { ...params, model };
}

const BASE_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

function reasoningOptionsForModel(model = {}, targets = {}, liveOptions = []) {
  const supported = normalizeReasoningEfforts(model && model.supportedReasoningEfforts);
  const live = (Array.isArray(liveOptions) ? liveOptions : []).filter(Boolean);
  const liveEfforts = normalizeReasoningEfforts(live);
  const efforts = supported.length
    ? supported
    : (liveEfforts.length ? liveEfforts.filter(effort => BASE_REASONING_EFFORTS.includes(effort)) : BASE_REASONING_EFFORTS);
  return efforts.map(effort => live.find(option => reasoningEffortValue(option) === effort) || targets[effort] || {
    key: effort,
    value: effort,
    label: effort,
    displayName: effort,
  });
}

function uniqueModelOptions(options = []) {
  const out = [];
  const indexByKey = new Map();
  for (const option of options) {
    const id = cleanText(option && (option.id || option.key || option.displayName || option.label));
    if (!id) continue;
    const key = modelCompareKey(id);
    if (!key) continue;
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      out[existingIndex] = {
        ...option,
        ...out[existingIndex],
        additionalSpeedTiers: out[existingIndex].additionalSpeedTiers || option.additionalSpeedTiers,
        serviceTiers: out[existingIndex].serviceTiers || option.serviceTiers,
        supportedReasoningEfforts: out[existingIndex].supportedReasoningEfforts || option.supportedReasoningEfforts,
        defaultReasoningEffort: out[existingIndex].defaultReasoningEffort || option.defaultReasoningEffort,
        speedSupported: out[existingIndex].speedSupported === true || option.speedSupported === true || undefined,
      };
      continue;
    }
    indexByKey.set(key, out.length);
    out.push(option);
  }
  return out;
}

function bestModelOptionMatch(text = '', catalogOptions = []) {
  const textKey = modelCompareKey(text);
  if (!textKey) return null;
  let best = null;
  for (const option of catalogOptions.filter(Boolean)) {
    for (const candidate of modelTextCandidates(option)) {
      const candidateKey = modelCompareKey(candidate);
      if (!candidateKey) continue;
      let score = 0;
      if (textKey === candidateKey) {
        score = 100000 + candidateKey.length;
      } else if (textKey.includes(candidateKey)) {
        score = 50000 + candidateKey.length;
      } else if (candidateKey.includes(textKey)) {
        score = 10000 + textKey.length;
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { option, score };
      }
    }
  }
  return best ? best.option : null;
}

function modelOptionFromMenuText(text = '', catalogOptions = []) {
  const compact = modelCompareKey(text);
  if (!compact) return null;
  const catalogMatch = bestModelOptionMatch(text, catalogOptions);
  if (catalogMatch) return catalogMatch;
  if (!/[0-9]/.test(compact) && !compact.includes('gpt') && !compact.includes('codex')) return null;
  const displayName = cleanText(text);
  return normalizeModelOption({
    id: modelIdFromMenuText(displayName) || displayName,
    displayName,
    source: 'live-menu',
  }, 'live-menu');
}

function modelOptionsForClient(liveModeOptions = null, catalogOptions = []) {
  const liveOptions = liveModeOptions && Array.isArray(liveModeOptions.modelOptions)
    ? liveModeOptions.modelOptions
    : [];
  return uniqueModelOptions([...liveOptions, ...catalogOptions]);
}

function modelInfoFromId(modelId = '', catalogOptions = [], updatedAt = '') {
  const rawId = cleanText(modelId);
  if (!rawId) {
    return { available: false, id: '', version: '', source: '', label: '', displayName: '', updatedAt };
  }
  const option = bestModelOptionMatch(rawId, catalogOptions);
  if (option) {
    return {
      ...option,
      available: true,
      id: option.id || rawId,
      key: option.key || option.id || rawId,
      version: option.version || '',
      source: option.source || 'local',
      label: option.label || labelFromModelName(option.displayName || rawId),
      displayName: option.displayName || option.display_name || rawId,
      updatedAt,
    };
  }
  const displayName = displayNameFromModelId(rawId) || rawId;
  return {
    available: true,
    id: rawId,
    key: rawId,
    version: '',
    source: rawId.toLowerCase().startsWith('gpt-') ? 'codex-config' : 'unknown',
    label: labelFromModelName(displayName),
    displayName,
    updatedAt,
  };
}

function modelCandidateMatches(actual = {}, expected = {}) {
  const actualKeys = modelTextCandidates(actual).map(modelCompareKey).filter(Boolean);
  const expectedKeys = modelTextCandidates(expected).map(modelCompareKey).filter(Boolean);
  return actualKeys.some(actualKey => expectedKeys.includes(actualKey));
}

function modelSupportsSpeed(model = {}, catalogOptions = []) {
  if (model && typeof model === 'object' && model.speedSupported === true) return true;
  const option = bestModelOptionMatch(modelTextCandidates(model)[0] || model, catalogOptions);
  if (option && option.speedSupported === true) return true;
  const candidates = modelTextCandidates(model).map(modelCompareKey).filter(Boolean);
  return candidates.some(key => key === 'gpt55' || key === 'gpt54' || key === '55' || key === '54');
}

module.exports = {
  bestModelOptionMatch,
  canonicalModelId,
  canonicalizeThreadSettings,
  displayNameFromModelId,
  labelFromModelName,
  modelCandidateMatches,
  modelCompareKey,
  modelInfoFromId,
  modelOptionFromMenuText,
  modelOptionsForClient,
  reasoningOptionsForModel,
  modelSupportsSpeed,
  modelTextCandidates,
  normalizeModelOption,
  uniqueModelOptions,
};
