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

// Clients are not developers. "Add data-luna-open to a button" assumes they
// have a button and can edit HTML. The dashboard hands them a finished one.

test('the dashboard offers a ready-made button, not just an attribute', () => {
  assert.match(DASH, /Add a "Chat to us" button to a page/);
  assert.match(DASH, /id="triggerSnippet"/);
  assert.match(DASH, /id="lbtnPreview"/, 'they must be able to see what they are pasting');
});

test('the snippet is built from the client OWN brand colour', () => {
  assert.match(DASH, /window\._clientConfig && window\._clientConfig\.brandColor/);
  assert.match(DASH, /\/\^#\[0-9A-Fa-f\]\{6\}\$\/\.test\(c\)/,
    'the colour goes straight into generated markup, so it must be validated');
});

test('the snippet carries its own styles, so it works on any site', () => {
  assert.match(DASH, /'<!-- Chat to us button -->\\n<style>\\n' \+ css/);
});

test('three styles and an expanded option', () => {
  assert.match(DASH, /_selectLunaButton\('solid'\)/);
  assert.match(DASH, /_selectLunaButton\('outline'\)/);
  assert.match(DASH, /_selectLunaButton\('link'\)/);
  assert.match(DASH, /id="lbtnExpanded"/);
});

test('the snippet is DISPLAYED as text, never executed', () => {
  assert.match(DASH, /if \(code\) code\.textContent = snip;/,
    'using innerHTML here would run the markup instead of showing it');
});

test('the generated button has no inline event handlers', () => {
  // Client sites may run a strict CSP; an onclick attribute would be blocked.
  const at = DASH.indexOf('function lbtnSnippet()');
  const block = DASH.slice(at, at + 2200);
  assert.doesNotMatch(block, /on(click|mouseover|mouseout)=/i);
  assert.match(block, /data-luna-open/, 'it opens via the delegated attribute instead');
});

test('it repaints when the profile lands, so the colour is not the fallback', () => {
  assert.match(DASH, /addEventListener\('luna-profile-loaded', function\(\) \{ window\._renderLunaButton\(\); \}\)/);
});

test('the snippet has a working copy button', () => {
  assert.match(DASH, /window\._copyTriggerSnippet = function\(btn, id\)/);
  assert.match(DASH, /_copyTriggerSnippet\(this,'triggerSnippet'\)/);
});
