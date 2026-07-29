// The provisioning secret must not open the global knowledge base.
//
// /api/clients has two callers that are nothing like each other:
//
//   - a human typing the admin password into /onboard.html
//   - Client Control, machine to machine, holding the secret in a SECOND Vercel
//     project (tg-widgets, as LUNA_CHAT_ADMIN_PASS) so it can switch Luna Chat
//     on for a client
//
// Both used ADMIN_PASSWORD, and so did /api/global-brain — the review screen for
// the shared knowledge base that answers for EVERY client. That put the keys to
// global knowledge inside a different project's environment, for no reason:
// creating a client and rewriting what Luna tells the world are not the same
// privilege.
//
// So /api/clients now also accepts LUNA_PROVISION_PASS, and /api/global-brain
// accepts ADMIN_PASSWORD only. Once LUNA_PROVISION_PASS is set to its own value,
// a leak of Client Control's environment reaches provisioning and stops there.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Each handler reads its secrets at require time, so load them in child
// processes with the env we want to test.
function callClients(env, suppliedPass) {
  const { execFileSync } = require('node:child_process');
  const script = `
    const h = require(${JSON.stringify(path.join(__dirname, '..', 'api', 'clients.js'))});
    const res = { code: 0, body: null,
      setHeader(){}, status(c){ this.code = c; return this; },
      json(b){ this.body = b; return this; }, end(){ return this; } };
    const req = { method: 'POST', headers: { 'x-admin-pass': ${JSON.stringify(suppliedPass)} },
      body: { name: 'X', email: 'x@x.com' }, query: {} };
    global.fetch = async () => { throw new Error('REACHED_AIRTABLE'); };
    h(req, res).then(() => process.stdout.write(JSON.stringify({ code: res.code, body: res.body })));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { AIRTABLE_KEY: 'k' }, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return JSON.parse(out);
}

function callGlobalBrain(env, suppliedPass) {
  const { execFileSync } = require('node:child_process');
  const script = `
    const h = require(${JSON.stringify(path.join(__dirname, '..', 'api', 'global-brain.js'))});
    const res = { code: 0, body: null,
      setHeader(){}, status(c){ this.code = c; return this; },
      json(b){ this.body = b; return this; }, end(){ return this; } };
    const req = { method: 'GET', headers: { 'x-admin-pass': ${JSON.stringify(suppliedPass)} }, query: { action: 'feed' } };
    global.fetch = async () => { throw new Error('REACHED_AIRTABLE'); };
    Promise.resolve(h(req, res)).then(() => process.stdout.write(JSON.stringify({ code: res.code, body: res.body })))
      .catch(() => process.stdout.write(JSON.stringify({ code: res.code, body: res.body })));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { AIRTABLE_KEY: 'k' }, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return JSON.parse(out);
}

const ADMIN = 'admin-secret-value';
const PROVISION = 'provision-secret-value';

// ── the separation itself ──

test('the provisioning secret does NOT open the global knowledge base', () => {
  // This is the whole point. Client Control holds this value in another Vercel
  // project; it must reach provisioning and stop there.
  const r = callGlobalBrain({ ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION }, PROVISION);
  assert.equal(r.code, 401, 'global-brain must reject the provisioning secret');
});

test('the admin password still opens the global knowledge base', () => {
  // The stub makes the first Airtable call throw, so REACHED_AIRTABLE is proof
  // the request got all the way PAST the gate rather than dying earlier.
  const r = callGlobalBrain({ ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION }, ADMIN);
  assert.equal(r.body.error, 'REACHED_AIRTABLE', 'a human with the admin password must still get in');
});

test('global-brain never reads the provisioning variable at all', () => {
  const SRC = read('api/global-brain.js');
  const reads = SRC.match(/process\.env\.LUNA_PROVISION_PASS/g) || [];
  assert.equal(reads.length, 0,
    'reading it here would put the machine secret back in reach of global knowledge');
});

// ── provisioning accepts either, so nothing breaks before the rotation ──

test('Client Control gets in with the dedicated provisioning secret', () => {
  const r = callClients({ ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION }, PROVISION);
  assert.equal(r.body.error, 'REACHED_AIRTABLE', 'the request must get past the gate');
});

test('a human with the admin password still gets in via onboard.html', () => {
  const r = callClients({ ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION }, ADMIN);
  assert.equal(r.body.error, 'REACHED_AIRTABLE');
});

test('before the rotation, the admin password alone still provisions', () => {
  // LUNA_PROVISION_PASS unset — exactly today's production state. Client Control
  // keeps working; deploying this must not take provisioning down.
  const r = callClients({ ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: '' }, ADMIN);
  assert.equal(r.body.error, 'REACHED_AIRTABLE',
    'deploying the split must not break provisioning');
});

// ── it still fails closed ──

test('a wrong password is refused by both endpoints', () => {
  const env = { ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION };
  assert.equal(callClients(env, 'nope').code, 401);
  assert.equal(callGlobalBrain(env, 'nope').code, 401);
});

test('an empty password is refused, even when a secret is configured', () => {
  const env = { ADMIN_PASSWORD: ADMIN, LUNA_PROVISION_PASS: PROVISION };
  assert.equal(callClients(env, '').code, 401);
  assert.equal(callGlobalBrain(env, '').code, 401);
});

test('with NO secret configured, provisioning fails closed with 503', () => {
  // Not 401: a missing env var must be diagnosable, not look like a typo.
  // This is the state that had /api/clients silently 503ing everything before
  // ADMIN_PASSWORD was ever added.
  const r = callClients({ ADMIN_PASSWORD: '', LUNA_PROVISION_PASS: '' }, 'anything');
  assert.equal(r.code, 503);
  assert.match(r.body.error, /not configured/);
});

test('an unset secret can never be matched by sending an empty header', () => {
  // If only one is configured, the other must not become a wildcard.
  const r = callClients({ ADMIN_PASSWORD: '', LUNA_PROVISION_PASS: PROVISION }, '');
  assert.equal(r.code, 401, 'an empty supplied value must not match an unset secret');
});

// ── comparison stays constant-time and unconditional ──

test('both secrets are compared every time, so timing reveals nothing', () => {
  const SRC = read('api/clients.js');
  assert.match(SRC, /var viaAdmin = !!ADMIN_PASS && safeCompare\(supplied, ADMIN_PASS\)/);
  assert.match(SRC, /var viaProvision = !!PROVISION_PASS && safeCompare\(supplied, PROVISION_PASS\)/);
  assert.doesNotMatch(SRC, /if \(safeCompare\(supplied, ADMIN_PASS\)\) return/,
    'short-circuiting on the first match would leak which secret was sent');
  assert.match(SRC, /crypto\.timingSafeEqual/);
});
