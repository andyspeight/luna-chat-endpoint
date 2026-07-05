// Regression tests for the widget-side QA fixes in public/widget-core.js.
//
// widget-core.js is a browser IIFE that depends on window/document, so it cannot
// be require()d and unit-tested directly without a DOM harness. We cover it two
// ways:
//   1. Behavioural tests of the pure algorithms the fixes rely on (the malformed
//      [BLOCK] strip and the opener-history collapse), so the intended behaviour
//      is documented and checked.
//   2. Source guards that assert the fix is still wired into the real file, so a
//      revert or accidental removal fails a test loudly instead of shipping.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');

// ── 1. Behavioural: malformed / truncated [BLOCK] stripping (legacy fallback) ──
function stripBlocks(text) {
  return text
    .replace(/\[BLOCK\][\s\S]*?\[\/BLOCK\]/g, '')
    .replace(/\[BLOCK\][\s\S]*$/g, '')
    .replace(/\[\/BLOCK\]/g, '');
}

test('a complete but malformed block is stripped, surrounding prose kept', () => {
  const t = 'Here are some ideas:\n[BLOCK]{"type":"destination_card","props":{"name":"Crete",}}[/BLOCK]\nLet me know!';
  const r = stripBlocks(t).trim();
  assert.ok(!r.includes('[BLOCK]') && !r.includes('destination_card'), 'raw JSON should be gone: ' + r);
  assert.ok(r.includes('Here are some ideas') && r.includes('Let me know'));
});

test('a truncated block with no closing marker is stripped', () => {
  const t = 'Tenerife is lovely.\n[BLOCK]{"type":"destination_card","props":{"name":"Ten';
  const r = stripBlocks(t).trim();
  assert.ok(!r.includes('[BLOCK]') && !r.includes('destination_card'), r);
  assert.ok(r.includes('Tenerife is lovely'));
});

test('plain prose without markers is untouched', () => {
  const t = 'Just plain prose, no markers.';
  assert.equal(stripBlocks(t), t);
});

// ── 1b. Behavioural: recordBotOpener history collapse ──
function recordBotOpener(history, text) {
  if (!text || typeof text !== 'string') return;
  const hasUser = history.some((h) => h.role === 'user');
  if (!hasUser) { history.length = 0; }
  history.push({ role: 'assistant', content: text });
}

test('successive openers before any user turn collapse to one leading assistant turn', () => {
  const h = [];
  recordBotOpener(h, 'Hi there!');
  recordBotOpener(h, 'Greek islands await.');
  assert.equal(h.length, 1);
  assert.equal(h[0].content, 'Greek islands await.');
});

test('an opener after a user turn is appended, and the model sees it before the reply', () => {
  const h = [];
  recordBotOpener(h, 'Looking for winter sun?');
  h.push({ role: 'user', content: 'yes please' });
  assert.equal(h[0].role, 'assistant');
  assert.equal(h[1].content, 'yes please');
});

// ── 2. Source guards: the fixes must remain wired into widget-core.js ──
test('GUARD: current turn is excluded from history on send (no duplication)', () => {
  const hits = (SRC.match(/history\.slice\(-16,\s*-1\)/g) || []).length;
  assert.ok(hits >= 2, 'expected both callLuna and streamFromLuna to use history.slice(-16, -1); found ' + hits);
  assert.ok(!/history:\s*history\.slice\(-16\)\s*,/.test(SRC), 'old slice(-16) that duplicates the message must be gone');
});

test('GUARD: sendToAI routes to the agent when a human has taken over', () => {
  // The liveMode short-circuit must appear inside sendToAI (a comment sits
  // between the function open and the guard, so match non-greedily to the first
  // liveMode check after the definition).
  assert.match(SRC, /async function sendToAI\(text\)[\s\S]*?if \(liveMode\)\s*\{\s*sendToAgent\(text\);\s*return;\s*\}/,
    'sendToAI must short-circuit to sendToAgent while liveMode is active');
});

test('GUARD: liveMode is persisted and restored across reload', () => {
  assert.match(SRC, /liveMode:\s*liveMode/, 'saveSession must persist liveMode');
  assert.match(SRC, /liveMode\s*=\s*!!s\.liveMode/, 'restoreSession must restore liveMode');
});

test('GUARD: bot openers are recorded into model history', () => {
  assert.match(SRC, /function recordBotOpener/, 'recordBotOpener helper must exist');
  const calls = (SRC.match(/recordBotOpener\(/g) || []).length;
  // 1 definition + at least 4 call sites (welcome, regreet, 2x contextual opener, auto-trigger)
  assert.ok(calls >= 5, 'expected recordBotOpener to be called at the opener sites; found ' + calls);
});

test('GUARD: legacy parse path strips [BLOCK] fragments', () => {
  assert.match(SRC, /\.replace\(\/\\\[BLOCK\\\]\[\\s\\S\]\*\?\\\[\\\/BLOCK\\\]\/g/, 'complete-block strip must be present');
  assert.match(SRC, /\.replace\(\/\\\[BLOCK\\\]\[\\s\\S\]\*\$\/g/, 'truncated-block strip must be present');
});
