// Setup-readiness scoring.
//
// A client who had filled in everything and scanned six pages was shown 75% and
// told to "add at least one website page for Luna to learn from" and "scan your
// pages" — work they had already done. It reads as the product not noticing
// their effort, which is corrosive at exactly the moment they are setting up.
//
// Cause: the scorer sampled the form on a fixed timer after the settings panel
// opened (0 / 700 / 1600ms). /api/profile is fetched twice in sequence, so on a
// slow response the fields were still empty when the last sample ran. The two
// training criteria are worth 10 + 15, which is precisely the missing 25 points.
//
// Fix: score when the profile actually lands, and again when a scan finishes.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');

test('the profile loader announces when it has finished', () => {
  assert.match(DASH, /dispatchEvent\(new CustomEvent\('luna-profile-loaded'\)\)/,
    'loadProfile must signal completion; timers cannot know when the data arrived');
});

test('the readiness scorer rescores on that signal', () => {
  assert.match(DASH, /addEventListener\('luna-profile-loaded', function\(\)\{ render\(\); \}\)/);
});

test('the readiness scorer also rescores when a scan finishes', () => {
  assert.match(DASH, /dispatchEvent\(new CustomEvent\('luna-scan-updated'\)\)/,
    'rendering scanned pages must signal it');
  assert.match(DASH, /addEventListener\('luna-scan-updated', function\(\)\{ render\(\); \}\)/,
    'so the ring moves without a reload');
});

test('scoring no longer depends only on the fixed timers', () => {
  // The timers are kept as a safety net for a panel opened long after load, but
  // they must not be the only trigger.
  const timerOnly = /if\(panel && 'MutationObserver' in window\)\{[\s\S]*?\}\s*render\(\);\s*\}\)\(\);/.test(DASH)
    && !/luna-profile-loaded/.test(DASH);
  assert.equal(timerOnly, false, 'the sampling timers must not be the only way readiness is computed');
});

test('a scanned account counts as scanned even when the per-page list is empty', () => {
  // The per-page list is rebuilt from stored knowledge and can legitimately come
  // back empty for older saves, while the scan itself definitely happened.
  // Counting only rebuilt rows made a scanned account look unscanned.
  assert.match(DASH, /var t = \$\('trainSummaryText'\);/);
  assert.match(DASH, /match\(\/\^\(\\d\+\)\\s\+page\/\)/,
    'must fall back to the saved scan summary');
});

test('the criteria weights still total 100', () => {
  // If they stop summing to 100 the percentage silently stops meaning what it says.
  const block = DASH.slice(DASH.indexOf('function criteria()'), DASH.indexOf('function band('));
  const weights = [...block.matchAll(/w:\s*(\d+)/g)].map(m => Number(m[1]));
  assert.equal(weights.length, 8, 'expected 8 criteria; got ' + weights.length);
  assert.equal(weights.reduce((a, b) => a + b, 0), 100, 'weights must total 100: ' + weights.join('+'));
});

test('the two training criteria are worth exactly the 25 points that went missing', () => {
  const block = DASH.slice(DASH.indexOf('function criteria()'), DASH.indexOf('function band('));
  assert.match(block, /\{ ok: trainUrlCount\(\) >= 1, w: 10,/);
  assert.match(block, /\{ ok: scannedCount\(\) >= 1,\s+w: 15,/);
});
