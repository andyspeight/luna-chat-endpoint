// "Act as client" support mode.
//
// Travelgenix support needs to be able to open a client's Luna account to help
// them, the same way they can in the widgets and contracting tools. Hard rule:
// this is available ONLY to an Agendas Group / Travelgenix staff member, NEVER
// to a client. It reuses the cross-tenant gate — an elevated role AND a staff
// email domain — so there is no second, weaker path in.
//
// Two mistakes from the first attempt are pinned here so they cannot come back:
//
//   1. LAYOUT. The banner was added as a row inside the .app grid. Three panels
//      (.settings-overlay, .analytics-overlay, .brain-overlay) are pinned to a
//      hardcoded `grid-row:2`, so the content row moved to 3 and those panels
//      rendered on top of the topbar. The banner must live outside the grid.
//
//   2. WHOSE ACCOUNT IS THIS. Guessed twice, wrongly, before landing on the
//      obvious answer. First by inferring the user's own account from a
//      ContactEmail match — Andy's auth-platform client id matched no Luna
//      record, so it picked up Travel Demo and made the real Travelgenix account
//      read as somebody else's. Then by the OPEN RECORD's contact domain — which
//      hid Snow Dragon Ski Holidays from the Act as list entirely, because their
//      named contact is a colleague on a staff domain.
//
//      It is now decided by OWNERSHIP: an account is yours if its AuthClientId
//      matches your auth-platform client, and acting as means opening one that is
//      not. Client Control sets AuthClientId on every client it provisions, so
//      there is nothing left to infer.
//
// Also pinned: Switch and Act as are different controls. Switch moves a client
// between the websites they own. It is not a support tool.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../lib/luna-auth');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SESSION = read('api/auth-session.js');
const DASH = read('public/dashboard.html');

// ── the gate ──

test('only Agendas Group / Travelgenix staff can act across tenants', () => {
  assert.equal(auth.isCrossTenantUser('owner', 'andy.speight@agendas.group'), true);
  assert.equal(auth.isCrossTenantUser('admin', 'support@travelgenix.io'), true);
  assert.equal(auth.isCrossTenantUser('owner', 'someone@travelify.io'), true);
});

test('NO client can ever reach the acting-as state, whatever their role', () => {
  ['owner', 'admin', 'member', 'agent', ''].forEach(function (role) {
    assert.equal(auth.isCrossTenantUser(role, 'director@thatsmydreamholiday.com'), false,
      'client with role ' + JSON.stringify(role) + ' must never act as another tenant');
    assert.equal(auth.isCrossTenantUser(role, 'hello@sunshinetravel.com'), false);
  });
});

// ── whose account is open ──

test('an account is classified by OWNERSHIP, not by its contact email domain', () => {
  // The domain guess broke the moment a client was provisioned with a colleague
  // as the named contact: Snow Dragon Ski Holidays arrived with
  // luke.livsey@agendas.group, was read as one of ours, and disappeared from the
  // Act as list. Who is listed as the contact says nothing about who owns it.
  assert.match(SESSION, /function isOwnedBy\(record, ownRecords\)/);
  assert.match(SESSION, /ownRecords\.some\(function \(o\) \{ return o\.id === record\.id; \}\)/);
  assert.doesNotMatch(SESSION, /function isClientAccount/,
    'the contact-domain guess must be gone');
  assert.doesNotMatch(SESSION, /homeClientId/,
    'and so must the earlier home-account guess, which mislabelled Travelgenix');
});

test('a staff contact on a client record no longer hides that client', () => {
  // Snow Dragon Ski Holidays is contactable at luke.livsey@agendas.group. Under
  // the old rule that made it "ours" and it vanished from Act as. Ownership is
  // decided by AuthClientId, which Client Control sets, so the contact address is
  // now irrelevant to this question.
  assert.doesNotMatch(SESSION, /isStaffEmail/,
    'auth-session must no longer sniff contact domains at all');
});

test('isStaffEmail still gates WHO is staff — a different question', () => {
  // It is right for deciding who may act across tenants, and wrong for deciding
  // which accounts they may act as. Keep the first use, drop the second.
  assert.equal(auth.isStaffEmail('andy.speight@agendas.group'), true);
  assert.equal(auth.isStaffEmail('director@thatsmydreamholiday.com'), false);
  assert.equal(auth.isCrossTenantUser('owner', 'luke.livsey@agendas.group'), true);
});

test('actingAs requires staff AND an account that is not their own', () => {
  assert.match(SESSION, /const actingAs = !!\(staff && chosen && !isOwnedBy\(chosen, own\)\)/);
  assert.match(SESSION, /isStaff:\s*staff/);
  assert.doesNotMatch(SESSION, /body\.(isStaff|actingAs)/,
    'neither flag may be taken from the request body');
});

// ── Switch and Act as are different things ──

test('the server returns own accounts and client accounts separately', () => {
  assert.match(SESSION, /accounts:\s*ownSummary/, 'own accounts drive Switch');
  assert.match(SESSION, /clientAccounts:\s*clientSummary/, 'client accounts drive Act as');
  assert.match(SESSION, /let all = \[\];\s*\n\s*if \(staff\) \{/,
    'the all-clients read must stay inside the staff branch');
});

test('clientAccounts is empty for a non-staff user', () => {
  // `all` is only ever populated inside `if (staff)`, so a client receives
  // nothing to act as regardless of how the list is filtered.
  assert.match(SESSION, /const clientSummary = all\.filter\(function \(rec\) \{ return !isOwnedBy\(rec, own\); \}\)\.map\(brief\)/);
  assert.match(SESSION, /let all = \[\];\s*\n\s*if \(staff\) \{/);
});

test('a staff member sees every account except the ones they own', () => {
  // Andy holds Travelgenix and Travel Demo via AuthClientId recWGiXycDnxd8Zsh, so
  // those are his own and the rest — Jamie Wake, TMDH, Snow Dragons — are the
  // ones he can act as. Luke holds neither, so he sees all of them.
  const own = [{ id: 'recTG' }, { id: 'recDEMO' }];
  const all = [{ id: 'recTG' }, { id: 'recDEMO' }, { id: 'recJAMIE' }, { id: 'recSNOW' }];
  const isOwnedBy = (rec, o) => o.some(x => x.id === rec.id);
  const actable = all.filter(r => !isOwnedBy(r, own)).map(r => r.id);
  assert.deepEqual(actable, ['recJAMIE', 'recSNOW']);
  assert.deepEqual(all.filter(r => !isOwnedBy(r, [])).map(r => r.id),
    ['recTG', 'recDEMO', 'recJAMIE', 'recSNOW'],
    'a staff member with no account of their own can act as any of them');
});

test('Switch counts the user OWN accounts, not everything they may open', () => {
  assert.match(DASH, /Array\.isArray\(data\.accounts\)\) \? data\.accounts\.length : 1/,
    'Switch must be driven by data.accounts');
  assert.match(DASH, /switchBtn\.style\.display = ownCount > 1/);
  assert.doesNotMatch(DASH, /var entitledCount[\s\S]{0,120}switchBtn\.style\.display/,
    'Switch must no longer count the full entitled list');
});

test('Act as is a separate control, shown only to staff with clients to open', () => {
  assert.match(DASH, /id="actAsBtn"/);
  assert.match(DASH, /window\._openActAs\(\)/);
  assert.match(DASH, /actAsBtn\.style\.display = \(CONFIG\.IS_STAFF && ACT_AS_CLIENTS\.length\)/);
  assert.match(DASH, /ACT_AS_CLIENTS = \(CONFIG\.IS_STAFF && Array\.isArray\(data\.clientAccounts\)\)/,
    'the list must be gated on staff on the client side too');
});

// ── LAYOUT REGRESSION: the banner must not touch the app grid ──

test('the app grid keeps exactly its original rows', () => {
  assert.match(DASH, /\.app \{ display:none; height:100vh; grid-template-columns:300px 1fr 380px; grid-template-rows:56px 1fr; /,
    'the grid definition must be untouched');
  assert.doesNotMatch(DASH, /\.app\.acting-as \{ grid-template-rows/,
    'adding a grid row shifts the panels pinned to grid-row:2 on top of the topbar');
});

test('the panels pinned to grid-row:2 are still pinned to row 2', () => {
  // If any of these ever moves, the banner offset assumption needs revisiting.
  const pinned = DASH.match(/grid-column:2\/4; grid-row:2;/g) || [];
  assert.equal(pinned.length, 3,
    'expected settings, analytics and brain overlays pinned to grid-row:2; got ' + pinned.length);
});

test('the banner sits outside .app and offsets it instead', () => {
  const appStart = DASH.indexOf('<div class="app" id="app">');
  const bannerAt = DASH.indexOf('id="actingBanner"');
  assert.ok(bannerAt !== -1 && bannerAt < appStart,
    'the banner must be declared before .app, not inside the grid');
  assert.match(DASH, /\.acting-banner \{[^}]*position:fixed/);
  assert.match(DASH, /body\.acting-as \.app \{ margin-top:var\(--acting-h\); height:calc\(100vh - var\(--acting-h\)\); \}/);
});

test('the acting-as class goes on <body>, not on .app', () => {
  assert.match(DASH, /document\.body\.classList\.toggle\('acting-as', acting\)/);
});

// ── the signal itself ──

test('the banner names the client and offers a way out', () => {
  assert.match(DASH, /id="actingClientName"/);
  assert.match(DASH, /You are working inside this client's account/);
  assert.match(DASH, /window\._exitActingAs = function/);
});

test('the banner is hidden unless the flag is set, so a missing flag fails closed', () => {
  assert.match(DASH, /\.acting-banner \{[^}]*display:none/);
  assert.match(DASH, /body\.acting-as \.acting-banner \{ display:flex; \}/);
  assert.match(DASH, /CONFIG\.ACTING_AS = CONFIG\.IS_STAFF && data\.actingAs === true/,
    'strict checks — no truthy coercion of missing fields');
  assert.match(DASH, /CONFIG\.IS_STAFF = data\.isStaff === true/);
});

test('a requested client is still checked against the entitled candidates', () => {
  assert.match(SESSION, /chosen = candidates\.find\(/);
  assert.match(SESSION, /Requested client not linked to your account/);
});
