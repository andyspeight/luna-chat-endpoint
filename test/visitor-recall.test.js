// Cross-device recall must not rebuild the oracle it replaced.
//
// /api/visitor-history used to take an email and hand back that person's
// memory, with nothing proving the asker was them. clientName is public and the
// email was never verified, so it answered "has this person been talking to
// this travel agent, and what about" for anybody who asked. We cut it back to
// visitorId-only, which cost the feature.
//
// /api/visitor-recall brings it back behind a code emailed to the address. The
// danger is obvious: an endpoint that takes an email and does something is one
// careless response away from being the same leak. These tests pin the four
// properties that stop it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const recall = require('../lib/visitor-recall');

process.env.AIRTABLE_KEY = 'test-key';
process.env.LUNA_RECALL_SECRET = 'recall-secret';
delete process.env.UPSTASH_REDIS_REST_URL;   // store fails open; never the reason for a pass

const handler = require('../api/visitor-recall.js');

const SECRET = 'recall-secret';
const CLIENT = { id: 'recCLIENT', fields: { ClientName: 'Snow Dragons' } };
const CONV = {
  id: 'recCONV',
  fields: {
    fldqx6k7WvrqE8BW1: 'Sarah Bennett',
    fldZXcvl7k3FS5Gu7: 'sarah@example.com',
    fldZ38GYN4XbHGl03: 'Honeymoon to the Maldives, budget about 8k.',
    fld1GghMiUnAmdtow: '2026-07-20T10:00:00.000Z',
    flde1PCByneD05YyG: ['recCLIENT'],
    fldQNFhnyo3W2ngTZ: [{ name: 'Honeymoon' }, { name: 'Maldives' }]
  }
};

// `known` decides whether the address has ever chatted here.
function stubAirtable(known) {
  const formulas = [];
  global.fetch = async (url) => {
    const u = String(url);
    const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
    formulas.push(formula);
    if (formula.includes('ClientName')) {
      return { ok: true, status: 200, json: async () => ({ records: [CLIENT] }) };
    }
    return { ok: true, status: 200, json: async () => ({ records: known ? [CONV] : [] }) };
  };
  return formulas;
}

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const call = async (action, body) => {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body, query: { action } }, res);
  return res;
};

// ══ 1. the request step must tell the caller NOTHING ══

test('a known and an unknown address get byte-identical answers', async () => {
  // This is the whole defence. Any difference — a count, a "sent", a status
  // code — turns this back into "does this person use this travel agent".
  stubAirtable(true);
  const known = await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  stubAirtable(false);
  const unknown = await call('request', { clientName: 'Snow Dragons', email: 'nobody@example.com' });

  assert.equal(known.statusCode, unknown.statusCode, 'status must not differ');
  assert.deepEqual(known.body, unknown.body, 'body must not differ');
  assert.deepEqual(known.body, { ok: true });
});

test('an unknown CLIENT also gets the same answer', async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) });
  const res = await call('request', { clientName: 'Not A Client', email: 'sarah@example.com' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('an upstream failure does not change the answer either', async () => {
  // A 502 here would say "that address matched something and then we fell over".
  global.fetch = async () => { throw new Error('Airtable down'); };
  const res = await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('the request response never carries memory, a name or a count', async () => {
  stubAirtable(true);
  const res = await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  assert.deepEqual(Object.keys(res.body), ['ok']);
});

// ══ 2. no mail to strangers ══

test('a code is only mailed to an address that HAS chatted with this client', async () => {
  // Otherwise we are a machine for posting mail to arbitrary addresses.
  const SRC = read('api/visitor-recall.js');
  assert.match(SRC, /if \(rows\.length\) \{[\s\S]{0,400}sendCodeEmail/,
    'sending must be inside the rows.length check');
});

test('the per-address limit protects the RECIPIENT, not us', async () => {
  const SRC = read('api/visitor-recall.js');
  assert.match(SRC, /rl:recall-request:email:/);
  assert.match(SRC, /const perEmail = await ratelimit\.check\(/);
});

test('being rate-limited is not itself a signal', async () => {
  // A 429 on request would tell an attacker their address hit a real bucket.
  const SRC = read('api/visitor-recall.js');
  const requestBlock = SRC.split("if (action === 'request')")[1].split("if (action === 'verify')")[0];
  assert.doesNotMatch(requestBlock, /status\(429\)/,
    'the request step must answer 200 even when limited');
});

// ══ 3. every verify failure looks the same ══

test('wrong code, no code and unknown client are indistinguishable', async () => {
  stubAirtable(true);
  const wrong = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code: '000000' });
  const nocode = await call('verify', { clientName: 'Snow Dragons', email: 'nobody@example.com', code: '123456' });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) });
  const noclient = await call('verify', { clientName: 'Not A Client', email: 'sarah@example.com', code: '123456' });

  assert.equal(wrong.statusCode, nocode.statusCode);
  assert.equal(nocode.statusCode, noclient.statusCode);
  assert.deepEqual(wrong.body, nocode.body);
  assert.deepEqual(nocode.body, noclient.body);
  assert.equal(wrong.body.ok, false);
});

test('no memory leaks out of a failed verify', async () => {
  stubAirtable(true);
  const res = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code: '999999' });
  assert.ok(!res.body.found);
  assert.ok(!res.body.name);
  assert.ok(!res.body.summary);
});

test('a malformed code is rejected without reaching the store', async () => {
  stubAirtable(true);
  for (const code of ['', '1', '12345', '1234567', 'abcdef', '12 456', null]) {
    const res = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code });
    assert.equal(res.body.ok, false, 'expected rejection for ' + JSON.stringify(code));
  }
});

// ══ 4. the code itself ══

test('codes are crypto-random and uniformly six digits', () => {
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const c = recall.newCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 2900, 'expected near-unique draws, got ' + seen.size);
});

test('the code is stored as a keyed HMAC, never in the clear', () => {
  // Six digits is a million combinations: a bare hash would fall to an offline
  // sweep the moment Redis leaked.
  const h = recall.hashCode(SECRET, 'recCLIENT', 'sarah@example.com', '123456');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, '123456');
  assert.notEqual(h, recall.hashCode('other-secret', 'recCLIENT', 'sarah@example.com', '123456'),
    'the secret must actually key it');
});

test('a digest cannot be replayed against another client or another visitor', () => {
  const base = recall.hashCode(SECRET, 'recCLIENT', 'sarah@example.com', '123456');
  assert.notEqual(base, recall.hashCode(SECRET, 'recOTHER', 'sarah@example.com', '123456'));
  assert.notEqual(base, recall.hashCode(SECRET, 'recCLIENT', 'someone@else.com', '123456'));
});

test('code comparison is constant time', () => {
  const SRC = read('lib/visitor-recall.js');
  assert.match(SRC, /crypto\.timingSafeEqual/);
  assert.equal(recall.codesMatch('abc', 'abc'), true);
  assert.equal(recall.codesMatch('abc', 'abd'), false);
  assert.equal(recall.codesMatch('abc', 'abcd'), false);
  [null, undefined, 1, {}].forEach((v) => assert.equal(recall.codesMatch(v, 'abc'), false));
});

test('the redis key does not spell out who talks to whom', () => {
  const k = recall.codeKey(SECRET, 'recCLIENT', 'sarah@example.com');
  assert.ok(!k.includes('sarah'), 'the address must not be in the key: ' + k);
  assert.ok(!k.includes('example.com'));
  assert.match(k, /^recall:[0-9a-f]{32}$/);
});

test('the code is single use and attempt capped', () => {
  const SRC = read('api/visitor-recall.js');
  assert.match(SRC, /await dropCode\(key\);\s*\n\s*const rows = await findConversations/,
    'the code must be burned BEFORE the memory is returned, so a replay finds nothing');
  assert.match(SRC, /if \(attempts > recall\.MAX_ATTEMPTS\)/);
  assert.ok(recall.MAX_ATTEMPTS <= 5, 'cap must stay tight, got ' + recall.MAX_ATTEMPTS);
  assert.ok(recall.CODE_TTL_SECS <= 15 * 60, 'codes must be short lived, got ' + recall.CODE_TTL_SECS);
});

// ══ what the visitor gets back on success ══

test('a verified visitor gets the same compact memory, never a transcript', () => {
  const SRC = read('api/visitor-recall.js');
  assert.match(SRC, /function buildMemory/);
  assert.doesNotMatch(SRC, /Transcript|fld8fMjyXWmKcacoB/,
    'transcripts must never be in reach of this endpoint');
  assert.match(SRC, /link\.indexOf\(clientRecId\) !== -1/,
    'memory must stay scoped to the one client');
});

test('input is validated before anything else happens', async () => {
  for (const body of [
    { clientName: '', email: 'a@b.com' },
    { clientName: 'Snow Dragons', email: 'not-an-email' },
    { clientName: 'Snow Dragons', email: '' },
    { clientName: "Rob'); DROP--", email: 'a@b.com' }
  ]) {
    const res = await call('request', body);
    assert.equal(res.statusCode, 400, 'expected 400 for ' + JSON.stringify(body));
  }
});

test('an unknown action is refused', async () => {
  const res = await call('nonsense', { clientName: 'Snow Dragons', email: 'a@b.com' });
  assert.equal(res.statusCode, 400);
});

// ══ the widget side ══

test('the widget asks the server to SEND, never whether it knows the address', async () => {
  const W = read('public/widget-core.js');
  assert.match(W, /recallEndpoint\("request"\)/);
  assert.match(W, /JSON\.stringify\(\{ clientName: C\.clientName, email: email \}\)/);
  // And the old lookup stays gone.
  assert.doesNotMatch(W, /visitor-history[\s\S]{0,300}email:/,
    'visitor-history must never be sent an email again');
});

test('the code box is shown regardless of the answer', async () => {
  // Showing it only to people we recognise would put "we know you" back on the
  // screen, which is the same leak with extra steps.
  const W = read('public/widget-core.js');
  assert.match(W, /\.catch\(function\(\)\{\}\)\s*\n\s*\.then\(function\(\)\{ showRecallCodeEntry\(card, email\); \}\)/,
    'the code entry must follow the request whatever it returned, including a failure');
});

test('recall is offered, never triggered automatically', async () => {
  // A code lands in a real person's inbox. It happens when they ask.
  const W = read('public/widget-core.js');
  assert.match(W, /if \(emailValid && !isReturningVisitor\) \{ try \{ offerCrossDeviceRecall\(visitorEmail\); \}/);
  assert.match(W, /go\.addEventListener\("click", function\(\)\{/);
});

test('the widget builds its card with DOM nodes, not innerHTML', async () => {
  // The address is rendered into this card. textContent means it cannot become
  // markup, whatever the visitor typed.
  const W = read('public/widget-core.js');
  const card = W.split('function offerCrossDeviceRecall')[1].split('function showRecallCodeEntry')[0];
  assert.doesNotMatch(card, /innerHTML/, 'no innerHTML in the recall card');
  assert.match(card, /body\.textContent = "We can send a code to " \+ email/);
});

test('a verified recall lands in the same profile the same-device path uses', async () => {
  const W = read('public/widget-core.js');
  assert.match(W, /function applyRecalledMemory/);
  assert.match(W, /saveVisitorProfile\(p\);/);
  assert.match(W, /isReturningVisitor = true;/);
  assert.match(W, /maybeRegreet\(\);/);
});
