// /api/visitor-history must not answer questions about an email address.
//
// It used to accept { clientName, email } and reply with whether that person had
// chatted with that agency, their name, when they last spoke, how many times, the
// topics, and a 400-character summary of their most recent conversation.
//
// Neither half of that request was a credential:
//
//   - clientName is public. It is in the embed snippet on every page of every
//     client's website, viewable with View Source.
//   - the email was never verified. No code, no session. Typing an address was
//     the entire claim to be that person.
//
// So it answered "has sarah@example.com been talking to this travel agent, and
// what about" for anybody who asked. For a travel agency the summary is who
// someone is honeymooning with and what they can afford. The rate limit (30 a
// minute per IP) shaped the traffic; it did not make the answer any less wrong,
// and an attacker with a list of addresses does not need to hurry.
//
// It is now visitorId-only. A visitorId is a random token held solely by the
// visitor's own browser, so presenting one is evidence of being that browser.
//
// The cost, stated plainly so nobody re-adds it by accident: recall no longer
// follows a visitor to a new device when they type the same email. Putting that
// back means emailing a code to the address, not trusting the address.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

process.env.AIRTABLE_KEY = 'test-key';
delete process.env.UPSTASH_REDIS_REST_URL;

const handler = require('../api/visitor-history.js');

const CLIENT = { id: 'recCLIENT', fields: { ClientName: 'Snow Dragons' } };
const CONV = {
  id: 'recCONV',
  fields: {
    fldqx6k7WvrqE8BW1: 'Sarah Bennett',
    fldZXcvl7k3FS5Gu7: 'sarah@example.com',
    fldHkuGAIZMHYLWoC: 'v_0123456789abcdef0123456789abcdef',
    fldZ38GYN4XbHGl03: 'Honeymoon to the Maldives, budget about 8k, travelling with her new partner.',
    fld1GghMiUnAmdtow: '2026-07-20T10:00:00.000Z',
    flde1PCByneD05YyG: ['recCLIENT'],
    fldQNFhnyo3W2ngTZ: [{ name: 'Honeymoon' }, { name: 'Maldives' }]
  }
};

// Records the Airtable formula so we can prove what was and was not searched.
function stubAirtable() {
  const formulas = [];
  global.fetch = async (url) => {
    const u = String(url);
    const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
    formulas.push(formula);
    if (formula.includes('ClientName')) {
      return { ok: true, status: 200, json: async () => ({ records: [CLIENT] }) };
    }
    // The conversation search: only ever answer for the real visitorId.
    const hit = formula.includes(CONV.fields.fldHkuGAIZMHYLWoC);
    return { ok: true, status: 200, json: async () => ({ records: hit ? [CONV] : [] }) };
  };
  return formulas;
}

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const call = async (body) => {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body: body, query: {} }, res);
  return res;
};

// ── the hole ──

test('an email alone gets nothing back', async () => {
  // The exact request that used to work. Anyone could make it.
  const formulas = stubAirtable();
  const res = await call({ clientName: 'Snow Dragons', email: 'sarah@example.com' });

  assert.equal(res.statusCode, 400);
  assert.ok(!res.body.found, 'no memory may come back for an unverified address');
  assert.ok(!formulas.some((f) => f.includes('sarah@example.com')),
    'the address must never reach an Airtable search');
});

test('an email is ignored even when a visitorId is also sent', async () => {
  // Otherwise an attacker with any valid-looking visitorId of their own could
  // still smuggle the email lookup through the OR clause the old code built.
  const formulas = stubAirtable();
  const res = await call({
    clientName: 'Snow Dragons',
    email: 'sarah@example.com',
    visitorId: 'v_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'   // an attacker's own browser
  });

  assert.equal(res.body.found, false, 'their own id must find their own nothing');
  const search = formulas.find((f) => f.includes('VisitorId'));
  assert.ok(search, 'expected a visitorId search');
  assert.ok(!search.includes('sarah@example.com'));
  assert.ok(!search.includes('VisitorEmail'));
  assert.ok(!search.startsWith('OR('),
    'the OR clause is what let an email ride along with a visitorId');
});

test('the handler no longer contains an email lookup at all', async () => {
  const SRC = read('api/visitor-history.js');
  assert.doesNotMatch(SRC, /\{VisitorEmail\}=/,
    'searching the email field is the whole defect');
  assert.doesNotMatch(SRC, /function isValidEmail/,
    'the validator only existed to let an email through');
});

// ── the feature that remains ──

test('a visitor own browser still gets its memory back', async () => {
  stubAirtable();
  const res = await call({
    clientName: 'Snow Dragons',
    visitorId: 'v_0123456789abcdef0123456789abcdef'
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.found, true);
  assert.equal(res.body.name, 'Sarah Bennett');
  assert.equal(res.body.count, 1);
  assert.match(res.body.summary, /Honeymoon/);
  assert.match(res.body.summary, /Maldives/);
});

test('memory is still scoped to the one client', async () => {
  // A conversation linked to a different client must not come back, even for the
  // right visitorId — one browser can chat to several agencies.
  global.fetch = async (url) => {
    const u = String(url);
    const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
    if (formula.includes('ClientName')) {
      return { ok: true, status: 200, json: async () => ({ records: [{ id: 'recOTHER', fields: { ClientName: 'Other Agency' } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ records: [CONV] }) };
  };
  const res = await call({
    clientName: 'Other Agency',
    visitorId: 'v_0123456789abcdef0123456789abcdef'
  });
  assert.equal(res.body.found, false, 'another agency must not see this conversation');
});

test('full transcripts are still never returned', async () => {
  stubAirtable();
  const res = await call({ clientName: 'Snow Dragons', visitorId: 'v_0123456789abcdef0123456789abcdef' });
  assert.deepEqual(Object.keys(res.body).sort(), ['count', 'found', 'lastSeen', 'name', 'summary']);
});

// ── input handling ──

test('a missing or malformed visitorId is a 400, not a wildcard search', async () => {
  const formulas = stubAirtable();
  for (const body of [
    { clientName: 'Snow Dragons' },
    { clientName: 'Snow Dragons', visitorId: '' },
    { clientName: 'Snow Dragons', visitorId: 'short' },
    { clientName: 'Snow Dragons', visitorId: "v_'" + 'a'.repeat(20) },
    { clientName: 'Snow Dragons', visitorId: 'v_' + 'a'.repeat(200) }
  ]) {
    const res = await call(body);
    assert.equal(res.statusCode, 400, 'expected 400 for ' + JSON.stringify(body));
  }
  assert.equal(formulas.length, 0, 'no rejected input may reach Airtable');
});

test('an unknown client name is a 404', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) });
  const res = await call({ clientName: 'Not A Client', visitorId: 'v_0123456789abcdef0123456789abcdef' });
  assert.equal(res.statusCode, 404);
});

// ── the visitorId has to be worth trusting ──

test('the widget mints visitorIds from the crypto RNG', async () => {
  // The id is now the only key to a visitor's memory, so it has to be
  // unguessable. The old one was Date.now() plus Math.random, and V8's Math.random
  // state is recoverable from a few outputs.
  const W = read('public/widget-core.js');
  assert.match(W, /crypto\.getRandomValues\(b\)/);
  assert.doesNotMatch(W, /visitorId = "v_" \+ Date\.now\(\) \+ "_" \+ Math\.random/,
    'the guessable generator must be gone from both the try and the catch');
});

test('a minted visitorId passes the server validator and has real entropy', async () => {
  // Mirror the widget generator and check it against the server's own regex.
  const crypto = require('node:crypto');
  const mint = () => {
    const b = crypto.randomBytes(16);
    let s = '';
    for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return 'v_' + s;
  };
  const id = mint();
  assert.match(id, /^[A-Za-z0-9_\-]{6,64}$/, 'must satisfy isValidVisitorId');
  const many = new Set(Array.from({ length: 2000 }, mint));
  assert.equal(many.size, 2000, 'no collisions across 2000 ids');
});

// ── the widget must stop sending the email ──

test('the widget sends only clientName and visitorId', async () => {
  const W = read('public/widget-core.js');
  const body = W.split('/api/visitor-history"')[1] || '';
  assert.match(body.slice(0, 500), /JSON\.stringify\(\{ clientName: C\.clientName, visitorId: visitorId \}\)/);
  assert.doesNotMatch(body.slice(0, 500), /email:/,
    'an email in the request is what the endpoint used to answer');
});

test('the widget no longer looks a visitor up the moment they type an email', async () => {
  // That call was the cross-device path: a device the server had never seen,
  // identified purely by a typed address.
  const W = read('public/widget-core.js');
  assert.doesNotMatch(W, /if \(emailValid\) \{ try \{ fetchServerMemory\(\); \}/);
});

test('recall still runs for a returning visitor, and costs nothing for a new one', async () => {
  const W = read('public/widget-core.js');
  assert.match(W, /var hadStoredProfile = !!visitorProfile;/,
    'ensureProfile() assigns visitorProfile, so the flag must be captured before it');
  assert.match(W, /if \(hadStoredProfile\) fetchServerMemory\(\);/);
  assert.doesNotMatch(W, /if \(visitorProfile\) fetchServerMemory\(\);/,
    'that gate is always true by the time it is reached, so every first-time visitor paid for a lookup');
  assert.doesNotMatch(W, /\(visitorProfile && visitorProfile\.email\) \|\| visitorEmail\) fetchServerMemory/,
    'gating on an email made no sense once the lookup stopped using one');
});
