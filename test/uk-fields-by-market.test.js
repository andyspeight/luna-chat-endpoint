// A Romanian visitor was being told the flight time from Britain.
//
// The destination knowledge base carries three fields written from a British
// standpoint: "Flight Time From UK", "Visa Status UK" and "Health Notes UK".
// They were injected into Luna's destination context for every client, so
// someone in Cluj-Napoca on bookingvacante.ro asking how long the flight to
// Malaga takes was handed the answer for London.
//
// The visa field is the dangerous one. It is the rules for a UK passport, and
// Romania is in the EU while the UK is not, so the honest answer genuinely
// differs. Handing a Romanian visitor British visa rules is not noise, it is
// wrong information about their own trip.
//
// The fix is a gate on the client's departure market. Every client except
// Booking Vacante has DepartureMarket unset, which resolves to the United
// Kingdom, so this moves nothing for the other twenty-eight.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./helpers');                       // stubs the SDK before the handler loads
const LC = require('../api/luna-chat');
const markets = require('../lib/departure-markets');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

// A country record carrying all three British fields plus ordinary ones.
const COUNTRY = {
  fields: {
    'Country': 'Spain',
    'Region': 'Southern Europe',
    'Overview': 'Sun, coast and cities.',
    'Visa Advisory': 'Check before you travel.',
    'Visa Status UK': 'No visa needed for stays up to 90 days.',
    'Health Notes UK': 'No vaccinations required for UK travellers.',
    'Flight Time From UK': 'About 2h 45m',
    'Currency': 'Euro',
    'Language': 'Spanish',
    'Best Time to Visit': 'May to September'
  }
};
const CITY = {
  fields: {
    'City/Region': 'Malaga',
    'Region': 'Andalusia',
    'Overview': 'Costa del Sol gateway.',
    'Flight Time From UK': 'About 2h 50m',
    'Best Time to Visit': 'May to October'
  }
};
const asCountry = (m) => LC.summariseDestinationRecord(COUNTRY, { type: 'country', displayName: 'Spain' }, m);
const asCity = (m) => LC.summariseDestinationRecord(CITY, { type: 'city', displayName: 'Malaga' }, m);

// ── nothing moves for the twenty-eight clients who never set a market ──

test('an unset market is the United Kingdom, and still gets all three fields', () => {
  for (const unset of [undefined, null, '']) {
    const out = asCountry(unset);
    assert.match(out, /Flight time from UK: About 2h 45m/, 'unset market lost the flight time');
    assert.match(out, /Visa status \(UK passport\)/, 'unset market lost the visa status');
    assert.match(out, /Health notes \(UK\)/, 'unset market lost the health notes');
  }
});

test('a client explicitly set to the United Kingdom is unchanged', () => {
  const out = asCountry('United Kingdom');
  assert.match(out, /Flight time from UK/);
  assert.match(out, /Visa status \(UK passport\)/);
  assert.match(out, /Health notes \(UK\)/);
  // and by code, and by the singleSelect object Airtable actually returns
  assert.match(asCountry('GB'), /Flight time from UK/);
  assert.match(asCountry({ id: 'selX', name: 'United Kingdom' }), /Flight time from UK/);
});

// ── the client it was broken for ──

test('a Romanian client is given none of the three', () => {
  const out = asCountry('Romania');
  assert.doesNotMatch(out, /Flight time from UK/, 'a Cluj visitor must not get the flight time from London');
  assert.doesNotMatch(out, /Visa status \(UK passport\)/, 'UK passport rules are wrong for a Romanian visitor');
  assert.doesNotMatch(out, /Health notes/, 'UK health guidance is wrong for a Romanian visitor');
});

test('the city block drops it too, not just the country block', () => {
  // Two separate branches inject the same field. Fixing one and not the other
  // is exactly how this survives a fix.
  assert.match(asCity('United Kingdom'), /Flight time from UK/);
  assert.doesNotMatch(asCity('Romania'), /Flight time from UK/);
});

test('Ireland does not inherit British passport rules either', () => {
  // An Irish passport is not a British one and Irish health guidance differs.
  // No client is set to Ireland today, so this costs nothing and prevents the
  // obvious wrong assumption when one is.
  const out = asCountry('Ireland');
  assert.doesNotMatch(out, /Visa status \(UK passport\)/);
  assert.doesNotMatch(out, /Health notes \(UK\)/);
});

// ── a non-UK client loses only the British fields, not the record ──

test('everything that is not British still reaches Luna', () => {
  const out = asCountry('Romania');
  assert.match(out, /### Country: Spain/);
  assert.match(out, /Overview: Sun, coast and cities\./);
  assert.match(out, /Visa advisory: Check before you travel\./, 'the market-neutral visa line must survive');
  assert.match(out, /Currency: Euro/);
  assert.match(out, /Best time to visit: May to September/);
});

test('an empty record is still an empty string, whatever the market', () => {
  assert.equal(LC.summariseDestinationRecord(null, { type: 'country' }, 'Romania'), '');
  assert.equal(LC.summariseDestinationRecord({}, { type: 'country' }, 'United Kingdom'), '');
});

// ── the helper ──

test('isUkMarket takes every shape Airtable can hand back', () => {
  assert.equal(LC.isUkMarket(undefined), true, 'unset must stay the UK default');
  assert.equal(LC.isUkMarket(null), true);
  assert.equal(LC.isUkMarket(''), true);
  assert.equal(LC.isUkMarket('United Kingdom'), true);
  assert.equal(LC.isUkMarket('gb'), true);
  assert.equal(LC.isUkMarket(markets.DEFAULT), true, 'the resolved market object is what the handler holds');
  assert.equal(LC.isUkMarket('Romania'), false);
  assert.equal(LC.isUkMarket('RO'), false);
  assert.equal(LC.isUkMarket(markets.resolve('Romania')), false);
  assert.equal(LC.isUkMarket(['Romania']), false, 'Airtable can return a single-element array');
  // An unrecognised value resolves to the default rather than throwing, and the
  // default is the UK — the same fail-safe the origin prompt already uses.
  assert.equal(LC.isUkMarket('Atlantis'), true);
});

// ── the drift guard ──

test('every British field in the file is gated, including any added later', () => {
  // Three of these existed and all three were ungated. A fourth added the same
  // way would reintroduce the bug silently, because no other test would notice
  // a Romanian visitor being handed a British fact.
  const lines = SRC.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;              // comments are not code
    if (!/f\['[^']*\bUK\b[^']*'\]/.test(line)) return;   // not a British field
    if (!/\buk\s*&&/.test(line)) offenders.push((i + 1) + ': ' + line.trim());
  });
  assert.deepEqual(offenders, [],
    'these British fields are injected for every market:\n' + offenders.join('\n'));
});

test('the market actually reaches the summariser from the handler', () => {
  // The gate is worthless if the handler never passes the market down. Both
  // call sites matter: the client path and the Travelgenix demo path.
  assert.match(SRC, /async function getDestinationContext\(message, atKey, market\)/);
  assert.match(SRC, /summariseDestinationRecord\(rec, matches\[i\], market\)/);
  assert.match(SRC, /getDestinationContext\(message, atKey, departureMarket\)/);
  assert.match(SRC, /getDestinationContext\(message, atKeyTg, departureMarket\)/);
});

test('departureMarket is in scope where it is passed', () => {
  // A function reading a variable from a scope it is not in has taken this
  // codebase down twice. departureMarket is declared with var inside the
  // handler, so every use must sit inside that same function.
  const decl = SRC.indexOf('var departureMarket = departureMarkets.DEFAULT;');
  const handler = SRC.indexOf('module.exports = async function handler(req, res) {');
  assert.ok(handler !== -1 && decl > handler, 'the declaration must be inside the handler');
  let uses = [];
  SRC.split('\n').forEach((l, i) => {
    if (/getDestinationContext\([^)]*departureMarket\)/.test(l)) uses.push(SRC.split('\n').slice(0, i).join('\n').length);
  });
  assert.equal(uses.length, 2, 'expected both call sites');
  uses.forEach((at) => assert.ok(at > decl, 'a call site sits before the declaration'));
});
