// /api/scan-page must require a real session, not just a client's name.
//
// The endpoint used to accept the X-Client-Name header on its own, with a
// comment claiming "tg-auth-gate session cookie handles real auth at the gate".
// That was wrong. tg-auth-gate runs in the BROWSER: it gates the dashboard page,
// not the API route. Nothing stopped a direct POST.
//
// And clientName is public. It sits in the embed snippet on every page of every
// client's website. So anyone could:
//
//   - use our server as an open URL fetcher, from our IP, with our reputation
//   - burn a named client's scan budget until their own Train Luna stopped working
//
// This was the last endpoint trusting a header alone. It now takes the same
// route as /api/luna-brain: validate the central session, resolve the client,
// then check the caller is entitled to that client.
//
// These tests drive the real handler with stubbed network, so they fail if the
// checks are removed or reordered — not just if the source text changes.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

process.env.AIRTABLE_KEY = 'test-key';
delete process.env.UPSTASH_REDIS_REST_URL; // limiter fails open, so it is never the reason for a deny

// Stub the scraper itself. Its SSRF protections have their own tests, and doing
// a real DNS lookup here would make these auth tests depend on the network.
// What matters is whether scrapeUrl is reached at all.
const scrape = require('../lib/safe-scrape');
const scraped = [];
scrape.scrapeUrl = async function (url) {
  scraped.push(String(url));
  return {
    ok: true, url: String(url), title: 'About us',
    content: 'Some page text about the agency.', charCount: 32, wordCount: 6
  };
};

const handler = require('../api/scan-page.js');

const STAFF = { email: 'andy.speight@agendas.group', role: 'owner' };
const CLIENT_USER = { email: 'director@thatsmydreamholiday.com', role: 'owner' };

const SNOW = { id: 'recSNOW', fields: { ClientName: 'Snow Dragons', AuthClientId: 'authSNOW' } };

// Stubs the login service and Airtable. `scraped` (module scope, above) records
// whether the target URL was ever fetched — the point of the denial tests is
// that it never is.
function stubNetwork(opts) {
  opts = opts || {};
  scraped.length = 0;
  const calls = { me: 0, airtable: [] };
  global.fetch = async (url) => {
    const u = String(url);

    if (u.indexOf('id.travelify.io/api/auth/me') !== -1) {
      calls.me++;
      if (!opts.user) return { ok: false, status: 401, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          user: { email: opts.user.email, role: opts.user.role },
          client: opts.authClientId ? { recordId: opts.authClientId } : null
        })
      };
    }

    if (u.indexOf('api.airtable.com') !== -1) {
      const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
      calls.airtable.push(formula);
      const records = (opts.airtable || function () { return []; })(formula);
      return { ok: true, status: 200, json: async () => ({ records: records }) };
    }

    throw new Error('unexpected network call in test: ' + u);
  };
  return calls;
}

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

function post(overrides) {
  return Object.assign({
    method: 'POST',
    headers: { 'x-client-name': 'Snow Dragons', cookie: 'tg_session=abc' },
    body: { url: 'https://snowdragons.co.uk/about' },
    query: {}
  }, overrides || {});
}

// ── the hole that was open ──

test('a request with no session is refused, and nothing is fetched', async () => {
  // This is the exact request an attacker could make: the client name off the
  // public embed snippet, and no credentials at all.
  const calls = stubNetwork({});
  const res = mockRes();
  await handler(post({ headers: { 'x-client-name': 'Snow Dragons' } }), res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(scraped, [],
    'the server must not fetch a URL for an unauthenticated caller');
});

test('an expired or invalid session is refused', async () => {
  const calls = stubNetwork({ user: null });
  const res = mockRes();
  await handler(post(), res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(scraped, []);
});

test('a signed-in client cannot scan for a DIFFERENT client', async () => {
  // Knowing a name is not entitlement. TMDH's owner sending Snow Dragons' name
  // gets nothing.
  const calls = stubNetwork({
    user: CLIENT_USER,
    authClientId: 'authTMDH',
    // The name lookup finds the record; BOTH entitlement lookups (AuthClientId
    // and the legacy ContactEmail fallback) come back empty.
    airtable: (formula) => formula.indexOf('RECORD_ID()') !== -1 ? [] : [SNOW]
  });
  const res = mockRes();
  await handler(post(), res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(scraped, [],
    'a name alone must not spend another client scan budget');
});

// ── and the legitimate path still works ──

test('the client who owns the account can scan, and the page comes back', async () => {
  const calls = stubNetwork({
    user: CLIENT_USER,
    authClientId: 'authSNOW',
    airtable: () => [SNOW]
  });
  const res = mockRes();
  await handler(post(), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.match(res.body.content, /Some page text/);
  assert.equal(scraped.length, 1);
});

test('Travelgenix staff supporting a client can scan for them', async () => {
  const calls = stubNetwork({ user: STAFF, authClientId: 'authTG', airtable: () => [SNOW] });
  const res = mockRes();
  await handler(post(), res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(scraped.length, 1);
});

test('an unknown client name is a 404, and still fetches nothing', async () => {
  const calls = stubNetwork({ user: STAFF, authClientId: 'authTG', airtable: () => [] });
  const res = mockRes();
  await handler(post({
    headers: { 'x-client-name': 'Not A Real Client', cookie: 'tg_session=abc' },
    body: { url: 'https://example.com/' }
  }), res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(scraped, []);
});

// ── ordering, so a flood cannot be aimed at the login service ──

test('the per-IP limit is applied BEFORE the session hop', async () => {
  const SRC = read('api/scan-page.js');
  const rl = SRC.indexOf("ipKey: 'scan-page'");
  const session = SRC.indexOf('auth.validateSession');
  assert.ok(rl !== -1 && session !== -1);
  assert.ok(rl < session,
    'checking the session first would turn a flood here into a flood against id.travelify.io');
});

test('the per-client limit is keyed on the resolved record id, not the header', async () => {
  const SRC = read('api/scan-page.js');
  assert.match(SRC, /'rl:scan-page:client:' \+ client\.id/);
  assert.doesNotMatch(SRC, /scan-page:client:' \+ clientName/,
    'keying on the supplied name let anyone spend a named client budget');
});

test('the per-client limit does not double-count the per-IP one', async () => {
  // checkIpAndKey() INCRs the IP counter every time it is called. Calling it
  // twice in one request would silently halve the IP limit from 20 to 10.
  const SRC = read('api/scan-page.js');
  const calls = SRC.match(/ratelimit\.checkIpAndKey\(/g) || [];
  assert.equal(calls.length, 1, 'expected exactly one checkIpAndKey call per request');
});

// ── the comment that made this look safe ──

test('the false claim about tg-auth-gate is gone from the source', async () => {
  // It read: "tg-auth-gate session cookie handles real auth at the gate".
  // tg-auth-gate is browser-side. Believing that comment is why this endpoint
  // sat unauthenticated through two previous reviews.
  const SRC = read('api/scan-page.js');
  assert.doesNotMatch(SRC, /handles real auth at the gate/);
  assert.doesNotMatch(SRC, /Auth: just X-Client-Name/);
});

test('credentialed CORS is not paired with a wildcard origin', async () => {
  const SRC = read('api/scan-page.js');
  assert.doesNotMatch(SRC, /Access-Control-Allow-Origin', '\*'/,
    'a wildcard origin with credentials is rejected by browsers and unsafe besides');
  assert.match(SRC, /ALLOWED_ORIGINS\.indexOf\(origin\) !== -1/);
});
