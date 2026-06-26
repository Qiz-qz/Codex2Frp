'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactToken,
  sanitizeTunnel,
  selectBestTunnel,
  buildPublicRouteFromTunnel,
  createSakuraFrpManager,
} = require('../lib/sakura-frp');

test('redacts tokens in strings', () => {
  assert.equal(redactToken('Bearer abcdefghijklmnop'), 'Bearer [redacted]');
  assert.equal(redactToken('token=abcdefgh'), 'token=[redacted]');
  assert.equal(redactToken('raw secret-token value', 'secret-token'), 'raw [redacted] value');
});

test('sanitizes tunnel without leaking secret fields', () => {
  assert.deepEqual(sanitizeTunnel({
    id: 26632383,
    name: '002',
    type: 'https',
    remote: 'codexhm-demo.nyat.app',
    local_ip: '127.0.0.1',
    local_port: 8988,
    secret: 'hidden',
    online: true,
  }), {
    id: '26632383',
    name: '002',
    type: 'https',
    remote: 'codexhm-demo.nyat.app',
    localIp: '127.0.0.1',
    localPort: 8988,
    online: true,
  });
});

test('selectBestTunnel prefers matching online HTTPS domain tunnel', () => {
  const tunnels = [
    { id: 1, type: 'tcp', remote: 'frp-use.com:28815', local_ip: '127.0.0.1', local_port: 8988, online: true },
    { id: 2, type: 'https', remote: 'codexhm-demo.nyat.app', local_ip: '127.0.0.1', local_port: 8988, online: true },
    { id: 3, type: 'http', remote: 'codexhm-demo.nyat.app', local_ip: '127.0.0.1', local_port: 8988, online: true },
  ];
  assert.equal(selectBestTunnel(tunnels, { preferredDomain: 'codexhm-demo.nyat.app', localPort: 8988 }).id, 2);
});

test('buildPublicRouteFromTunnel creates HTTPS and TCP route bases', () => {
  assert.deepEqual(buildPublicRouteFromTunnel({ id: 2, type: 'https', remote: 'codexhm-demo.nyat.app' }), {
    id: 'sakura:2',
    kind: 'sakura',
    label: 'Sakura',
    baseUrl: 'https://codexhm-demo.nyat.app',
    priority: 30,
    tunnelId: '2',
  });
  assert.deepEqual(buildPublicRouteFromTunnel({ id: 1, type: 'tcp', remote: 'frp-use.com:28815' }), {
    id: 'sakura-tcp:1',
    kind: 'sakura-tcp',
    label: 'Sakura fallback',
    baseUrl: 'http://frp-use.com:28815',
    priority: 60,
    tunnelId: '1',
  });
});

test('buildPublicRouteFromTunnel creates browser-ready Nyat HTTPS route for TCP domain binding', () => {
  assert.deepEqual(buildPublicRouteFromTunnel(
    { id: 1, type: 'tcp', remote: 'frp-use.com:28815' },
    { preferredDomain: 'codexhm-demo.nyat.app' },
  ), {
    id: 'sakura-tcp-domain:1',
    kind: 'sakura',
    label: 'Sakura TCP HTTPS',
    baseUrl: 'https://codexhm-demo.nyat.app:28815',
    priority: 32,
    tunnelId: '1',
  });
});

test('manager reconciles by editing wrong local target before returning route', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
    if (String(url).endsWith('/tunnels')) {
      return response(200, { status: 200, data: [{ id: 2, type: 'https', remote: 'codexhm-demo.nyat.app', local_ip: '127.0.0.1', local_port: 8787, online: true }] });
    }
    if (String(url).endsWith('/tunnel/edit')) return response(200, { status: 200, message: 'ok' });
    return response(200, { ok: true });
  };
  const manager = createSakuraFrpManager({ fetchImpl });
  const result = await manager.reconcile({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
    preferredDomain: 'codexhm-demo.nyat.app',
    preferredTypes: ['https', 'http', 'tcp'],
    managedTunnelIds: [],
  }, { localPort: 8988, codexToken: 'codex' });

  assert.equal(result.ok, true);
  assert.equal(result.route.baseUrl, 'https://codexhm-demo.nyat.app');
  assert.equal(calls.some(call => call.url.endsWith('/tunnel/edit') && call.method === 'POST'), true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('manager edits when local port is correct but local IP is wrong', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
    if (String(url).endsWith('/tunnels')) {
      return response(200, { status: 200, data: [{ id: 2, type: 'https', remote: 'codexhm-demo.nyat.app', local_ip: '192.168.1.2', local_port: 8988, online: true }] });
    }
    if (String(url).endsWith('/tunnel/edit')) return response(200, { status: 200, message: 'ok' });
    return response(200, { ok: true });
  };
  const manager = createSakuraFrpManager({ fetchImpl });
  const result = await manager.reconcile({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
    preferredDomain: 'codexhm-demo.nyat.app',
    managedTunnelIds: [],
  }, { localPort: 8988 });

  assert.equal(result.ok, true);
  assert.equal(result.tunnel.localIp, '127.0.0.1');
  assert.equal(calls.some(call => call.url.endsWith('/tunnel/edit') && call.method === 'POST'), true);
});

test('API errors redact the exact configured token when it appears as plain text', async () => {
  const manager = createSakuraFrpManager({
    fetchImpl: async () => response(200, { status: 'error', message: 'token secret-token is invalid' }),
  });

  await assert.rejects(
    () => manager.listTunnels({ apiBase: 'https://api.natfrp.com/v4', apiToken: 'secret-token' }),
    error => {
      assert.equal(error.message.includes('secret-token'), false);
      assert.equal(error.message.includes('[redacted]'), true);
      return true;
    },
  );
});

test('API treats common failure payload shapes as errors', async () => {
  const failurePayloads = [
    { status: 'error', message: 'status failed' },
    { success: false, message: 'success failed' },
    { ok: false, message: 'ok failed' },
  ];

  for (const payload of failurePayloads) {
    const manager = createSakuraFrpManager({ fetchImpl: async () => response(200, payload) });
    await assert.rejects(
      () => manager.listTunnels({ apiBase: 'https://api.natfrp.com/v4', apiToken: 'secret' }),
      /failed/,
    );
  }
});

test('selectBestTunnel ignores unrelated TCP fallback when no managed ids are provided', () => {
  const tunnels = [
    { id: 5, type: 'tcp', remote: 'frp-use.com:28815', local_ip: '192.168.1.2', local_port: 8988, online: true },
  ];

  assert.equal(selectBestTunnel(tunnels, {
    preferredDomain: 'codexhm-demo.nyat.app',
    localPort: 8988,
    managedTunnelIds: [],
  }), null);
});

test('selectBestTunnel ignores TCP fallback not listed in managed ids when managed ids are provided', () => {
  const tunnels = [
    { id: 5, type: 'tcp', remote: 'frp-use.com:28815', local_ip: '127.0.0.1', local_port: 8988, online: true },
  ];

  assert.equal(selectBestTunnel(tunnels, {
    preferredDomain: 'codexhm-demo.nyat.app',
    localPort: 8988,
    managedTunnelIds: ['9'],
  }), null);
});

test('selectBestTunnel and reconcile allow managed TCP fallback by id', async () => {
  const tunnels = [
    { id: 5, type: 'tcp', remote: 'frp-use.com:28815', local_ip: '192.168.1.2', local_port: 8787, online: true },
  ];
  assert.equal(selectBestTunnel(tunnels, {
    preferredDomain: 'codexhm-demo.nyat.app',
    localPort: 8988,
    managedTunnelIds: ['5'],
  }).id, 5);

  const calls = [];
  const manager = createSakuraFrpManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
      if (String(url).endsWith('/tunnels')) return response(200, { status: 200, data: tunnels });
      if (String(url).endsWith('/tunnel/edit')) return response(200, { status: 200, message: 'ok' });
      return response(200, { ok: true });
    },
  });
  const result = await manager.reconcile({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
    preferredDomain: 'codexhm-demo.nyat.app',
    managedTunnelIds: ['5'],
  }, { localPort: 8988 });

  assert.equal(result.ok, true);
  assert.equal(result.route.baseUrl, 'https://codexhm-demo.nyat.app:28815');
  assert.equal(calls.some(call => call.url.endsWith('/tunnel/edit') && call.method === 'POST'), true);
});

test('API errors use Sakura msg payloads instead of hiding the reason', async () => {
  const manager = createSakuraFrpManager({
    fetchImpl: async () => response(500, { code: 401, msg: '璁块棶瀵嗛挜鏃犳晥' }),
  });

  await assert.rejects(
    () => manager.listTunnels({ apiBase: 'https://api.natfrp.com/v4', apiToken: 'secret' }),
    /璁块棶瀵嗛挜鏃犳晥/,
  );
});

test('manager builds managed TCP route from node host when API returns port only', async () => {
  const calls = [];
  const manager = createSakuraFrpManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
      if (String(url).endsWith('/tunnels')) {
        return response(200, [
          { id: 26632383, node: 85, type: 'tcp', remote: '28815', local_ip: 'localhost', local_port: 8787, online: true },
        ]);
      }
      if (String(url).endsWith('/nodes')) {
        return response(200, { 85: { host: 'frp-use.com' } });
      }
      if (String(url).endsWith('/tunnel/edit')) return response(200, { status: 200, message: 'ok' });
      return response(200, { ok: true });
    },
  });

  const result = await manager.reconcile({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
    preferredDomain: 'codexhm-demo.nyat.app',
    managedTunnelIds: ['26632383'],
  }, { localPort: 8988 });

  assert.equal(result.ok, true);
  assert.equal(result.route.baseUrl, 'https://codexhm-demo.nyat.app:28815');
  assert.equal(result.tunnel.localIp, '127.0.0.1');
  assert.equal(result.tunnel.localPort, 8988);
  assert.equal(calls.some(call => call.url.endsWith('/nodes') && call.method === 'GET'), true);
  assert.equal(calls.some(call => call.url.endsWith('/tunnel/edit') && call.method === 'POST'), true);
});

test('manager enables auto HTTPS and returns Nyat TCP domain route', async () => {
  const calls = [];
  const manager = createSakuraFrpManager({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
      if (String(url).endsWith('/tunnels')) {
        return response(200, [
          { id: 26632383, node: 85, type: 'tcp', remote: '28815', local_ip: '127.0.0.1', local_port: 8988, extra: 'foo = bar', online: true },
        ]);
      }
      if (String(url).endsWith('/nodes')) {
        return response(200, { 85: { host: 'frp-use.com' } });
      }
      if (String(url).endsWith('/tunnel/edit')) return response(200, { status: 200, message: 'ok' });
      return response(200, { ok: true });
    },
  });

  const result = await manager.reconcile({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
    preferredDomain: 'codexhm-demo.nyat.app',
    managedTunnelIds: ['26632383'],
  }, { localPort: 8988 });

  assert.equal(result.ok, true);
  assert.equal(result.route.baseUrl, 'https://codexhm-demo.nyat.app:28815');
  const edit = calls.find(call => call.url.endsWith('/tunnel/edit') && call.method === 'POST');
  assert.ok(edit, 'expected tunnel edit call');
  assert.match(edit.body, /foo = bar/);
  assert.match(edit.body, /auto_https = auto/);
});

test('auto-detect does not treat a TCP node host as the user-facing domain', async () => {
  const manager = createSakuraFrpManager({
    fetchImpl: async (url) => {
      if (String(url).endsWith('/tunnels')) {
        return response(200, [
          { id: 26632383, node: 85, type: 'tcp', remote: '28815', local_ip: '127.0.0.1', local_port: 8988, online: true },
        ]);
      }
      if (String(url).endsWith('/nodes')) {
        return response(200, { 85: { host: 'frp-van.com' } });
      }
      return response(200, { ok: true });
    },
  });

  const result = await manager.discover({
    enabled: true,
    apiBase: 'https://api.natfrp.com/v4',
    apiToken: 'secret',
  }, { localPort: 8988 });

  assert.equal(result.ok, true);
  assert.equal(result.fields.host, '');
  assert.equal(result.fields.remotePort, 28815);
  assert.match(result.message, /domain manually/i);
});


test('buildPublicRouteFromTunnel rejects malformed remotes', () => {
  const malformedRemotes = [
    'https://evil.example/path',
    'user@example.com',
    'frp-use.com:28815/path',
    'bad host.example',
  ];

  for (const remote of malformedRemotes) {
    assert.equal(buildPublicRouteFromTunnel({ id: 2, type: 'https', remote }), null);
  }
  assert.equal(buildPublicRouteFromTunnel({ id: 1, type: 'tcp', remote: 'frp-use.com' }), null);
});

test('buildPublicRouteFromTunnel rejects leading and trailing whitespace remotes', () => {
  const cases = [
    { type: 'https', remote: ' example.com' },
    { type: 'https', remote: 'example.com ' },
    { type: 'http', remote: '\texample.com' },
    { type: 'http', remote: 'example.com\n' },
    { type: 'tcp', remote: ' frp-use.com:28815' },
    { type: 'tcp', remote: 'frp-use.com:28815 ' },
  ];

  for (const item of cases) {
    assert.equal(buildPublicRouteFromTunnel({ id: 2, type: item.type, remote: item.remote }), null);
  }
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
