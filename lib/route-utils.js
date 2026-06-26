'use strict';

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseIpv4(address) {
  const parts = String(address || '').trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => {
    if (!/^\d+$/.test(part)) return NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : NaN;
  });
  return nums.every(Number.isInteger) ? nums : null;
}

function isPhoneReachableIpv4(address) {
  const ip = parseIpv4(address);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function getDesktopLocalBase(port) {
  return `http://127.0.0.1:${Number(port)}`;
}

function getLanApiBasesFromInterfaces(nets, port) {
  const bases = [];
  const seen = new Set();
  for (const entries of Object.values(nets || {})) {
    for (const net of entries || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (!isPhoneReachableIpv4(net.address)) continue;
      const base = `http://${net.address}:${Number(port)}`;
      if (!seen.has(base)) {
        seen.add(base);
        bases.push(base);
      }
    }
  }
  return bases;
}

function normalizeRouteCandidate(row) {
  const baseUrl = normalizeBaseUrl(row && row.baseUrl);
  if (!baseUrl) return null;
  const kind = String(row.kind || 'lan');
  const label = String(row.label || kind);
  const priority = Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100;
  return {
    id: String(row.id || `${kind}:${baseUrl}`),
    baseUrl,
    label,
    kind,
    priority,
  };
}

function mergeRouteCandidates(rows) {
  const byBase = new Map();
  for (const row of rows || []) {
    const candidate = normalizeRouteCandidate(row);
    if (!candidate) continue;
    const existing = byBase.get(candidate.baseUrl);
    if (!existing || candidate.priority < existing.priority) byBase.set(candidate.baseUrl, candidate);
  }
  return [...byBase.values()].sort((a, b) => a.priority - b.priority);
}

module.exports = {
  normalizeBaseUrl,
  parseIpv4,
  isPhoneReachableIpv4,
  getDesktopLocalBase,
  getLanApiBasesFromInterfaces,
  normalizeRouteCandidate,
  mergeRouteCandidates,
};
