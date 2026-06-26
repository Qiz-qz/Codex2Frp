'use strict';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactToken(value, exactToken) {
  let text = String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/token=[A-Za-z0-9._-]+/g, 'token=[redacted]');
  if (exactToken) {
    text = text.replace(new RegExp(escapeRegExp(exactToken), 'g'), '[redacted]');
  }
  return text;
}

function tunnelId(value) {
  return String(value && (value.id || value.tunnel_id || value.tunnelId) || '').trim();
}

function tunnelType(value) {
  return String(value && (value.type || value.protocol || '') || '').trim().toLowerCase();
}

function tunnelRemote(value) {
  return String(value && (value.remote || value.remote_addr || value.domain || value.host || '') || '').trim().toLowerCase();
}

function tunnelRawRemote(value) {
  return String(value && (value.remote || value.remote_addr || value.domain || value.host || '') || '');
}

function tunnelLocalIp(value) {
  return String(value && (value.local_ip || value.localIp || value.local_addr || '') || '').trim();
}

function normalizedTunnelLocalIp(value) {
  const ip = tunnelLocalIp(value).toLowerCase();
  if (ip === 'localhost' || ip === '::1') return '127.0.0.1';
  return ip;
}

function tunnelLocalPort(value) {
  return Number(value && (value.local_port || value.localPort || value.local_port_number || 0)) || 0;
}

function tunnelNodeId(value) {
  return String(value && (value.node || value.node_id || value.nodeId || '') || '').trim();
}

function tunnelOnline(value) {
  return value && (value.online === true || value.status === 'online' || value.state === 'online');
}

function sanitizeTunnel(value) {
  return {
    id: tunnelId(value),
    name: String(value && (value.name || value.remark || '') || '').trim(),
    type: tunnelType(value),
    remote: tunnelRemote(value),
    localIp: tunnelLocalIp(value),
    localPort: tunnelLocalPort(value),
    online: tunnelOnline(value),
  };
}

function typeRank(type) {
  if (type === 'https') return 0;
  if (type === 'http') return 1;
  if (type === 'tcp') return 2;
  return 9;
}

function isTargetPort(tunnel, localPort) {
  return tunnelLocalPort(tunnel) === Number(localPort);
}

function isTargetLocal(tunnel, localPort) {
  return normalizedTunnelLocalIp(tunnel) === '127.0.0.1' && isTargetPort(tunnel, localPort);
}

function matchesDomain(tunnel, preferredDomain) {
  return tunnelRemote(tunnel) === String(preferredDomain || '').trim().toLowerCase();
}

function selectBestTunnel(tunnels, options) {
  const preferredDomain = String(options.preferredDomain || '').trim().toLowerCase();
  const localPort = Number(options.localPort);
  const managedTunnelIds = new Set((Array.isArray(options.managedTunnelIds) ? options.managedTunnelIds : [])
    .map(id => String(id).trim())
    .filter(Boolean));
  const candidates = (Array.isArray(tunnels) ? tunnels : [])
    .filter(item => ['https', 'http', 'tcp'].includes(tunnelType(item)))
    .filter(item => tunnelOnline(item))
    .filter(item => {
      if (tunnelType(item) !== 'tcp') return matchesDomain(item, preferredDomain);
      if (managedTunnelIds.size > 0) return managedTunnelIds.has(tunnelId(item));
      return isTargetLocal(item, localPort);
    })
    .sort((a, b) => {
      const typeDelta = typeRank(tunnelType(a)) - typeRank(tunnelType(b));
      if (typeDelta) return typeDelta;
      const localDelta = Number(!isTargetLocal(a, localPort)) - Number(!isTargetLocal(b, localPort));
      if (localDelta) return localDelta;
      return Number(tunnelId(a)) - Number(tunnelId(b));
    });
  return candidates[0] || null;
}

function parseSafeRemote(remote, options = {}) {
  const raw = String(remote || '');
  if (!raw || /\s/.test(raw)) return null;
  const value = raw.trim().toLowerCase();
  if (!value || /[/@?#]/.test(value) || value.includes('://')) return null;
  const parts = value.split(':');
  if (parts.length > 2) return null;
  const [host, port] = parts;
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const hostPattern = new RegExp(`^${label}(?:\\.${label})*$`);
  if (!hostPattern.test(host)) return null;
  if (port !== undefined) {
    if (!/^[0-9]+$/.test(port)) return null;
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65535) return null;
  } else if (options.requirePort) {
    return null;
  }
  return value;
}

function parseSafeRemoteParts(remote, options = {}) {
  const value = parseSafeRemote(remote, options);
  if (!value) return null;
  const [host, portText] = value.split(':');
  const port = portText === undefined ? 0 : Number(portText);
  return { value, host, port };
}

function normalizePreferredDomain(value) {
  let text = String(value || '').trim().toLowerCase();
  text = text.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return parseSafeRemoteParts(text);
}

function normalizePort(value, fallback = 0) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return fallback;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : fallback;
}

function nodeHostFromNodes(nodes, nodeId) {
  const id = String(nodeId || '').trim();
  if (!id || !nodes) return '';
  const rows = Array.isArray(nodes) ? nodes : Object.entries(nodes).map(([key, value]) => ({ id: key, ...(value || {}) }));
  const node = rows.find(item => String(item && (item.id || item.node || item.node_id || '') || '').trim() === id);
  const host = String(node && (node.host || node.domain || node.remote || '') || '').trim().toLowerCase();
  return parseSafeRemote(host) || '';
}

function tcpRemoteWithNodeHost(tunnel, nodes) {
  const raw = tunnelRawRemote(tunnel);
  if (parseSafeRemote(raw, { requirePort: true })) return raw;
  const port = String(raw || '').trim();
  if (!/^[0-9]+$/.test(port)) return raw;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65535) return raw;
  const host = nodeHostFromNodes(nodes, tunnelNodeId(tunnel));
  return host ? `${host}:${port}` : raw;
}

function buildPublicRouteFromTunnel(tunnel, options = {}) {
  const id = tunnelId(tunnel);
  const type = tunnelType(tunnel);
  const rawRemote = type === 'tcp' ? tcpRemoteWithNodeHost(tunnel, options.nodes) : tunnelRawRemote(tunnel);
  const remote = parseSafeRemoteParts(rawRemote, { requirePort: type === 'tcp' });
  if (!id || !remote) return null;
  if (type === 'https') {
    return { id: `sakura:${id}`, kind: 'sakura', label: 'Sakura', baseUrl: `https://${remote.value}`, priority: 30, tunnelId: id };
  }
  if (type === 'http') {
    return { id: `sakura:${id}`, kind: 'sakura', label: 'Sakura', baseUrl: `http://${remote.value}`, priority: 35, tunnelId: id };
  }
  if (type === 'tcp') {
    const domain = normalizePreferredDomain(options.preferredDomain);
    const port = normalizePort(options.remotePort, remote.port || (domain && domain.port) || 0);
    if (domain && port) {
      return { id: `sakura-tcp-domain:${id}`, kind: 'sakura', label: 'Sakura TCP HTTPS', baseUrl: `https://${domain.host}:${port}`, priority: 32, tunnelId: id };
    }
    return { id: `sakura-tcp:${id}`, kind: 'sakura-tcp', label: 'Sakura fallback', baseUrl: `http://${remote.value}`, priority: 60, tunnelId: id };
  }
  return null;
}

function discoverTunnelFieldsFromTunnel(tunnel, options = {}) {
  const type = tunnelType(tunnel);
  if (!['https', 'http', 'tcp'].includes(type) || !tunnelOnline(tunnel)) return null;
  const nodes = options.nodes || null;
  const rawRemote = type === 'tcp' ? tcpRemoteWithNodeHost(tunnel, nodes) : tunnelRawRemote(tunnel);
  const remote = parseSafeRemoteParts(rawRemote, { requirePort: type === 'tcp' });
  if (!remote) return null;
  const preferredDomain = normalizePreferredDomain(options.preferredDomain);
  const remotePort = type === 'tcp' ? remote.port : normalizePort(options.remotePort, remote.port || 0);
  return {
    id: tunnelId(tunnel),
    type,
    host: type === 'tcp' ? (preferredDomain && preferredDomain.host || '') : remote.host,
    remotePort: remotePort || 0,
    localIp: tunnelLocalIp(tunnel),
    localPort: tunnelLocalPort(tunnel),
    online: true,
  };
}

function tunnelExtra(value) {
  return String(value && (value.extra || value.extra_config || value.extraConfig || '') || '');
}

function hasAutoHttps(value) {
  return tunnelExtra(value).split(/\r?\n/).some(line => /^\s*auto_https\s*=\s*auto\s*$/i.test(line));
}

function mergeAutoHttpsExtra(extra) {
  const lines = String(extra || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let replaced = false;
  const merged = lines.map(line => {
    if (/^auto_https\s*=/i.test(line)) {
      replaced = true;
      return 'auto_https = auto';
    }
    return line;
  });
  if (!replaced) merged.push('auto_https = auto');
  return merged.join('\n');
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload && payload.data && payload.data.list)) return payload.data.list;
  if (Array.isArray(payload && payload.tunnels)) return payload.tunnels;
  return [];
}

function isFailurePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const numericStatus = Number(payload.status);
  if (Number.isFinite(numericStatus) && numericStatus >= 400) return true;
  if (typeof payload.status === 'string' && ['error', 'fail', 'failed'].includes(payload.status.toLowerCase())) return true;
  return payload.success === false || payload.ok === false;
}

function createSakuraFrpManager(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required for SakuraFrp manager');

  async function api(config, path, request = {}) {
    const url = `${String(config.apiBase || 'https://api.natfrp.com/v4').replace(/\/+$/, '')}${path}`;
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${config.apiToken}`,
      ...(request.headers || {}),
    };
    const response = await fetchImpl(url, { ...request, headers });
    const payload = await response.json().catch(async () => ({ message: await response.text().catch(() => '') }));
    if (!response.ok || isFailurePayload(payload)) {
      const message = redactToken(payload.message || payload.msg || payload.error || `SakuraFrp API failed: ${response.status}`, config.apiToken);
      throw Object.assign(new Error(message), { status: response.status });
    }
    return payload;
  }

  async function listTunnels(config) {
    return extractRows(await api(config, '/tunnels'));
  }

  async function listNodes(config) {
    return api(config, '/nodes');
  }

  async function editTunnel(config, tunnel, context, options = {}) {
    const body = {
      id: tunnelId(tunnel),
      local_ip: '127.0.0.1',
      local_port: Number(context.localPort),
    };
    if (typeof options.extra === 'string') body.extra = options.extra;
    await api(config, '/tunnel/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function reconcile(config, context) {
    if (!config || !config.enabled || !config.apiToken) {
      return { ok: false, configured: false, routes: [], message: 'SakuraFrp is not configured.' };
    }
    const tunnels = await listTunnels(config);
    let tunnel = selectBestTunnel(tunnels, {
      preferredDomain: config.preferredDomain,
      localPort: context.localPort,
      managedTunnelIds: config.managedTunnelIds,
    });
    let nodes = null;
    if (tunnel && tunnelType(tunnel) === 'tcp') nodes = await listNodes(config);
    const shouldEnableAutoHttps = tunnel && tunnelType(tunnel) === 'tcp' && normalizePreferredDomain(config.preferredDomain) && !hasAutoHttps(tunnel);
    if (tunnel && (!isTargetLocal(tunnel, context.localPort) || shouldEnableAutoHttps)) {
      const extra = shouldEnableAutoHttps ? mergeAutoHttpsExtra(tunnelExtra(tunnel)) : undefined;
      await editTunnel(config, tunnel, context, { extra });
      tunnel = {
        ...tunnel,
        local_ip: '127.0.0.1',
        local_port: Number(context.localPort),
        ...(extra !== undefined ? { extra } : {}),
      };
    }
    const route = buildPublicRouteFromTunnel(tunnel, {
      nodes,
      preferredDomain: config.preferredDomain,
      remotePort: config.remotePort,
    });
    return {
      ok: Boolean(route),
      configured: true,
      route,
      routes: route ? [route] : [],
      tunnel: tunnel ? sanitizeTunnel(tunnel) : null,
      message: route ? 'SakuraFrp route is ready.' : 'No running SakuraFrp tunnel is available.',
    };
  }

  async function discover(config, context) {
    if (!config || !config.apiToken) {
      return { ok: false, configured: false, message: 'SakuraFrp API key is required for auto-detection.' };
    }
    const tunnels = await listTunnels(config);
    const online = (Array.isArray(tunnels) ? tunnels : [])
      .filter(item => ['https', 'http', 'tcp'].includes(tunnelType(item)))
      .filter(item => tunnelOnline(item));
    const targetLocal = online.find(item => isTargetLocal(item, context.localPort));
    const selected = targetLocal || online.find(item => tunnelLocalPort(item) === Number(context.localPort)) || online[0] || null;
    if (!selected) return { ok: false, configured: true, message: 'No online SakuraFrp tunnel is available.' };
    let nodes = null;
    if (tunnelType(selected) === 'tcp') nodes = await listNodes(config);
    const fields = discoverTunnelFieldsFromTunnel(selected, { nodes, remotePort: config.remotePort, preferredDomain: config.preferredDomain });
    if (!fields || (!fields.host && !fields.remotePort)) return { ok: false, configured: true, message: 'Selected SakuraFrp tunnel has no usable remote address.' };
    return {
      ok: true,
      configured: true,
      fields,
      tunnel: sanitizeTunnel(selected),
      message: fields.host
        ? (isTargetLocal(selected, context.localPort)
          ? 'Detected an online tunnel that already points to Codex2Frp.'
          : 'Detected an online tunnel. Verify its local target before saving.')
        : 'Detected the TCP remote port. Please fill the Nyat/custom domain manually.',
    };
  }

  return { listTunnels, listNodes, reconcile, discover };
}

module.exports = {
  redactToken,
  sanitizeTunnel,
  selectBestTunnel,
  buildPublicRouteFromTunnel,
  discoverTunnelFieldsFromTunnel,
  createSakuraFrpManager,
};
