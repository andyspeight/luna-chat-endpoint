// "Chat to us" buttons anywhere on a client's page.
//
// The floating bubble is always in the corner, but a client asked for their own
// button inside the page copy — next to a phone number, at the end of an
// article, on a destination page. They add an attribute; no JavaScript to write.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const W = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

test('any element with data-luna-open opens the chat', () => {
  assert.match(W, /el\.hasAttribute\('data-luna-open'\)/);
  assert.match(W, /window\.openLunaChat\(\)/);
});

test('data-luna-open="expanded" opens the big panel instead', () => {
  assert.match(W, /=== 'expanded'\s*\n?\s*\? 'expanded' : 'open'/);
  assert.match(W, /window\.expandLunaChat\(\)/);
});

test('the ORIGINAL data-luna-expanded attribute still works', () => {
  // It is already embedded on live client sites. Introducing a nicer name must
  // not break pages that are already out there — the same lesson as renaming a
  // client and taking their widget down.
  assert.match(W, /getAttribute\('data-luna-expanded'\) === 'true'/);
});

test('a click on something INSIDE the trigger counts', () => {
  // Buttons usually contain an icon or a span; the click target is that child.
  assert.match(W, /function lunaTriggerFor\(el\) \{[\s\S]*?el = el\.parentElement;/);
});

test('the trigger never navigates or submits', () => {
  // A link would navigate away and a button inside a form would submit it,
  // losing the visitor before the chat even opened.
  const at = W.indexOf("document.addEventListener('click', function(e) {\n    var mode = lunaTriggerFor");
  assert.ok(at !== -1, 'the click handler must exist');
  const block = W.slice(at, at + 500);
  assert.match(block, /e\.preventDefault\(\)/);
  assert.match(block, /e\.stopPropagation\(\)/);
});

test('it is delegated, so triggers added later still work', () => {
  // Client sites are CMS-driven; buttons appear after the widget has loaded.
  assert.match(W, /document\.addEventListener\('click'/);
  assert.doesNotMatch(W, /querySelectorAll\('\[data-luna-open\]'\)\.forEach\(function \(el\) \{\s*el\.addEventListener/,
    'must not bind per-element listeners at load — those miss anything added later');
});

test('a non-button trigger is made keyboard accessible', () => {
  // A div cannot be focused or announced, so keyboard users could not open the
  // chat at all.
  assert.match(W, /setAttribute\('role', 'button'\)/);
  assert.match(W, /setAttribute\('tabindex', '0'\)/);
  assert.match(W, /if \(tag === 'button' \|\| tag === 'a'\) return;/,
    'real buttons and links must be left alone');
});

test('Enter and Space work, without double-firing on real buttons', () => {
  const at = W.indexOf("document.addEventListener('keydown'");
  assert.ok(at !== -1);
  const block = W.slice(at, at + 600);
  assert.match(block, /e\.key !== 'Enter' && e\.key !== ' '/);
  assert.match(block, /tag === 'button' \|\| tag === 'a'/,
    'those already fire a click, so handling the key too would open it twice');
});

// ── the client has to be able to find it ──

test('the dashboard shows a copy-paste snippet', () => {
  assert.match(DASH, /Add your own "Chat to us" button/);
  assert.match(DASH, /id="triggerSnippet"/);
  assert.match(DASH, /data-luna-open&gt;Chat to us/);
});

test('the expanded variant is offered too', () => {
  assert.match(DASH, /id="triggerSnippetExpanded"/);
  assert.match(DASH, /data-luna-open="expanded"/);
});

test('both snippets have a working copy button', () => {
  assert.match(DASH, /window\._copyTriggerSnippet = function\(btn, id\)/);
  assert.match(DASH, /_copyTriggerSnippet\(this,'triggerSnippet'\)/);
  assert.match(DASH, /_copyTriggerSnippet\(this,'triggerSnippetExpanded'\)/);
});
