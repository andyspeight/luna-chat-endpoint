// Renaming a client must not take their live chat down.
//
// Every widget embedded on a client website identifies itself with a clientName
// string, and the server resolves the client by that name. So renaming a client
// record silently breaks the chat on their site: the lookup stops matching and
// the widget can no longer load.
//
// This is not hypothetical. Jamie Wake Travel's live chat runs against a record
// still named "Sunshine travel" — the demo site it was created from. Renaming it
// to something sensible would have killed the chat on jamiewaketravel.co.uk
// until his site was re-embedded, which could be days.
//
// LegacyClientName holds the previous name so already-embedded widgets keep
// resolving. These tests pin that every lookup path honours it.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../lib/luna-auth');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Every place a client is resolved from a name the WIDGET supplied.
const NAME_LOOKUP_FILES = [
  'api/widget-config.js',   // the widget's own config fetch — breaks the chat outright
  'api/auth.js',
  'api/notify-lead.js',     // lead notifications would silently stop reaching the client
  'api/subscribe.js'
];

test('the formula matches the current name', () => {
  const f = auth.clientNameFormula('Sunshine travel');
  assert.match(f, /LOWER\(\{ClientName\}\)='sunshine travel'/);
});

test('the formula ALSO matches the previous name', () => {
  const f = auth.clientNameFormula('Sunshine travel');
  assert.match(f, /LOWER\(\{LegacyClientName\}\)='sunshine travel'/,
    'an already-embedded widget must keep resolving after a rename');
  assert.match(f, /^OR\(/, 'the two must be OR-ed, not AND-ed');
});

test('lookups are case-insensitive on both fields', () => {
  // Widgets are embedded by hand, so the casing on a client site is whatever
  // someone typed. Both sides must be lowered.
  const f = auth.clientNameFormula("JAMIE WAKE TRAVEL");
  assert.ok(f.indexOf("'jamie wake travel'") !== -1, 'the supplied name must be lowered: ' + f);
  assert.equal((f.match(/LOWER\(/g) || []).length, 2, 'both fields must be wrapped in LOWER()');
});

test('formula injection through the widget-supplied name is escaped', () => {
  // clientName arrives from a third-party website, so it is untrusted input that
  // lands directly in an Airtable formula.
  const f = auth.clientNameFormula("x' , 1, 1) OR FIND('y");
  assert.ok(f.indexOf("\\'") !== -1, 'single quotes must be escaped: ' + f);
  assert.ok(f.indexOf("x' ,") === -1, 'an unescaped quote must not survive: ' + f);
});

test('a blank or missing name cannot match every client', () => {
  [undefined, null, ''].forEach(function (v) {
    const f = auth.clientNameFormula(v);
    assert.match(f, /LOWER\(\{ClientName\}\)=''/,
      'must compare against empty, never produce a catch-all: ' + f);
  });
});

test('GUARD: no endpoint builds its own bare ClientName match any more', () => {
  // lib/luna-auth.js is excluded on purpose: it DEFINES the formula, so it is the
  // one place the raw ClientName comparison legitimately appears. It is covered
  // by the behavioural tests above instead.
  NAME_LOOKUP_FILES.forEach(function (file) {
    const src = read(file);
    assert.doesNotMatch(src, /LOWER\(\{ClientName\}\)='"/,
      file + ' still matches ClientName directly — a rename would break widgets already embedded');
  });
});

test('GUARD: the shared helper is the only place the raw comparison lives', () => {
  const SRC = read('lib/luna-auth.js');
  const occurrences = (SRC.match(/LOWER\(\{ClientName\}\)/g) || []).length;
  assert.equal(occurrences, 1, 'expected exactly one raw comparison (inside clientNameFormula)');
  assert.match(SRC, /LOWER\(\{LegacyClientName\}\)/, 'and it must be paired with the legacy name');
});

test('GUARD: every name lookup goes through the shared helper', () => {
  NAME_LOOKUP_FILES.forEach(function (file) {
    const src = read(file);
    assert.match(src, /clientNameFormula\(clientName\)/, file + ' must use the shared helper');
    assert.match(src, /require\('\.\.\/lib\/luna-auth'\)/, file + ' must import it');
  });
});

test('the visitor path (resolveClientByName) honours the legacy name', () => {
  // This is the one the widget hits for its Ably token. If it stops matching,
  // the chat cannot connect at all.
  const SRC = read('lib/luna-auth.js');
  assert.match(SRC, /async function resolveClientByName\(atKey, clientName\) \{\s*\n\s*const recs = await fetchClients\(atKey, clientNameFormula\(clientName\), 1\);/);
});

// ── GENERIC SWEEP ──
//
// The first pass at this only grepped for LOWER({ClientName}) and so missed five
// lookups written as a bare {ClientName}='...' — including api/luna-chat.js,
// which loads the client's entire profile (business description, search config,
// deep link site id), and api/log-conversation.js, which attaches conversations
// to the client. Renaming Jamie Wake Travel therefore left his live chat
// resolving (the widget loaded) but with no profile behind it.
//
// So scan EVERY endpoint rather than a hand-written list.

// monitor.js looks up the literal 'travelgenix' record for an internal health
// check. It is not a widget-supplied name and Travelgenix is not going to be
// renamed, so it is exempt by name rather than by weakening the sweep.
const SWEEP_EXEMPT = new Set(['monitor.js']);

test('GUARD: no endpoint anywhere builds its own ClientName match', () => {
  const apiDir = path.join(__dirname, '..', 'api');
  const offenders = [];
  fs.readdirSync(apiDir)
    .filter(f => f.endsWith('.js') && !SWEEP_EXEMPT.has(f))
    .forEach(function (file) {
      const src = read('api/' + file);
      // Any comparison against the ClientName field that is not the shared helper.
      if (/\{ClientName\}\s*=/.test(src)) offenders.push(file);
    });
  assert.deepEqual(offenders, [],
    'these resolve a client by name themselves, so a rename silently breaks them: ' + offenders.join(', '));
});

test('GUARD: the endpoints that lost their profile on rename now use the helper', () => {
  ['luna-chat.js', 'log-conversation.js', 'luna-brain.js', 'luna-stats.js', 'email-chat-transcript.js']
    .forEach(function (file) {
      const src = read('api/' + file);
      assert.match(src, /clientNameFormula\(clientName\)/, file + ' must use the shared helper');
    });
});

test('GUARD: the agent Copilot resolves clients through the helper too', () => {
  const SRC = read('api/luna-copilot.js');
  assert.match(SRC, /filterByFormula: clientNameFormula\(name\)/,
    'a renamed client would otherwise silently lose their Copilot');
});
