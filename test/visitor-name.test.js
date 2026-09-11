// "Welcome back, Anonymous!" — in English, on a Romanian site.
//
// A visitor who chats without giving a name has their conversation persisted as
// "Anonymous" so the agent's list has something to show. That is a label for
// staff. It went into the same Airtable field a real name goes into, and both
// the recall endpoint and the history endpoint read it straight back out as
// though the visitor had typed it. So a returning visitor was greeted by name,
// and the name was "Anonymous".
//
// The placeholder is still written, because the alternative is a column of
// blanks in the agent list. It is filtered on the way back out, and the widget
// falls back to a greeting that needs no name.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visitorName = require('../lib/visitor-name');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const WIDGET = read('public/widget-core.js');

// ── what counts as a name ──

test('a real name is returned untouched, accents and all', () => {
  for (const n of ['Maria', 'Maria Popescu', 'Ștefan', 'Anna-Maria', "O'Brien", 'Ana', '李']) {
    assert.equal(visitorName.realName(n), n, n);
  }
});

test('a name is trimmed rather than rejected for whitespace', () => {
  assert.equal(visitorName.realName('  Maria  '), 'Maria');
});

test('the placeholders we write are not names', () => {
  for (const n of ['Anonymous', 'anonymous', 'ANONYMOUS', ' Anonymous ', 'anon', 'Guest', 'Visitor', 'Unknown', 'n/a', 'none', 'null', 'undefined', 'test']) {
    assert.equal(visitorName.realName(n), '', n + ' must not be treated as a name');
  }
});

test('empty, punctuation and digits are not names', () => {
  for (const n of ['', '   ', '-', '--', '...', '123', '!!!', null, undefined]) {
    assert.equal(visitorName.realName(n), '', JSON.stringify(n));
  }
});

test('an Airtable object or array is unwrapped, not stringified', () => {
  assert.equal(visitorName.realName({ name: 'Maria' }), 'Maria');
  assert.equal(visitorName.realName({ name: 'Anonymous' }), '');
  assert.equal(visitorName.realName(['Maria']), 'Maria');
});

test('a name that merely CONTAINS a placeholder word is still a name', () => {
  // Someone really called Anon Marković, or a surname like Guestrin.
  assert.equal(visitorName.realName('Anon Marković'), 'Anon Marković');
  assert.equal(visitorName.realName('Guestrin'), 'Guestrin');
});

test('isPlaceholder distinguishes "a placeholder" from "nothing at all"', () => {
  assert.equal(visitorName.isPlaceholder('Anonymous'), true);
  assert.equal(visitorName.isPlaceholder('Maria'), false);
  assert.equal(visitorName.isPlaceholder(''), false, 'empty is absence, not a placeholder');
});

// ── the server stops handing it back ──

test('neither memory endpoint returns a placeholder as the visitor name', () => {
  for (const f of ['api/visitor-history.js', 'api/visitor-recall.js']) {
    const SRC = read(f);
    assert.match(SRC, /name: visitorName\.realName\(name\) \|\| undefined,/, f);
    assert.doesNotMatch(SRC, /\n\s+name: name \|\| undefined,/, f + ' still returns the raw field');
  }
});

test('the placeholder is still WRITTEN, so the agent list is not a column of blanks', () => {
  assert.match(WIDGET, /name: userName \|\| "Anonymous"/);
  assert.match(WIDGET, /visitorName: userName \|\| "Anonymous"/);
});

// ── the widget ──

test('the widget keeps the same idea of a placeholder as the server', () => {
  // The widget cannot require the module, so it carries the list. This is the
  // guard that stops the two drifting, which is how the card icon sets broke.
  const at = WIDGET.indexOf('var NAME_PLACEHOLDERS = [');
  assert.notEqual(at, -1, 'the widget needs its own copy of the list');
  const list = WIDGET.slice(at, WIDGET.indexOf('];', at));
  visitorName.PLACEHOLDERS.forEach((p) => {
    assert.ok(list.indexOf("'" + p + "'") !== -1, p + ' is missing from the widget list');
  });
  const inWidget = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(inWidget.sort(), visitorName.PLACEHOLDERS.slice().sort(),
    'the two lists must match exactly');
});

test('the widget never adopts a placeholder as the visitor name', () => {
  assert.doesNotMatch(WIDGET, /if \(p\.name && !userName\) \{ userName = p\.name;/,
    'that is how "Anonymous" became the greeting');
  assert.doesNotMatch(WIDGET, /if \(visitorProfile\.name && !userName\) userName = visitorProfile\.name;/);
  assert.match(WIDGET, /if \(realName\(p\.name\) && !userName\) \{ userName = realName\(p\.name\); nameCollected = true; \}/);
});

test('a returning visitor is welcomed back whether or not we know their name', () => {
  assert.match(WIDGET, /function welcomeBackGreeting\(name\) \{/,
    'it must take the name, not read userName from a scope it cannot see');
  assert.match(WIDGET, /return n \? t\('welcomeBackName', \{ name: n \}\) : t\('welcomeBack'\);/);
  // The gate used to require a name, so a nameless returning visitor got no
  // welcome back at all — and a placeholder one got greeted by it.
  assert.doesNotMatch(WIDGET, /if \(isReturningVisitor && userName\) \{/);
  assert.match(WIDGET, /if \(isReturningVisitor\) \{/);
  assert.doesNotMatch(WIDGET, /if \(!isReturningVisitor \|\| !userName \|\| !\$msgs\) return;/);
});

test('both greetings exist in both languages', () => {
  const at = WIDGET.indexOf('var STRINGS = {');
  const table = WIDGET.slice(at, WIDGET.indexOf('\n};', WIDGET.indexOf('  ro: {', at)));
  for (const k of ['welcomeBack', 'welcomeBackName']) {
    assert.equal((table.match(new RegExp('\\n\\s+' + k + ':', 'g')) || []).length, 2, k + ' must be in en and ro');
  }
  assert.match(table, /welcomeBack: 'Bine ai revenit!',/);
  assert.match(table, /welcomeBackName: 'Bine ai revenit, \{name\}!',/);
});

test('the greeting resolves both ways, in Romanian', () => {
  // Run the real helper against the real table.
  const from = WIDGET.slice(WIDGET.indexOf('var STRINGS = {'));
  const block = from.slice(0, from.indexOf('\n}\n', from.indexOf('function t(key, vars)')) + 2);
  const rn = WIDGET.slice(WIDGET.indexOf('function realName(value)'));
  const realNameFn = rn.slice(0, rn.indexOf('\n}\n') + 2);
  // The real function from the shipped source, not a copy of it.
  const wb = WIDGET.slice(WIDGET.indexOf('function welcomeBackGreeting(name)'));
  const wbFn = wb.slice(0, wb.indexOf('\n}\n') + 2);
  const make = (name) => new Function(
    'var TGX_LANG = "ro";\n' + block + '\n' + realNameFn + '\n' + wbFn + '\n'
    + 'return welcomeBackGreeting(' + JSON.stringify(name) + ');')();
  assert.equal(make('Maria'), 'Bine ai revenit, Maria!');
  assert.equal(make('Anonymous'), 'Bine ai revenit!', 'the whole point');
  assert.equal(make(''), 'Bine ai revenit!');
});
