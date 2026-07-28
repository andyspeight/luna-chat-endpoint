// A newly provisioned client must arrive ready to search.
//
// SearchTypes was never set at provisioning, so every new client started with
// none. Holiday search then silently did nothing until someone remembered to
// tick the boxes in Settings — and because no search rules reached her prompt,
// Luna invented plausible search URLs on the client's own domain instead. Every
// one was a 404, hit right when the visitor was ready to book.
//
// Two live clients were in that state: Jamie Wake Travel and That's My Dream
// Holiday.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'clients.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

test('provisioning sets SearchTypes on the new record', () => {
  assert.match(SRC, /SearchTypes: DEFAULT_SEARCH_TYPES/,
    'a new client must not be created with search switched off');
});

test('the default is every search type', () => {
  const m = SRC.match(/const DEFAULT_SEARCH_TYPES = \[([^\]]+)\]/);
  assert.ok(m, 'the default list must be declared once, not inlined');
  const types = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(types.sort(), ['Accommodation', 'DynamicPackaging', 'Flights', 'Packages']);
});

test('the names match the ones luna-chat actually understands', () => {
  // A typo here would provision a client whose search silently never fires.
  const m = SRC.match(/const DEFAULT_SEARCH_TYPES = \[([^\]]+)\]/);
  const types = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
  types.forEach(function (t) {
    assert.ok(CHAT.indexOf('st=' + t) !== -1 || CHAT.indexOf(t + ':') !== -1,
      t + ' is not a search type luna-chat recognises');
  });
});

test('the deep link site id is still set at provisioning too', () => {
  // Both halves are needed; a site id with no types is just as broken.
  assert.match(SRC, /DeepLinkSiteID: siteId/);
});
