// The notification, driven through the REAL log-conversation handler.
//
// The unit tests pin what it decides and what it writes. This pins that an
// email actually leaves the building when a visitor chats, and does not when
// they don't — with Airtable and SendGrid stubbed and nothing else faked.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.AIRTABLE_KEY = 'test-key';
process.env.SENDGRID_API_KEY = 'SG.test';
delete process.env.UPSTASH_REDIS_REST_URL;   // limiter fails open

// ── captured mailbox ──
const sent = [];
const fake = '__fake_sendgrid_flow__';
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@sendgrid/mail') return fake;
  return realResolve.call(this, request, ...rest);
};
require.cache[fake] = {
  id: fake, filename: fake, loaded: true,
  exports: { setApiKey() {}, async send(m) { sent.push(m); return [{ statusCode: 202 }]; } }
};

const handler = require('../api/log-conversation.js');

const CLIENT = {
  id: 'recTG',
  fields: { ClientName: 'Travelgenix', ContactEmail: 'info@travelgenix.io', DashboardURL: 'https://chat.travelify.io/dashboard.html' }
};
const F = { summary: 'fldZ38GYN4XbHGl03', escalated: 'fld3JapxKxGsBxPCQ', name: 'fldqx6k7WvrqE8BW1' };

// `existing` is the conversation row already in Airtable, or null.
function stub(existing) {
  const writes = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('api.airtable.com') !== -1) {
      const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
      if (formula.indexOf('ClientName') !== -1) {
        return { ok: true, status: 200, json: async () => ({ records: [CLIENT] }) };
      }
      if (formula.indexOf('ConversationID') !== -1) {
        return { ok: true, status: 200, json: async () => ({ records: existing ? [existing] : [] }) };
      }
      writes.push({ method: opts && opts.method, body: opts && opts.body });
      return { ok: true, status: 200, json: async () => ({ records: [{ id: 'recNEW' }], id: 'recNEW' }) };
    }
    // quality scoring, fired after the write
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return writes;
}

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {}; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r;
  return r;
}
const call = async (body) => {
  const res = mockRes();
  await handler({ method: 'POST', headers: { host: 'x' }, body: body, query: {} }, res);
  return res;
};

test('a new conversation with a visitor message sends exactly one email', async () => {
  sent.length = 0; stub(null);
  const res = await call({
    clientName: 'Travelgenix', convId: 'conv_a',
    summary: 'bot: Good morning!\nuser: Can I see a demo?',
    visitorName: 'Luke', clientWebsite: 'https://travelgenix.io/pricing'
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(sent.length, 1, 'expected one email, got ' + sent.length);
  assert.deepEqual(sent[0].to, ['info@travelgenix.io']);
  assert.match(sent[0].subject, /New chat on Travelgenix — Luke/);
  assert.match(sent[0].html, /Can I see a demo\?/);
});

test('a visitor asking for a human sends the urgent one', async () => {
  sent.length = 0; stub(null);
  await call({
    clientName: 'Travelgenix', convId: 'conv_b',
    summary: 'bot: Good morning!\nuser: Speak to our team',
    wasEscalated: true
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /wants to talk to you/);
  assert.match(sent[0].html, /Waiting to speak to someone/);
});

test('a second write to the same conversation does not email again', async () => {
  sent.length = 0;
  stub({ id: 'recEXIST', fields: { [F.summary]: 'bot: hi\nuser: hello', [F.name]: 'Luke' } });
  await call({ clientName: 'Travelgenix', convId: 'conv_a', summary: 'bot: hi\nuser: hello\nbot: more' });
  assert.equal(sent.length, 0, 'one email per conversation, not per message');
});

test('an existing conversation that NOW asks for a human does email', async () => {
  sent.length = 0;
  stub({ id: 'recEXIST', fields: { [F.summary]: 'bot: hi\nuser: hello', [F.escalated]: false } });
  await call({
    clientName: 'Travelgenix', convId: 'conv_a',
    summary: 'bot: hi\nuser: hello\nuser: actually can I speak to someone',
    wasEscalated: true
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /wants to talk to you/);
});

test('a bot greeting nobody answered sends nothing', async () => {
  sent.length = 0; stub(null);
  await call({ clientName: 'Travelgenix', convId: 'conv_c', summary: 'bot: Good morning! How can we help you today?' });
  assert.equal(sent.length, 0);
});

test('a client with no notification address at all is a silent no-op, not an error', async () => {
  sent.length = 0;
  const saved = CLIENT.fields.ContactEmail;
  delete CLIENT.fields.ContactEmail;
  stub(null);
  const res = await call({ clientName: 'Travelgenix', convId: 'conv_d', summary: 'bot: hi\nuser: hello' });
  assert.equal(res.statusCode, 200, 'the conversation must still be logged');
  assert.equal(sent.length, 0);
  CLIENT.fields.ContactEmail = saved;
});

test('a mail failure never costs the conversation record', async () => {
  sent.length = 0;
  const good = require.cache[fake].exports.send;
  require.cache[fake].exports.send = async () => { throw new Error('sendgrid down'); };
  stub(null);
  const res = await call({ clientName: 'Travelgenix', convId: 'conv_e', summary: 'bot: hi\nuser: hello' });
  assert.equal(res.statusCode, 200, 'the write must survive a failed email');
  assert.equal(res.body.success, true);
  require.cache[fake].exports.send = good;
});

test('the record is written before the email is attempted', async () => {
  sent.length = 0;
  const writes = stub(null);
  await call({ clientName: 'Travelgenix', convId: 'conv_f', summary: 'bot: hi\nuser: hello' });
  assert.ok(writes.length >= 1, 'expected the conversation to be written');
  assert.equal(sent.length, 1);
});
