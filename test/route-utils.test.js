'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPhoneReachableIpv4,
  getDesktopLocalBase,
  getLanApiBasesFromInterfaces,
  normalizeRouteCandidate,
  mergeRouteCandidates,
} = require('../lib/route-utils');

test('filters virtual, link-local, loopback, and invalid phone-facing IPv4 addresses', () => {
  assert.equal(isPhoneReachableIpv4('192.168.4.3'), true);
  assert.equal(isPhoneReachableIpv4('10.0.0.8'), true);
  assert.equal(isPhoneReachableIpv4('172.16.5.9'), true);
  assert.equal(isPhoneReachableIpv4('127.0.0.1'), false);
  assert.equal(isPhoneReachableIpv4('169.254.101.234'), false);
  assert.equal(isPhoneReachableIpv4('198.18.0.1'), false);
  assert.equal(isPhoneReachableIpv4('198.19.255.254'), false);
  assert.equal(isPhoneReachableIpv4('8.8.8.8'), false);
  assert.equal(isPhoneReachableIpv4('203.0.113.10'), false);
  assert.equal(isPhoneReachableIpv4('172.32.0.1'), false);
  assert.equal(isPhoneReachableIpv4('100.64.0.1'), false);
  assert.equal(isPhoneReachableIpv4('0.0.0.0'), false);
  assert.equal(isPhoneReachableIpv4('224.0.0.1'), false);
  assert.equal(isPhoneReachableIpv4('not-an-ip'), false);
});

test('builds safe LAN API bases from os.networkInterfaces shape', () => {
  const nets = {
    Ethernet: [
      { family: 'IPv4', address: '192.168.4.3', internal: false },
      { family: 'IPv4', address: '198.18.0.1', internal: false },
      { family: 'IPv4', address: '169.254.1.2', internal: false },
      { family: 'IPv4', address: '127.0.0.1', internal: true },
    ],
    WiFi: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '10.0.0.6', internal: false },
    ],
  };
  assert.deepEqual(getLanApiBasesFromInterfaces(nets, 8988), [
    'http://192.168.4.3:8988',
    'http://10.0.0.6:8988',
  ]);
});

test('normalizes and merges route candidates by base URL priority', () => {
  const rows = [
    normalizeRouteCandidate({ id: 'a', baseUrl: 'http://192.168.4.3:8988/', label: 'LAN', kind: 'lan', priority: 20 }),
    normalizeRouteCandidate({ id: 'b', baseUrl: 'http://192.168.4.3:8988', label: 'LAN lower', kind: 'lan', priority: 5 }),
    normalizeRouteCandidate({ id: 'c', baseUrl: 'https://codexhm-demo.nyat.app', label: 'Sakura', kind: 'sakura', priority: 10 }),
  ];
  assert.deepEqual(mergeRouteCandidates(rows), [
    { id: 'b', baseUrl: 'http://192.168.4.3:8988', label: 'LAN lower', kind: 'lan', priority: 5 },
    { id: 'c', baseUrl: 'https://codexhm-demo.nyat.app', label: 'Sakura', kind: 'sakura', priority: 10 },
  ]);
});

test('desktop local base is separate from phone-facing LAN bases', () => {
  assert.equal(getDesktopLocalBase(8988), 'http://127.0.0.1:8988');
});
