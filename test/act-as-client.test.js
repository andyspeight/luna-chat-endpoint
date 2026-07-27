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
//   2. WHOSE ACCOUNT IS THIS. "Acting as" was derived by guessing the user's own
//      account from a ContactEmail match. Andy's auth-platform client id matches
//      no Luna record, so it fell through and picked the Travel Demo record as
//      his home, which made the real Travelgenix account read as somebody else's.
//      It is now decided from the OPEN RECORD's own contact domain.
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

test('a client account is identified by ITS OWN contact domain, not by guessing home', () => {
  assert.match(SESSION, /function isClientAccount\(record\) \{[\s\S]*?isStaffEmail\(\(record\.fields \|\| \{\}\)\.ContactEmail\)/,
    'must read the open record, not infer the user\'s home account');
  assert.doesNotMatch(SESSION, /homeClientId/,
    'the home-account guess is what mislabelled Travelgenix — it must not come back');
});

test('the real Airtable records classify correctly', () => {
  // Exactly the four live records, so a wrong rule fails here rather than on screen.
  const staffOwned = ['info@travelgenix.io', 'andy.speight@agendas.group'];       // Travelgenix, Travel Demo
  const clientOwned = ['director@thatsmydreamholiday.com', 'hello@sunshinetravel.com'];
  staffOwned.forEach(e => assert.equal(auth.isStaffEmail(e), true, e + ' is one of ours — no banner'));
  clientOwned.forEach(e => assert.equal(auth.isStaffEmail(e), false, e + ' is a client — banner'));
});

test('a record with no contact email is treated as a client account (fails safe)', () => {
  assert.equal(auth.isStaffEmail(''), false);
  assert.equal(auth.isStaffEmail(undefined), false);
});

test('actingAs requires staff AND a client account, and is computed server-side', () => {
  assert.match(SESSION, /const actingAs = !!\(staff && chosen && isClientAccount\(chosen\)\)/);
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
  // `all` only ever populated inside `if (staff)`, and it is filtered to client
  // accounts, so a client receives nothing to act as.
  assert.match(SESSION, /const clientSummary = all\.filter\(isClientAccount\)\.map\(brief\)/);
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
