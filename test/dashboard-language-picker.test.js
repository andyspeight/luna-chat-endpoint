// The dashboard's language control, and the two settings it replaces.
//
// "Enable multilingual chat" and "Supported Languages" were saved to Airtable
// and read by absolutely nothing. Multilingual is unconditional — it is applied
// to every client on every request — so the checkbox implied a choice that did
// not exist, and the language list was a box that swallowed whatever was typed
// into it. A client reasonably expecting them to work is how this whole thread
// started.
//
// They are replaced by one control that does something: the chat window's
// language. It is built from the list the API sends rather than a copy kept
// here, because a second copy of a list is exactly how the capability-card icon
// sets drifted until half the editor's icons drew nothing on the live widget.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const languages = require('../lib/languages');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DASH = read('public/dashboard.html');
const PROFILE = read('api/profile.js');

// ── the dead settings are gone ──

test('the two settings that did nothing are no longer offered', () => {
  for (const gone of ['setMultilingualEnabled', 'setSupportedLanguages', 'multilingualFields']) {
    assert.equal(DASH.indexOf(gone), -1, gone + ' is still in the dashboard');
  }
  assert.equal(DASH.indexOf('Enable multilingual chat'), -1);
});

test('the replacement says plainly what is automatic and what is a choice', () => {
  const at = DASH.indexOf('<h4>Language</h4>');
  assert.ok(at !== -1, 'expected a Language section');
  const block = DASH.slice(at, at + 1200);
  assert.match(block, /always replies in whatever language your visitor writes in/,
    'a client must not be left wondering whether they need to switch this on');
  assert.match(block, /labels, buttons and status messages/);
  assert.match(block, /results/, 'the deep link half of the setting must be mentioned');
});

// ── the picker cannot drift from what we can actually render ──

test('the widget-language picker keeps no list of its own', () => {
  // Scoped to this picker on purpose. DASHBOARD_LANGUAGES nearby is a different
  // feature — the language the AGENT reads a conversation in, which is done by
  // live translation and so can afford a much longer list. This picker can only
  // offer what we have shipped string tables for, so it takes the API's list.
  const fn = DASH.slice(DASH.indexOf('function renderWidgetLanguage'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  languages.LANGUAGES.forEach((l) => {
    assert.equal(body.indexOf("'" + l.name + "'"), -1,
      l.name + ' is hardcoded in the picker; it must come from the API');
  });
  assert.match(body, /\(available \|\| \[\]\)\.forEach/);
  assert.match(DASH, /renderWidgetLanguage\(p\.availableLanguages, p\.widgetLanguage\)/);
});

test('the API sends the list, and it is the same one the widget renders from', () => {
  assert.match(PROFILE, /availableLanguages: languages\.names\(\),/);
  assert.deepEqual(languages.names(), languages.LANGUAGES.map((l) => l.name));
});

test('the picker offers an explicit "not set", because that is a real state', () => {
  // Not set means: draw in English, and leave the results page language to the
  // booking platform. It is not the same as choosing English.
  const fn = DASH.slice(DASH.indexOf('function renderWidgetLanguage'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.match(body, /none\.value = '';/);
  assert.match(body, /Not set/);
  assert.match(body, /sel\.value = current \|\| '';/);
});

test('the picker is built with DOM nodes, not innerHTML concatenation', () => {
  const fn = DASH.slice(DASH.indexOf('function renderWidgetLanguage'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.doesNotMatch(body, /innerHTML\s*\+=/, 'language names must not be concatenated into markup');
  assert.match(body, /createElement\('option'\)/);
  assert.match(body, /o\.textContent = name;/);
});

// ── saving ──

test('the dashboard saves the choice, and no longer saves the dead fields', () => {
  assert.match(DASH, /widgetLanguage: document\.getElementById\('setWidgetLanguage'\)\.value,/);
  assert.doesNotMatch(DASH, /multilingualEnabled:\s*document/);
  assert.doesNotMatch(DASH, /supportedLanguages:\s*document/);
});

test('the API refuses a language it cannot render, and accepts an empty clear', () => {
  assert.match(PROFILE, /else if \(languages\.isSupported\(wl\)\) updateFields\.WidgetLanguage = languages\.resolve\(wl\)\.name;/);
  assert.match(PROFILE, /if \(!wl\) updateFields\.WidgetLanguage = null;/);
  assert.match(PROFILE, /Unsupported widget language/);
});

test('the stored value is the canonical name, so Airtable never sees a variant', () => {
  // The select sends the name, but the API normalises anyway: a code or a
  // different case must still land as the exact singleSelect choice.
  assert.equal(languages.resolve('ro').name, 'Romanian');
  assert.equal(languages.resolve('romanian').name, 'Romanian');
  assert.equal(languages.resolve('Romanian').name, 'Romanian');
});
