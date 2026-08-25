// The full cross-device recall round trip, with a real code store.
//
// The sibling suite (visitor-recall.test.js) runs with Upstash unconfigured, so
// it proves every FAILURE looks alike but cannot prove success works. This one
// stands up an in-memory Redis and a captured mailbox and walks the whole
// journey: request a code, read it out of the email, verify it, get the memory.
//
// It also pins the things that only appear once the store is real: a code
// cannot be used twice, cannot be brute forced past the attempt cap, and cannot
// be redeemed by a different client or a different address.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.AIRTABLE_KEY = 'test-key';
process.env.LUNA_RECALL_SECRET = 'recall-secret';
process.env.SENDGRID_API_KEY = 'SG.test';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.local';
process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';

// ── capture outgoing mail instead of sending it ──
const sent = [];
const fakeSg = '__fake_sendgrid__';
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@sendgrid/mail') return fakeSg;
  return realResolve.call(this, request, ...rest);
};
require.cache[fakeSg] = {
  id: fakeSg, filename: fakeSg, loaded: true,
  exports: { setApiKey() {}, async send(msg) { sent.push(msg); return [{ statusCode: 202 }]; } }
};

// ── a small in-memory Redis, driven through the Upstash pipeline shape ──
const store = new Map();
function redisExec(cmd) {
  const op = String(cmd[0]).toUpperCase();
  const key = cmd[1];
  if (op === 'SET') { store.set(key, cmd[2]); return 'OK'; }
  if (op === 'GET') return store.has(key) ? store.get(key) : null;
  if (op === 'DEL') { const had = store.delete(key); return had ? 1 : 0; }
  if (op === 'INCR') { const n = (parseInt(store.get(key), 10) || 0) + 1; store.set(key, String(n)); return n; }
  if (op === 'EXPIRE') return 1;
  return null;
}

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

function stubNetwork(known) {
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('fake-redis.local')) {
      const cmds = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => cmds.map((c) => ({ result: redisExec(c) })) };
    }
    if (u.includes('api.airtable.com')) {
      const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
      if (formula.includes('ClientName')) {
        return { ok: true, status: 200, json: async () => ({ records: [CLIENT] }) };
      }
      return { ok: true, status: 200, json: async () => ({ records: known ? [CONV] : [] }) };
    }
    throw new Error('unexpected call: ' + u);
  };
}

const handler = require('../api/visitor-recall.js');

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {}; r.end = () => r;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const call = async (action, body) => {
  const res = mockRes();
  await handler({ method: 'POST', headers: {}, body, query: { action } }, res);
  return res;
};

const codeFromMail = () => {
  const m = sent[sent.length - 1];
  const hit = /Your code is (\d{6})/.exec(m.text);
  return hit && hit[1];
};

function reset(known) { store.clear(); sent.length = 0; stubNetwork(known); }

// ══ the journey ══

test('a returning visitor on a new device gets their memory back', async () => {
  reset(true);
  const req = await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  assert.deepEqual(req.body, { ok: true });

  assert.equal(sent.length, 1, 'a code should have been emailed');
  assert.equal(sent[0].to, 'sarah@example.com');
  const code = codeFromMail();
  assert.match(code, /^\d{6}$/);

  const res = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.found, true);
  assert.equal(res.body.name, 'Sarah Bennett');
  assert.match(res.body.summary, /Maldives/);
});

test('the emailed code is never the raw value in the store', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const code = codeFromMail();
  const stored = [...store.values()].join(' ');
  assert.ok(!stored.includes(code), 'the code itself must not be recoverable from the store');
  assert.ok(!stored.includes('sarah@example.com'), 'nor the address');
});

test('an unknown address is emailed nothing at all', async () => {
  reset(false);
  const res = await call('request', { clientName: 'Snow Dragons', email: 'stranger@example.com' });
  assert.deepEqual(res.body, { ok: true }, 'but the answer is still identical');
  assert.equal(sent.length, 0, 'we must not be usable as a machine for posting mail');
});

// ══ the code cannot be reused or ground down ══

test('a code works exactly once', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const code = codeFromMail();

  const first = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code });
  assert.equal(first.body.ok, true);

  const replay = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code });
  assert.equal(replay.body.ok, false, 'a replayed code must not work');
  assert.ok(!replay.body.found);
});

test('guessing is capped, and the cap burns the code', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const code = codeFromMail();
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    const r = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code: wrong });
    assert.equal(r.body.ok, false);
  }
  // Past the cap the real code is dead too — that is the point.
  const real = await call('verify', { clientName: 'Snow Dragons', email: 'sarah@example.com', code });
  assert.equal(real.body.ok, false, 'the code must be burned once the cap is hit');
});

test('a code issued for one address cannot redeem another', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const code = codeFromMail();
  const res = await call('verify', { clientName: 'Snow Dragons', email: 'someone@else.com', code });
  assert.equal(res.body.ok, false);
});

test('a code issued for one client cannot redeem another', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const code = codeFromMail();
  // Same address, different client: the stored digest is bound to the client id.
  global.fetch = (function (inner) {
    return async (url, opts) => {
      const u = String(url);
      if (u.includes('api.airtable.com') && !u.includes('ClientName')) return inner(url, opts);
      if (u.includes('api.airtable.com')) {
        return { ok: true, status: 200, json: async () => ({ records: [{ id: 'recOTHER', fields: { ClientName: 'Other Agency' } }] }) };
      }
      return inner(url, opts);
    };
  })(global.fetch);
  const res = await call('verify', { clientName: 'Other Agency', email: 'sarah@example.com', code });
  assert.equal(res.body.ok, false);
});

test('the email says what it is for and how to ignore it', async () => {
  reset(true);
  await call('request', { clientName: 'Snow Dragons', email: 'sarah@example.com' });
  const m = sent[0];
  assert.match(m.subject, /^Your code: \d{6}$/);
  assert.match(m.text, /expires in 10 minutes/);
  assert.match(m.text, /only be used once/);
  assert.match(m.text, /did not ask for this/,
    'an unexpected code must tell the recipient nothing has changed');
  assert.match(m.text, /Snow Dragons/, 'and which agency it is about');
});
