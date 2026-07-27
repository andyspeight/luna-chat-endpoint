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

// REGRESSION GUARD for the live "Save failed: 401" incident.
//
// The dashboard is served from chat.travelify.io / lunachat.travelify.io, which are
// aliases of THIS Vercel project. The central login cookie (tg_session) is scoped to
// travelify.io, so it is ONLY sent on same-origin requests. Calling a
// session-authenticated endpoint at the absolute https://luna-chat-endpoint.vercel.app
// URL is cross-site: the browser withholds the cookie, validateSession sees nothing,
// and every request 401s (both GET and POST). Session-authenticated endpoints must
// therefore always be called with a relative, same-origin path.
// GENERIC guard: derive the session-authenticated endpoints from the SERVER code,
// then scan EVERY front-end file. The earlier hand-listed version only checked
// dashboard.html, so it missed public/luna-brain.html (which 401'd unconditionally)
// and would miss any new endpoint added later.
const FRONTEND_EXEMPT = new Set([
  'widget-core.js'  // embedded on third-party sites; must stay absolute (visitor tokens)
]);

function sessionAuthedEndpoints() {
  return fs.readdirSync(path.join(__dirname, '..', 'api'))
    .filter(f => f.endsWith('.js'))
    .filter(f => /validateSession/.test(read('api/' + f)))
    .map(f => f.replace(/\.js$/, ''));
}

function frontendFiles() {
  const dir = path.join(__dirname, '..', 'public');
  return fs.readdirSync(dir)
    .filter(f => (f.endsWith('.html') || f.endsWith('.js')) && !FRONTEND_EXEMPT.has(f));
}

test('NO front-end file calls a session-authenticated endpoint at an absolute vercel.app URL', () => {
  const endpoints = sessionAuthedEndpoints();
  assert.ok(endpoints.length >= 3, 'expected to detect the session endpoints; got ' + endpoints.join(','));
  const offenders = [];
  frontendFiles().forEach(function (file) {
    const src = read('public/' + file);
    endpoints.forEach(function (ep) {
      const abs = new RegExp('https://luna-chat-endpoint\\.vercel\\.app/api/' + ep.replace(/-/g, '\\-'));
      if (abs.test(src)) offenders.push(file + ' -> /api/' + ep);
    });
  });
  assert.deepEqual(offenders, [],
    'these call a session-authed endpoint cross-site, so the tg_session cookie is withheld -> 401: ' + offenders.join(', '));
});

// ably-token is DUAL-MODE: mode:'agent' requires a session, but mode:'visitor'
// (used by the widget and the demo page) is unauthenticated BY DESIGN and issues a
// strictly narrower capability. So calling it without credentials is legitimate.
const DUAL_MODE_ENDPOINTS = new Set(['ably-token']);

test('every front-end caller of a session-ONLY endpoint sends credentials', () => {
  const endpoints = sessionAuthedEndpoints().filter(ep => !DUAL_MODE_ENDPOINTS.has(ep));
  const missing = [];
  frontendFiles().forEach(function (file) {
    const src = read('public/' + file);
    const callsSession = endpoints.some(ep => new RegExp('[\'"`]/api/' + ep.replace(/-/g, '\\-')).test(src));
    if (callsSession && !/credentials:\s*'include'/.test(src)) missing.push(file);
  });
  assert.deepEqual(missing, [],
    'these call a session-authed endpoint without credentials:\'include\' (cookie never sent): ' + missing.join(', '));
});

test('the dashboard still calls its session endpoints (relative)', () => {
  assert.match(DASH, /['"]\/api\/profile/, 'profile must be called via a relative path');
  assert.match(DASH, /['"]\/api\/luna-brain/, 'luna-brain must be called via a relative path');
  assert.match(DASH, /['"]\/api\/luna-stats/, 'luna-stats must be called via a relative path');
});

test('client provisioning hands out a dashboard URL on a host where sign-in works', () => {
  const CLIENTS_SRC = read('api/clients.js');
  assert.doesNotMatch(CLIENTS_SRC, /dashUrl[^\n]*luna-chat-endpoint\.vercel\.app/,
    'the dashboard URL must not point at *.vercel.app — the tg_session cookie is scoped to travelify.io, so sign-in is impossible there');
  assert.match(CLIENTS_SRC, /DASHBOARD_HOST\s*=\s*'chat\.travelify\.io'/, 'provisioning must use a travelify.io host');
});

test('no dead CORS host: luna-chat.travelify.io is not a real alias', () => {
  fs.readdirSync(path.join(__dirname, '..', 'api')).filter(f => f.endsWith('.js')).forEach(function (f) {
    assert.doesNotMatch(read('api/' + f), /luna-chat\.travelify\.io/,
      f + ' references luna-chat.travelify.io, which does not resolve (the real alias is lunachat.travelify.io)');
  });
});

test('the widget keeps ABSOLUTE endpoints (it runs on third-party client sites)', () => {
  // The opposite invariant: widget-core.js is embedded on client websites, so its
  // endpoints must stay absolute. It uses visitor-mode tokens, not a session cookie.
  const WIDGET_SRC = read('public/widget-core.js');
  assert.match(WIDGET_SRC, /https:\/\/luna-chat-endpoint\.vercel\.app\/api\/luna-chat/,
    'the widget must keep an absolute endpoint');
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
