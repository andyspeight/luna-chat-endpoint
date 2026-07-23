// Tests for the cross-tenant auth fix on the dashboard data endpoints.
//
// profile / luna-brain / luna-stats previously trusted a client-supplied
// X-Client-Name with no session check, so anyone who knew a (public) client name
// could read or write another tenant's data. They now require a valid central
// session AND entitlement to the specific client.
//
// Behavioural: a request with NO tg_session cookie is rejected 401 before any
// Airtable work (validateSession short-circuits with no network). We can't drive
// the entitled path here — that calls out to id.travelify.io — so entitlement,
// credentialed CORS, and the dashboard cookie wiring are covered by source guards.

'use strict';

require('./helpers'); // installs the Anthropic SDK stub so the endpoints can be required

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.AIRTABLE_KEY = process.env.AIRTABLE_KEY || 'test-key';

const profile = require('../api/profile.js');
const lunaBrain = require('../api/luna-brain.js');
const lunaStats = require('../api/luna-stats.js');

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; }
  };
}

test('profile.js rejects a request with no session cookie (401)', async () => {
  const res = mockRes();
  await profile({ method: 'GET', headers: { 'x-client-name': 'Acme Travel' }, query: {} }, res);
  assert.equal(res.statusCode, 401, 'no session must be rejected before any data access');
});

test('luna-brain.js rejects a request with no session cookie (401)', async () => {
  const res = mockRes();
  await lunaBrain({ method: 'GET', headers: { 'x-client-name': 'Acme Travel' }, query: { action: 'feed' } }, res);
  assert.equal(res.statusCode, 401);
});

test('luna-stats.js rejects a request with no session cookie (401)', async () => {
  const res = mockRes();
  await lunaStats({ method: 'GET', headers: { 'x-client-name': 'Acme Travel' }, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

// ── source guards ──
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PROFILE = read('api/profile.js');
const BRAIN = read('api/luna-brain.js');
const STATS = read('api/luna-stats.js');
const DASH = read('public/dashboard.html');

test('all three endpoints check session AND per-client entitlement', () => {
  [PROFILE, BRAIN, STATS].forEach(function (src) {
    assert.match(src, /auth\.validateSession\(req\.headers\.cookie/, 'must validate the session');
    assert.match(src, /auth\.resolveEntitledClient\(/, 'must check entitlement to the specific client');
  });
});

test('all three endpoints use credentialed CORS (echo origin, not "*", with credentials)', () => {
  [PROFILE, BRAIN, STATS].forEach(function (src) {
    assert.match(src, /Access-Control-Allow-Credentials/, 'must allow credentials for the cookie');
  });
});

test('the dashboard sends the session cookie to all three endpoints', () => {
  // Every profile/luna-brain/luna-stats fetch must carry credentials:'include'.
  const fetches = (DASH.match(/vercel\.app\/api\/(profile|luna-brain|luna-stats)/g) || []).length;
  const creds = (DASH.match(/credentials: 'include'/g) || []).length;
  assert.ok(fetches >= 7, 'expected the known dashboard fetches; found ' + fetches);
  assert.ok(creds >= fetches, 'every credentialed endpoint fetch must send the cookie; creds=' + creds + ' fetches=' + fetches);
});

// ── the profile-save 401 fix (leftover DashboardPassword) ──
const CLIENTS = read('api/clients.js');

test('profile.js no longer rejects on a leftover DashboardPassword', () => {
  // The obsolete password gate that produced "Save failed: 401" must be gone;
  // the central session is the only auth now.
  assert.doesNotMatch(PROFILE, /Invalid password/, 'the DashboardPassword 401 check must be removed');
  assert.doesNotMatch(PROFILE, /if \(fields\.DashboardPassword\)/, 'no DashboardPassword enforcement remains');
});

test('clients.js no longer mints a dead DashboardPassword for new clients', () => {
  assert.doesNotMatch(CLIENTS, /DashboardPassword:\s*pass/, 'new clients must not be given a password');
  assert.doesNotMatch(CLIENTS, /&pass=/, 'the dashboard URL must not carry a password');
});
