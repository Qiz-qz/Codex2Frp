'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractBearerToken,
  isAuthorizedRequest,
} = require('../lib/security/auth');

const TOKEN = 'mobile-secret-token';

test('prefers Authorization Bearer without putting the token in the URL', () => {
  const req = {
    url: '/codex/v3/meta',
    headers: { authorization: `Bearer ${TOKEN}`, host: 'localhost' },
  };
  assert.equal(extractBearerToken(req.headers), TOKEN);
  assert.equal(isAuthorizedRequest(req, TOKEN), true);
});

test('rejects malformed and incorrect bearer credentials', () => {
  assert.equal(extractBearerToken({ authorization: `Basic ${TOKEN}` }), '');
  assert.equal(isAuthorizedRequest({ url: '/', headers: { authorization: 'Bearer wrong' } }, TOKEN), false);
  assert.equal(isAuthorizedRequest({ url: '/', headers: { authorization: 'Bearer' } }, TOKEN), false);
});

test('legacy header, query, and cookie compatibility must be explicitly enabled', () => {
  const headerRequest = { url: '/', headers: { 'x-mobile-typer-token': TOKEN } };
  const queryRequest = { url: `/?token=${TOKEN}`, headers: { host: 'localhost' } };
  const cookieRequest = { url: '/', headers: { cookie: `codex2frpToken=${TOKEN}` } };

  assert.equal(isAuthorizedRequest(headerRequest, TOKEN), false);
  assert.equal(isAuthorizedRequest(headerRequest, TOKEN, { allowLegacyHeader: true }), true);
  assert.equal(isAuthorizedRequest(queryRequest, TOKEN), false);
  assert.equal(isAuthorizedRequest(queryRequest, TOKEN, { allowLegacyQuery: true }), true);
  assert.equal(isAuthorizedRequest(cookieRequest, TOKEN), false);
  assert.equal(isAuthorizedRequest(cookieRequest, TOKEN, { allowLegacyCookie: true }), true);
});
