// Client Control provisions Luna Chat clients.
//
// Client Control is where client access is granted, so switching Luna Chat on
// there has to create the client here — with no human copying anything across.
// Every problem this week came from that copy step:
//   - Snow Dragons was live in Client Control with no Luna record at all
//   - Jamie Wake Travel had no App ID, so Luna invented search links that 404'd
//   - and no AuthClientId, so he was locked out of his own dashboard
//
// The endpoint is an UPSERT keyed on externalId (the Client Control client id),
// not on the name. Keying on name would mean flipping the toggle twice creates a
// duplicate — and two records with the same ClientName make every client lookup
// non-deterministic, since they all take the first match.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.AIRTABLE_KEY = 'test-key';

const clients = require('../api/clients.js');

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; }
  };
}

// Stub Airtable. Records live in `store`, keyed by id.
function installAirtable(store) {
  const calls = [];
  global.fetch = async function (url, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null });

    if (method === 'GET') {
      const m = decodeURIComponent(String(url)).match(/\{ExternalClientId\}='([^']*)'/);
      const ext = m ? m[1] : null;
      const found = Object.values(store).filter(r => (r.fields || {}).ExternalClientId === ext);
      return { ok: true, json: async () => ({ records: found }) };
    }
    if (method === 'POST') {
      const f = opts.body ? JSON.parse(opts.body).records[0].fields : {};
      const id = 'rec' + (Object.keys(store).length + 1);
      store[id] = { id, fields: Object.assign({}, f) };
      return { ok: true, json: async () => ({ records: [store[id]] }) };
    }
    if (method === 'PATCH') {
      const r = JSON.parse(opts.body).records[0];
      store[r.id].fields = Object.assign({}, store[r.id].fields, r.fields);
      return { ok: true, json: async () => ({ records: [store[r.id]] }) };
    }
    throw new Error('unexpected ' + method);
  };
  return calls;
}

const HDRS = { 'x-admin-pass': 'test-admin-pass', 'content-type': 'application/json' };
async function provision(body, store) {
  const res = mockRes();
  await clients({ method: 'POST', headers: HDRS, body, query: {} }, res);
  return res;
}

test('switching Luna Chat on creates the client', async () => {
  const store = {}; installAirtable(store);
  const res = await provision({
    externalId: 'cc-snow-dragons', name: 'Snow Dragons',
    email: 'hello@snowdragons.co.uk', appId: '412', authClientId: 'recAUTH1'
  }, store);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.action, 'created');
  const f = Object.values(store)[0].fields;
  assert.equal(f.ClientName, 'Snow Dragons');
  assert.equal(f.ExternalClientId, 'cc-snow-dragons');
  assert.equal(f.Status, 'Active');
});

test('the App ID lands as the deep link site id, so search works from day one', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com', appId: '412' }, store);
  assert.equal(Object.values(store)[0].fields.DeepLinkSiteID, '412');
});

test('AuthClientId is set, so the client is not locked out of their dashboard', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com', authClientId: 'recAUTH9' }, store);
  assert.equal(Object.values(store)[0].fields.AuthClientId, 'recAUTH9');
});

test('a new client gets every search type', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com' }, store);
  assert.deepEqual(Object.values(store)[0].fields.SearchTypes.sort(),
    ['Accommodation', 'DynamicPackaging', 'Flights', 'Packages']);
});

test('provisioning TWICE updates one record instead of creating a duplicate', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'Snow Dragons', email: 'a@a.com' }, store);
  const res = await provision({ externalId: 'cc-1', name: 'Snow Dragons', email: 'a@a.com' }, store);
  assert.equal(res.body.action, 'updated');
  assert.equal(Object.keys(store).length, 1,
    'duplicate ClientNames make every client lookup non-deterministic');
});

test('a rename moves the existing client and keeps their widget working', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'Old Name', email: 'a@a.com' }, store);
  await provision({ externalId: 'cc-1', name: 'New Name', email: 'a@a.com' }, store);
  assert.equal(Object.keys(store).length, 1, 'a rename must not orphan them and start a blank record');
  const f = Object.values(store)[0].fields;
  assert.equal(f.ClientName, 'New Name');
  assert.equal(f.LegacyClientName, 'Old Name',
    'the widget already on their site still sends the old name — it must keep resolving');
});

test('an update does NOT reset search types the client narrowed themselves', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com' }, store);
  const id = Object.keys(store)[0];
  store[id].fields.SearchTypes = ['Packages'];          // client narrowed it in Settings
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com' }, store);
  assert.deepEqual(store[id].fields.SearchTypes, ['Packages']);
});

test('a partial update cannot blank out values it did not send', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com', appId: '412', authClientId: 'recX' }, store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com' }, store);   // no appId this time
  const f = Object.values(store)[0].fields;
  assert.equal(f.DeepLinkSiteID, '412');
  assert.equal(f.AuthClientId, 'recX');
});

test('switching Luna Chat OFF deactivates rather than deleting', async () => {
  const store = {}; installAirtable(store);
  await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com' }, store);
  const res = await provision({ externalId: 'cc-1', name: 'A', email: 'a@a.com', active: false }, store);
  assert.equal(res.body.action, 'updated');
  assert.equal(Object.values(store)[0].fields.Status, 'Inactive');
  assert.equal(Object.keys(store).length, 1, 'their conversations and knowledge must survive');
});

test('a slug is derived when Client Control does not send one', async () => {
  const store = {}; installAirtable(store);
  const res = await provision({ externalId: 'cc-1', name: "Snow Dragons & Co!", email: 'a@a.com' }, store);
  assert.equal(res.body.client.slug, 'snow-dragons-co');
});

test('name and email are still required', async () => {
  const store = {}; installAirtable(store);
  const res = await provision({ externalId: 'cc-1', name: '', email: 'a@a.com' }, store);
  assert.equal(res.statusCode, 400);
});

test('the endpoint is still admin-authenticated and fails closed', async () => {
  const store = {}; installAirtable(store);
  const res = mockRes();
  await clients({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { externalId: 'x', name: 'A', email: 'a@a.com' }, query: {} }, res);
  assert.equal(res.statusCode, 401, 'no admin secret must be rejected');
  assert.equal(Object.keys(store).length, 0);
});

test('the embed snippet handed back carries the client name', async () => {
  const store = {}; installAirtable(store);
  const res = await provision({ externalId: 'cc-1', name: 'Snow Dragons', email: 'a@a.com' }, store);
  assert.match(res.body.client.embed, /data-clientName="Snow Dragons"/);
  assert.match(res.body.client.embed, /chat\.travelify\.io\/widget-core\.js/);
});
