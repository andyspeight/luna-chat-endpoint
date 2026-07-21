// Tests for the #2 interactive blocks: options_card, date_picker, and the
// visible "Trip so far" bar.
//
// The renderers are browser DOM code (window/document), so — as with the other
// widget tests — we cover them two ways: mirrored pure logic for the algorithms
// the renderers rely on, and source guards that fail loudly if the wiring is
// removed. A third guard set checks the server prompt still teaches Luna the
// two new blocks.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

// ── 1. options_card: option normalisation (mirrors renderOptionsCard) ──
function normaliseOptions(options) {
  let opts = Array.isArray(options) ? options : [];
  return opts
    .map((o) => {
      if (o && typeof o === 'object') return { label: String(o.label != null ? o.label : o.value || ''), value: String(o.value != null ? o.value : o.label || '') };
      return { label: String(o), value: String(o) };
    })
    .filter((o) => o.label.trim())
    .slice(0, 6);
}

test('options: plain strings become label==value', () => {
  const r = normaliseOptions(['Half board', 'All inclusive']);
  assert.deepEqual(r, [
    { label: 'Half board', value: 'Half board' },
    { label: 'All inclusive', value: 'All inclusive' }
  ]);
});

test('options: {label,value} pairs are preserved', () => {
  const r = normaliseOptions([{ label: 'AI', value: 'All inclusive' }]);
  assert.deepEqual(r, [{ label: 'AI', value: 'All inclusive' }]);
});

test('options: blanks dropped and list capped at 6', () => {
  const r = normaliseOptions(['a', '', '  ', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(r.length, 6);
  assert.ok(!r.some((o) => o.label.trim() === ''));
});

// ── 2. date_picker: validation + message building (mirrors renderDatePicker) ──
function validateAndBuild(dep, nightsRaw, todayIso) {
  if (!dep) return { err: 'Pick a departure date.' };
  if (dep < todayIso) return { err: 'That date has passed — pick a future one.' };
  let nights = null;
  if (nightsRaw !== '' && nightsRaw != null) {
    const n = parseInt(nightsRaw, 10);
    if (isNaN(n) || n < 1 || n > 90) return { err: 'Nights should be between 1 and 90.' };
    nights = n;
  }
  let msg = 'I want to travel on ' + dep;
  if (nights) msg += ' for ' + nights + ' nights';
  msg += '.';
  return { msg: msg, nights: nights };
}

test('date: empty departure is rejected', () => {
  assert.equal(validateAndBuild('', '', '2026-07-21').err, 'Pick a departure date.');
});

test('date: a past date is rejected', () => {
  assert.match(validateAndBuild('2020-01-01', '', '2026-07-21').err, /passed/);
});

test('date: out-of-range nights are rejected', () => {
  assert.match(validateAndBuild('2026-09-20', '0', '2026-07-21').err, /between 1 and 90/);
  assert.match(validateAndBuild('2026-09-20', '99', '2026-07-21').err, /between 1 and 90/);
});

test('date: a valid date + nights builds a natural sentence', () => {
  const r = validateAndBuild('2026-09-20', '7', '2026-07-21');
  assert.equal(r.err, undefined);
  assert.equal(r.msg, 'I want to travel on 2026-09-20 for 7 nights.');
});

test('date: a valid date without nights omits the nights clause', () => {
  const r = validateAndBuild('2026-09-20', '', '2026-07-21');
  assert.equal(r.msg, 'I want to travel on 2026-09-20.');
});

// ── 3. Trip bar value formatting (mirrors formatBriefValue) ──
function formatBriefValue(key, v) {
  if (v == null || v === '') return '';
  if (key === 'nights') return v + (v == 1 ? ' night' : ' nights');
  if (key === 'children' && v == 0) return '';
  return String(v);
}

test('trip bar: nights pluralises correctly', () => {
  assert.equal(formatBriefValue('nights', 1), '1 night');
  assert.equal(formatBriefValue('nights', 7), '7 nights');
});

test('trip bar: zero children is hidden', () => {
  assert.equal(formatBriefValue('children', 0), '');
  assert.equal(formatBriefValue('children', 2), '2');
});

test('trip bar: blank values render nothing', () => {
  assert.equal(formatBriefValue('destination', ''), '');
  assert.equal(formatBriefValue('destination', null), '');
  assert.equal(formatBriefValue('destination', 'Crete'), 'Crete');
});

// ── 4. Source guards: widget wiring ──
test('GUARD: options_card and date_picker are known and registered', () => {
  assert.match(WIDGET, /'options_card'/, 'options_card must be in KNOWN_BLOCK_TYPES');
  assert.match(WIDGET, /'date_picker'/, 'date_picker must be in KNOWN_BLOCK_TYPES');
  assert.match(WIDGET, /options_card:\s*renderOptionsCard/, 'options_card must be registered in RENDERERS');
  assert.match(WIDGET, /date_picker:\s*renderDatePicker/, 'date_picker must be registered in RENDERERS');
  assert.match(WIDGET, /function renderOptionsCard/, 'renderOptionsCard must exist');
  assert.match(WIDGET, /function renderDatePicker/, 'renderDatePicker must exist');
});

test('GUARD: options_card taps route back through dispatch (tap-instead-of-type)', () => {
  assert.match(WIDGET, /ctx\.dispatch\(\{\s*type:\s*'send_message'/, 'a tapped option must dispatch a send_message');
});

test('GUARD: trip bar is present in the chat shell and rendered on the right events', () => {
  assert.match(WIDGET, /id="tgxTripBar"/, 'the trip bar element must be in the chat screen');
  assert.match(WIDGET, /function renderTripBar/, 'renderTripBar must exist');
  assert.match(WIDGET, /function clearTripBriefField/, 'per-field clear must exist');
  // rendered when the brief changes, when chat opens, and reset on new conversation
  const renders = (WIDGET.match(/renderTripBar\(\)/g) || []).length;
  assert.ok(renders >= 3, 'renderTripBar must be called on merge, chat open, and clear; found ' + renders);
  assert.match(WIDGET, /tripBrief = \{\};[\s\S]{0,120}renderTripBar/, 'clearConversation must reset the brief and redraw the bar');
});

test('GUARD: trip bar values use textContent, never innerHTML', () => {
  // The renderTripBar body must not build chips with innerHTML (XSS-safe).
  const body = WIDGET.slice(WIDGET.indexOf('function renderTripBar'), WIDGET.indexOf('function clearTripBriefField'));
  assert.ok(body.length > 0, 'renderTripBar body located');
  assert.ok(!/innerHTML/.test(body), 'renderTripBar must not use innerHTML');
  assert.match(body, /textContent/, 'renderTripBar must set text via textContent');
});

// ── 5. Source guards: server prompt teaches the new blocks ──
test('GUARD: the server prompt documents options_card and date_picker', () => {
  assert.match(SERVER, /\*\*options_card\*\*/, 'options_card must be documented in the prompt');
  assert.match(SERVER, /\*\*date_picker\*\*/, 'date_picker must be documented in the prompt');
  assert.match(SERVER, /"type":"options_card"/, 'an options_card example marker must be present');
  assert.match(SERVER, /"type":"date_picker"/, 'a date_picker example marker must be present');
});
