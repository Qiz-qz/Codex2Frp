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

function normalizeModelOption(row = {}, source = 'local') {
  const id = cleanText(row.slug || row.id || row.model || row.key);
  if (!id) return null;
  const displayName = cleanText(row.display_name || row.displayName || row.name || row.label || displayNameFromModelId(id) || id);
  const additionalSpeedTiers = normalizeStringArray(row.additional_speed_tiers || row.additionalSpeedTiers);
  const serviceTiers = normalizeServiceTierIds(row.service_tiers || row.serviceTiers);
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
  displayNameFromModelId,
  labelFromModelName,
  modelCandidateMatches,
  modelCompareKey,
  modelInfoFromId,
  modelOptionFromMenuText,
  modelOptionsForClient,
  modelSupportsSpeed,
  modelTextCandidates,
  normalizeModelOption,
  uniqueModelOptions,
};
