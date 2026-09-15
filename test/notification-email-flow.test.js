// The notification address, driven through the real handlers.
//
// The unit tests pin what the resolver decides. This pins that the decision
// actually reaches SendGrid — through notify-lead (leave a message), which
// sends through @sendgrid/mail, and through luna-enquiry (get this priced),
// which posts to the SendGrid API itself. Two different send paths, one
// answer, which is exactly the thing that used to drift.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.AIRTABLE_KEY = 'test-key';
process.env.SENDGRID_API_KEY = 'SG.test';
delete process.env.UPSTASH_REDIS_REST_URL;   // limiter fails open

// ── captured mailbox for the @sendgrid/mail path ──
const sent = [];
const fake = '__fake_sendgrid_notify__';
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@sendgrid/mail') return fake;
  return realResolve.call(this, request, ...rest);
};
require.cache[fake] = {
  id: fake, filename: fake, loaded: true,
  exports: { setApiKey() {}, async send(m) { sent.push(m); return [{ statusCode: 202 }]; } }
};

const notifyLead = require('../api/notify-lead.js');
const lunaEnquiry = require('../api/luna-enquiry.js');

const CLIENT_ID = 'recCUKYX6wk03bgWl';   // rec + 14

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {}; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r;
  return r;
}

// Airtable answers with this client; anything posted to SendGrid's REST API is
// captured instead of sent.
const posted = [];
function stub(fields) {
  posted.length = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('api.sendgrid.com') !== -1) {
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 202, json: async () => ({}) };
    }
    if (u.indexOf('/' + CLIENT_ID) !== -1) {
      return { ok: true, status: 200, json: async () => ({ id: CLIENT_ID, fields: fields }) };
    }
    if (u.indexOf('filterByFormula') !== -1) {
      // client lookup by name (notify-lead) or enquiry idempotency check
      const formula = decodeURIComponent((u.split('filterByFormula=')[1] || '').split('&')[0]);
      if (formula.indexOf('ConversationID') !== -1) {
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ records: [{ id: CLIENT_ID, fields: fields }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'recNEW', fields: {} }) };
  };
}

const leaveMessage = async () => {
  const res = mockRes();
  await notifyLead({
    method: 'POST',
    headers: { 'x-forwarded-for': '1.2.3.4' },
    body: { clientName: 'Booking Vacante', name: 'Anca', email: 'anca@example.ro', message: 'Please call me', type: 'left_message' }
  }, res);
  return res;
};

const askForAPrice = async () => {
  const res = mockRes();
  await lunaEnquiry({
    method: 'POST',
    headers: { 'x-forwarded-for': '1.2.3.4' },
    body: { clientId: CLIENT_ID, name: 'Anca', email: 'anca@example.ro', brief: { destination: 'Malaga' } }
  }, res);
  return res;
};

test('with no NotificationEmail set, both paths email ContactEmail as they always did', async () => {
  sent.length = 0;
  stub({ ClientName: 'Booking Vacante', ContactEmail: 'rares.biris@transilvania-soft.ro' });

  const lead = await leaveMessage();
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.body));
  assert.equal(lead.body.sent, true);
  assert.deepEqual(sent[0].to, ['rares.biris@transilvania-soft.ro']);

  const enq = await askForAPrice();
  assert.equal(enq.statusCode, 200, JSON.stringify(enq.body));
  assert.deepEqual(posted[0].personalizations[0].to, [{ email: 'rares.biris@transilvania-soft.ro' }]);
});

test('once the client sets their own address, both paths go there instead', async () => {
  sent.length = 0;
  stub({
    ClientName: 'Booking Vacante',
    ContactEmail: 'rares.biris@transilvania-soft.ro',
    NotificationEmail: 'rezervari@bookingvacante.ro'
  });

  await leaveMessage();
  assert.deepEqual(sent[0].to, ['rezervari@bookingvacante.ro']);

  await askForAPrice();
  assert.deepEqual(posted[0].personalizations[0].to, [{ email: 'rezervari@bookingvacante.ro' }]);
});

test('a list reaches every address on it', async () => {
  sent.length = 0;
  stub({
    ClientName: 'Booking Vacante',
    ContactEmail: 'rares.biris@transilvania-soft.ro',
    NotificationEmail: 'rezervari@bookingvacante.ro, anca@bookingvacante.ro'
  });

  await leaveMessage();
  assert.deepEqual(sent[0].to, ['rezervari@bookingvacante.ro', 'anca@bookingvacante.ro']);

  await askForAPrice();
  assert.deepEqual(posted[0].personalizations[0].to, [
    { email: 'rezervari@bookingvacante.ro' },
    { email: 'anca@bookingvacante.ro' }
  ]);
});

test('a client with nothing set anywhere is a no-op, not a 500', async () => {
  sent.length = 0;
  stub({ ClientName: 'Booking Vacante' });

  const lead = await leaveMessage();
  assert.equal(lead.statusCode, 200);
  assert.equal(lead.body.sent, false);
  assert.match(lead.body.reason, /no notification address/);
  assert.equal(sent.length, 0);

  const enq = await askForAPrice();
  assert.equal(enq.statusCode, 200, JSON.stringify(enq.body));
  assert.equal(posted.length, 0, 'the enquiry must still be written, just not emailed');
});

test('the visitor can still reply straight to the enquirer', async () => {
  // The notification address is who it goes TO. Reply-To stays the visitor, so
  // hitting reply answers them and not the shop's own inbox.
  sent.length = 0;
  stub({ ClientName: 'Booking Vacante', NotificationEmail: 'rezervari@bookingvacante.ro' });
  await leaveMessage();
  assert.equal(sent[0].replyTo, 'anca@example.ro');
});
