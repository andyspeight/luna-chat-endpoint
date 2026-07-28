// Luna must never invent a search URL.
//
// On jamiewaketravel.co.uk she sent visitors links like
//   https://www.jamiewaketravel.co.uk/search?destination=Gran%20Canaria&...
// Every one is a 404, delivered at the exact moment the visitor was ready to
// book. It happened twice on that site, and again on thatsmydreamholiday.com.
//
// Cause: the whole "Holiday Search" instruction block lives inside
// `if (siteId)`. A client with no DeepLinkSiteID got NO link instructions at
// all, so instead of saying she could not search, the model filled the silence
// with a plausible-looking URL on the agency's own domain. Silence is not a
// constraint.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

test('a client with NO DeepLinkSiteID gets an explicit no-search instruction', () => {
  assert.match(SRC, /if \(!siteId\) \{/,
    'the missing-siteId case must be handled, not left silent');
  assert.match(SRC, /Holiday Search — NOT AVAILABLE/);
});

test('that instruction forbids inventing a URL', () => {
  const at = SRC.indexOf('Holiday Search — NOT AVAILABLE');
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /Never construct, guess, or invent a search, booking or availability URL/i);
  assert.match(block, /including on this agency's own website/i,
    'their own domain is exactly where the invented links pointed');
});

test('it also stops Luna PROMISING a search she cannot run', () => {
  const at = SRC.indexOf('Holiday Search — NOT AVAILABLE');
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /Do not say "let me search that for you"/i);
});

test('it gives a real alternative rather than just a prohibition', () => {
  const at = SRC.indexOf('Holiday Search — NOT AVAILABLE');
  const block = SRC.slice(at, at + 1400);
  assert.match(block, /hand over|team come back to them/i);
  assert.match(block, /Only link to pages you\s*\n?\s*have actually been given/i);
});

test('when search IS configured, only the dl.tvllnk.com format is permitted', () => {
  assert.match(SRC, /The ONLY permitted link format/);
  assert.match(SRC, /must start with https:\/\/dl\.tvllnk\.com\/deeplink\/\$\{siteId\}/,
    'the allowed prefix must be pinned to the client\'s own site id');
  assert.match(SRC, /never\s*\n?invent a path such as \/search\?destination=/i,
    'the exact shape of the broken links must be called out');
});

test('the 404 consequence is spelled out, not just the rule', () => {
  // A rule the model understands the cost of is followed more reliably than a
  // bare prohibition.
  const at = SRC.indexOf('The ONLY permitted link format');
  const block = SRC.slice(at, at + 700);
  assert.match(block, /404/);
});
