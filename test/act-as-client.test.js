// "Act as client" support mode.
//
// Travelgenix support needs to be able to open a client's Luna account to help
// them, the same way they can in the widgets and contracting tools. The hard rule:
// this state is available ONLY to an Agendas Group / Travelgenix staff member,
// NEVER to a client. It is the same gate as the cross-tenant fix — an elevated
// role AND a staff email domain — so there is no second, weaker path in.
//
// It also closes the usability hole behind the live incident: a user was editing
// another tenant's record with nothing on screen telling them whose account they
// were in. Acting as a client is now loud and one click to leave.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../lib/luna-auth');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const SESSION = read('api/auth-session.js');
const DASH = read('public/dashboard.html');

// ── the gate itself ──

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

// ── the server decides, the browser only displays ──

test('auth-session derives isStaff from isCrossTenantUser, not from the request', () => {
  assert.match(SESSION, /const staff = isCrossTenantUser\(role, email\)/,
    'staff status must come from the shared gate');
  assert.match(SESSION, /isStaff:\s*staff/, 'the response must carry the server-decided flag');
  assert.doesNotMatch(SESSION, /body\.(isStaff|actingAs|homeClientId)/,
    'none of the acting-as flags may be taken from the request body');
});

test('homeClientId is the account the user holds in their OWN right', () => {
  // `own` is built from AuthClientId / ContactEmail only — never from the
  // staff-only cross-tenant list — so home can never be someone else's account.
  assert.match(SESSION, /const homeClientId = own\.length \? own\[0\]\.id : null/);
  assert.match(SESSION, /homeClientId:\s*homeClientId/);
  assert.match(SESSION, /if \(staff\) \{[\s\S]*?candidates = candidates\.concat\(allClients\)/,
    'the all-clients list must stay inside the staff branch');
});

test('actingAs is true only when the chosen account is not the home account', () => {
  assert.match(SESSION,
    /const actingAs = !!\(chosen && homeClientId && chosen\.id !== homeClientId\)/);
  assert.match(SESSION, /actingAs:\s*actingAs/);
});

test('a user always lands in their own account, never in a client account', () => {
  assert.match(SESSION, /\} else if \(own\.length === 1\) \{\s*\n[\s\S]{0,400}?chosen = own\[0\];/,
    'the default choice must be the home account');
});

test('a requested client is still checked against the entitled candidates', () => {
  // Guards against the obvious bypass: POST {clientId} for a tenant you may not see.
  assert.match(SESSION, /chosen = candidates\.find\(/);
  assert.match(SESSION, /Requested client not linked to your account/);
});

// ── the dashboard signal ──

test('the dashboard takes IS_STAFF and HOME_CLIENT_ID from the server response', () => {
  assert.match(DASH, /CONFIG\.IS_STAFF = data\.isStaff === true/,
    'must be strict — no truthy coercion of a missing field');
  assert.match(DASH, /CONFIG\.HOME_CLIENT_ID = data\.homeClientId/);
  assert.match(DASH, /CONFIG\.ACTING_AS = CONFIG\.IS_STAFF/,
    'the banner state must require staff');
});

test('the ACTING AS banner exists, names the client, and offers a way out', () => {
  assert.match(DASH, /id="actingBanner"/);
  assert.match(DASH, /id="actingClientName"/);
  assert.match(DASH, /Acting as/);
  assert.match(DASH, /You are working inside this client's account/);
  assert.match(DASH, /window\._exitActingAs\(\)/, 'there must be an exit control');
  assert.match(DASH, /window\._exitActingAs = function/, 'and it must be implemented');
});

test('the banner is hidden unless the acting-as class is set', () => {
  assert.match(DASH, /\.acting-banner \{[^}]*display:none/,
    'default state must be hidden, so a missing flag fails closed');
  assert.match(DASH, /\.app\.acting-as \.acting-banner \{ display:flex; \}/);
});

test('exiting returns to the home account, not to an arbitrary one', () => {
  assert.match(DASH, /localStorage\.setItem\(CLIENT_PREF_KEY, CONFIG\.HOME_CLIENT_ID\)/);
});

test('the switcher can still reach the picker now that boot auto-selects home', () => {
  // Without the force flag, clearing the remembered client would just re-select
  // the home account and the switcher would look broken.
  assert.match(DASH, /sessionStorage\.setItem\('luna_force_picker', '1'\)/);
  assert.match(DASH, /if \(forcePicker\) sessionStorage\.removeItem\('luna_force_picker'\)/,
    'the flag must be one-shot');
  assert.match(DASH, /if \(forcePicker && data\.candidates/);
});

test('the picker marks which accounts are clients rather than your own', () => {
  assert.match(SESSION, /own: own\.some\(/, 'the server must say which candidates are the user\'s own');
  assert.match(DASH, /c\.own\s*\n?\s*\?/, 'the picker must use it');
});
