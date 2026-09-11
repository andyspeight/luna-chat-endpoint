// Two defects a Romanian client (Booking Vacante) found in their setup.
//
// 1. ICONS. The dashboard's card editor offers eighteen icons. The widget
//    could draw six. The other twelve rendered as a correctly sized, totally
//    empty tile on the live site while the editor preview showed the icon
//    perfectly — because the editor keeps its OWN copy of the icon map, and
//    only that copy was kept up to date. Booking Vacante picked "search" and
//    "suitcase" for two of their four cards and got two blank squares.
//
//    svgIcon() also had no fallback: an unknown name produced '<svg></svg>'.
//    The editor's equivalent falls back to helpCircle, which is why nothing
//    looked wrong until the widget was on a real page.
//
// 2. GREETING. applyTimeAwareGreeting() prefixed "Good afternoon! " to any
//    welcome that did not open with an English "hi/hey/hello". The client had
//    written "Salutare, cum te pot ajuta?" and it rendered as
//    "Good afternoon! Salutare, cum te pot ajuta?" with no way to turn it off.
//    Upgrading a generic opener is a courtesy. Prepending to a sentence
//    someone wrote themselves is not ours to do.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const WIDGET = read('public/widget-core.js');
const DASH = read('public/dashboard.html');

// Pull a named icon map out of a source file and return its keys.
function iconKeys(src, declaration) {
  const at = src.indexOf(declaration);
  assert.notEqual(at, -1, 'could not find ' + declaration);
  const block = src.slice(at, src.indexOf('\n};', at));
  return [...block.matchAll(/^\s{2,4}([A-Za-z][A-Za-z0-9]*):\s*'/gm)].map((m) => m[1]);
}

// Evaluate the widget's icon map + svgIcon for real, rather than regex-reading it.
function loadSvgIcon() {
  const map = WIDGET.slice(WIDGET.indexOf('var ICONS = {'));
  const body = map.slice(0, map.indexOf('\n}\n', map.indexOf('function svgIcon')) + 2);
  return new Function(body + '\nreturn { ICONS: ICONS, svgIcon: svgIcon };')();
}

// Same for the greeting helpers.
function loadGreeting() {
  const start = WIDGET.indexOf('function getTimeGreeting()');
  const end = WIDGET.indexOf('\n}', WIDGET.indexOf('function applyTimeAwareGreeting')) + 2;
  return new Function(WIDGET.slice(start, end)
    + '\nreturn { getTimeGreeting: getTimeGreeting, applyTimeAwareGreeting: applyTimeAwareGreeting };')();
}

// ── icons ──

test('every icon the card editor offers can actually be drawn by the widget', () => {
  const { ICONS } = loadSvgIcon();
  const offered = iconKeys(DASH, 'var WED_ICONS = {');
  assert.ok(offered.length >= 18, 'expected the full editor set, got ' + offered.length);
  const missing = offered.filter((n) => !ICONS[n]);
  assert.deepEqual(missing, [],
    'these render as an empty tile on the live widget: ' + missing.join(', '));
});

test('the legacy settings icon picker is covered too', () => {
  const { ICONS } = loadSvgIcon();
  const missing = iconKeys(DASH, 'var CAP_ICONS = {').filter((n) => !ICONS[n]);
  assert.deepEqual(missing, []);
});

test('the two icons Booking Vacante picked are among them', () => {
  const { ICONS } = loadSvgIcon();
  assert.ok(ICONS.search, 'search was one of the blank tiles');
  assert.ok(ICONS.suitcase, 'suitcase was the other');
});

test('an unknown icon name falls back to a visible icon, never an empty svg', () => {
  const { svgIcon, ICONS } = loadSvgIcon();
  const out = svgIcon('no-such-icon', 18, '#fff');
  assert.match(out, /^<svg /);
  assert.ok(out.indexOf(ICONS.helpCircle) !== -1, 'expected the helpCircle fallback');
  assert.doesNotMatch(out, /stroke-linejoin="round"><\/svg>/,
    'an empty <svg> is what drew the blank tiles');
});

test('a known icon still renders at the requested size and colour', () => {
  const { svgIcon, ICONS } = loadSvgIcon();
  const out = svgIcon('search', 18, '#fff');
  assert.match(out, /width="18"/);
  assert.match(out, /stroke="#fff"/);
  assert.ok(out.indexOf(ICONS.search) !== -1);
});

test('every icon body is drawable svg, not a stray string', () => {
  const { ICONS } = loadSvgIcon();
  Object.keys(ICONS).forEach((k) => {
    assert.match(ICONS[k], /^<(path|circle|rect|line|polygon|polyline)/, k + ' is not an svg shape');
  });
});

// ── greeting ──

test("a client's own welcome is left exactly as they wrote it", () => {
  const { applyTimeAwareGreeting } = loadGreeting();
  const romanian = 'Salutare, cum te pot ajuta? 🌞';
  assert.equal(applyTimeAwareGreeting(romanian), romanian);
  for (const w of [
    'Bonjour, comment puis-je vous aider ?',
    'Welcome to Snow Dragons — what can I find you?',
    '¿En qué puedo ayudarte?'
  ]) {
    assert.equal(applyTimeAwareGreeting(w), w, w);
  }
});

test('no welcome ever gains an English prefix', () => {
  const { applyTimeAwareGreeting } = loadGreeting();
  const out = applyTimeAwareGreeting('Salutare, cum te pot ajuta?');
  assert.doesNotMatch(out, /good (morning|afternoon|evening)/i);
});

test('a generic English opener is still upgraded to the time of day', () => {
  // This is the feature, and it survives: only the recognised opener is
  // replaced, and the rest of the sentence is untouched.
  const { applyTimeAwareGreeting, getTimeGreeting } = loadGreeting();
  const g = getTimeGreeting();
  assert.equal(applyTimeAwareGreeting('Hi there — how can I help today?'), g + ' — how can I help today?');
  assert.equal(applyTimeAwareGreeting('Hello there! What can I find you?'), g + '! What can I find you?');
  assert.equal(applyTimeAwareGreeting('Hey, ready to travel?'), g + ', ready to travel?');
});

test('a welcome that already names the time of day is left alone', () => {
  const { applyTimeAwareGreeting } = loadGreeting();
  const w = 'Good evening! Fancy some winter sun?';
  assert.equal(applyTimeAwareGreeting(w), w);
});

test('the time of day itself still tracks the clock', () => {
  const { getTimeGreeting } = loadGreeting();
  assert.match(getTimeGreeting(), /^Good (morning|afternoon|evening)$/);
});

test('empty and non-string welcomes are returned untouched', () => {
  const { applyTimeAwareGreeting } = loadGreeting();
  assert.equal(applyTimeAwareGreeting(''), '');
  assert.equal(applyTimeAwareGreeting(null), null);
  assert.equal(applyTimeAwareGreeting(undefined), undefined);
});

test('the prefixing branch is gone from the source', () => {
  assert.doesNotMatch(WIDGET, /return greeting \+ '! ' \+ welcome;/,
    'that line is what produced "Good afternoon! Salutare, cum te pot ajuta?"');
});
