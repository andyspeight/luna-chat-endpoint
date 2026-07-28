// Switching account must not leave the previous client's conversations on screen.
//
// "Act as" switched client in place: it refetched the config and repainted the
// panels, but left the live conversation list, the in-memory `conversations`
// map, and the previous client's Ably channel subscriptions untouched. So the
// Travelgenix conversation list stayed visible after switching into a client's
// account, and looked exactly like a cross-tenant data leak.
//
// Nothing was ever wrong in the data. But "it only looks like a leak" is not a
// defence when a client is watching, so the switch now always reloads the page.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

function chooseClientBody() {
  const start = DASH.indexOf('async function chooseClient');
  assert.ok(start !== -1, 'chooseClient must exist');
  // Up to the next top-level function in the same block.
  const end = DASH.indexOf('\n  function renderActingAs', start);
  assert.ok(end > start, 'expected renderActingAs to follow chooseClient');
  return DASH.slice(start, end);
}

test('choosing a different client reloads instead of booting in place', () => {
  const body = chooseClientBody();
  assert.match(body, /window\.location\.reload\(\)/,
    'switching account must reload — nothing else guarantees the old list is gone');
});

test('the reload happens BEFORE bootSignedIn can repaint with stale state', () => {
  const body = chooseClientBody();
  const reloadAt = body.indexOf('window.location.reload()');
  const bootAt = body.indexOf('bootSignedIn(data)');
  assert.ok(reloadAt !== -1 && bootAt !== -1);
  assert.ok(reloadAt < bootAt, 'the reload path must come first and return');
  assert.match(body, /window\.location\.reload\(\);\s*\n\s*return;/,
    'it must return, so bootSignedIn cannot also run');
});

test('the chosen client is stored before the reload, so boot lands on it', () => {
  const body = chooseClientBody();
  const storeAt = body.indexOf('localStorage.setItem(CLIENT_PREF_KEY');
  const reloadAt = body.indexOf('window.location.reload()');
  assert.ok(storeAt !== -1, 'the choice must be persisted');
  assert.ok(storeAt < reloadAt, 'persist first, or the reload forgets which client was picked');
});

test('the old Ably connection is closed before reloading', () => {
  const body = chooseClientBody();
  assert.match(body, /ably\.close\(\)/,
    'the previous client\'s channels must be dropped, not left streaming');
});

test('first sign-in still boots normally (no reload loop)', () => {
  // On the very first load the app is not yet active, so there is nothing stale
  // to clear. Reloading there would loop.
  const body = chooseClientBody();
  assert.match(body, /appEl && appEl\.classList\.contains\('active'\)/,
    'the reload must be conditional on the app already showing a client');
  assert.match(body, /bootSignedIn\(data\)/, 'the first-boot path must remain');
});

test('_exitActingAs also reloads rather than switching in place', () => {
  const start = DASH.indexOf('window._exitActingAs = function');
  assert.ok(start !== -1);
  const body = DASH.slice(start, start + 500);
  assert.match(body, /window\.location\.reload\(\)/);
});

// ── acting as a client must not join their agent presence ──
//
// Presence drove two visible faults: the client's "Agents Online" list showed
// "Travelgenix", and — the functional one — the widget reads agent presence to
// decide whether a human is available, so a support session told that client's
// visitors an agent was on hand. Supporting an account must not change what that
// account's customers are told.

function presenceBlock() {
  const start = DASH.indexOf('// Agent presence');
  assert.ok(start !== -1, 'presence setup must exist');
  return DASH.slice(start, DASH.indexOf('presenceChannel.presence.subscribe', start) + 60);
}

test('acting as a client does NOT enter their agent presence', () => {
  const body = presenceBlock();
  assert.match(body, /if \(CONFIG\.ACTING_AS === true\)/,
    'the enter must be gated on not acting as a client');
  const gate = body.indexOf('CONFIG.ACTING_AS === true');
  const enter = body.indexOf('presence.enter');
  assert.ok(gate !== -1 && enter !== -1 && gate < enter,
    'the acting-as check must come before the enter');
});

test('acting as a client still READS their agent presence', () => {
  // Support needs to see who is on; it just must not add itself.
  const body = presenceBlock();
  assert.match(body, /presenceChannel\.presence\.get\(\)/);
  assert.match(body, /presenceChannel\.presence\.subscribe\(updatePresenceList\)/);
});

test('a normal agent still announces themselves', () => {
  const body = presenceBlock();
  assert.match(body, /presence\.enter\(\{ name: CONFIG\.AGENT_NAME, status: 'online' \}\)/,
    'the client\'s own agents must still show as online');
});
