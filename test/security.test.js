// Regression tests for the security + knowledge-integrity fixes.

'use strict';

require('./helpers'); // installs the Anthropic SDK stub — api/reverify.js requires the real SDK

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeFormulaString } = require('../lib/atescape');
const profile = require('../api/profile.js');
const reverify = require('../api/reverify.js');

const BS = String.fromCharCode(92); // backslash

// ── Airtable formula escaping ──
test('escapeFormulaString escapes the backslash before the quote (no breakout)', () => {
  const evil = BS + "' , 1, 1) OR FIND('x";
  const esc = escapeFormulaString(evil);
  assert.ok(esc.indexOf(BS + BS) !== -1, 'backslash must be doubled: ' + esc);
  assert.ok(esc.indexOf(BS + "'") !== -1, 'quote must be backslash-escaped: ' + esc);
});

test('escapeFormulaString leaves ordinary names intact (apart from the quote escape)', () => {
  assert.equal(escapeFormulaString('Acme Travel'), 'Acme Travel');
  assert.equal(escapeFormulaString("O'Neill Travel"), 'O' + BS + "'Neill Travel");
});

test('escapeFormulaString strips control characters', () => {
  assert.equal(escapeFormulaString('a' + String.fromCharCode(9) + 'b'), 'a b');
});

// ── profile.js secret masking ──
const { maskSecret, isMaskedSecret, safeCompare } = profile._test;

test('maskSecret hides a configured key and keeps empty empty', () => {
  assert.notEqual(maskSecret('sk-live-123'), 'sk-live-123');
  assert.ok(maskSecret('sk-live-123').length > 0);
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(undefined), '');
});

test('isMaskedSecret detects the mask so save does not overwrite the real key', () => {
  assert.equal(isMaskedSecret(maskSecret('anything')), true);
  assert.equal(isMaskedSecret('sk-live-real-key'), false);
  assert.equal(isMaskedSecret(''), false);       // explicit clear is allowed through
});

test('safeCompare is correct and rejects mismatches/lengths', () => {
  assert.equal(safeCompare('hunter2', 'hunter2'), true);
  assert.equal(safeCompare('hunter2', 'hunter3'), false);
  assert.equal(safeCompare('short', 'longervalue'), false);
  assert.equal(safeCompare('', ''), true);
});

// ── reverify evidence-in-source guard ──
const { evidenceInSource } = reverify;

test('evidenceInSource requires the quote to actually appear in the source', () => {
  const source = 'Visitors from the UK do not need a visa for stays under 90 days.';
  assert.equal(evidenceInSource('do not need a visa for stays under 90 days', source), true);
  assert.equal(evidenceInSource('a visa is required for all UK visitors', source), false);
});

test('evidenceInSource is fail-closed on thin or empty evidence', () => {
  assert.equal(evidenceInSource('', 'anything'), false);
  assert.equal(evidenceInSource('short', 'this short word exists here'), false); // < 8 chars
});
