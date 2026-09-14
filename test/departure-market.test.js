// Where this agency's customers fly FROM.
//
// The search prompt opened with "ORIGIN_IATA — always a UK airport code" and a
// list of 24 British airports. For a Romanian agency that is not a default, it
// is an instruction to ignore the visitor. Anca said she wanted to fly from
// Cluj-Napoca; Luna offered her London and Manchester, and when she pressed,
// told her the live system is "optimised for direct routes from the UK".
//
// None of that was true of the supplier — Travelify searches from and to
// anywhere. It was true of our prompt.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const markets = require('../lib/departure-markets');
const h = require('./helpers');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('api/luna-chat.js');

// ── the list ──

test('the United Kingdom is the default, so no existing client moves', () => {
  assert.equal(markets.DEFAULT.code, 'GB');
  assert.equal(markets.resolve('').code, 'GB');
  assert.equal(markets.resolve(null).code, 'GB');
  assert.equal(markets.resolve('Narnia').code, 'GB');
});

test('the UK airport list is unchanged from the one it replaced', () => {
  // Every client today is on this list. If it moved, this change is not the
  // no-op for them that it claims to be.
  const gb = markets.resolve('United Kingdom').airports;
  for (const code of ['LON (all London)', 'LHR (Heathrow)', 'MAN (Manchester)', 'EDI (Edinburgh)',
    'BFS (Belfast International)', 'INV (Inverness)', 'NWI (Norwich)']) {
    assert.ok(gb.indexOf(code) !== -1, 'missing from the UK list: ' + code);
  }
  assert.equal(gb.split(',').length, 24, 'the original list had 24 airports');
});

test('a market resolves from a name, a code, or an Airtable select object', () => {
  assert.equal(markets.resolve('Romania').code, 'RO');
  assert.equal(markets.resolve('romania').code, 'RO');
  assert.equal(markets.resolve('RO').code, 'RO');
  assert.equal(markets.resolve({ name: 'Romania' }).code, 'RO');
  assert.equal(markets.resolve(['Ireland']).code, 'IE');
});

test('every market has real airports with the city names attached', () => {
  markets.MARKETS.forEach((m) => {
    assert.match(m.code, /^[A-Z]{2}$/, m.name + ' needs a two-letter code');
    assert.ok(m.airports && m.airports.length > 20, m.name + ' has no airports');
    // "CLJ (Cluj-Napoca)" — the model picks the right code far more reliably
    // from the name than from the code, and the name is what visitors say.
    assert.match(m.airports, /[A-Z]{3} \([^)]+\)/, m.name + ' lists codes without names');
  });
});

test("Romania's list carries the airport the client actually asked about", () => {
  const ro = markets.resolve('Romania').airports;
  assert.match(ro, /CLJ \(Cluj-Napoca\)/);
  assert.match(ro, /OTP \(Bucharest Otopeni\)/);
});

test('isSupported is strict, so an unknown market can never be stored', () => {
  assert.equal(markets.isSupported('Romania'), true);
  assert.equal(markets.isSupported('RO'), true);
  assert.equal(markets.isSupported('Narnia'), false);
  assert.equal(markets.isSupported(''), false);
});

// ── the prompt it writes ──

test('the visitor own airport wins, wherever in the world it is', () => {
  const p = markets.originPromptFor('Romania');
  assert.match(p, /Use whatever airport they name, anywhere in the world/);
  assert.match(p, /Never substitute a different country's airport/);
  assert.doesNotMatch(p, /always a UK airport code/);
});

test('the prompt never lets Luna tell a visitor their airport cannot be searched', () => {
  // This is the sentence Anca was given. It was not true.
  const p = markets.originPromptFor('Romania');
  assert.match(p, /never tell a visitor their own airport cannot be searched/);
  assert.match(p, /connecting flight is a normal result/);
  assert.match(p, /never say a route is unsearchable/);
});

test('the home market is for SUGGESTING, only when the visitor has not said', () => {
  const p = markets.originPromptFor('Romania');
  assert.match(p, /When they have NOT said where they are flying from/);
  assert.match(p, /CLJ \(Cluj-Napoca\)/);
  assert.doesNotMatch(p, /LHR \(Heathrow\)/, 'a Romanian client must not be offered UK airports');
});

test('a UK client gets exactly the guidance they had before', () => {
  const p = markets.originPromptFor('United Kingdom');
  assert.match(p, /LON \(all London\)/);
  assert.match(p, /If the visitor says "London" use LON/);
});

// ── the handler ──

function stubClient(market) {
  h.setAirtableKey('test-key');
  h.setFetch(async (url) => String(url).indexOf('api.airtable.com') === -1
    ? { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    : {
      ok: true, status: 200,
      json: async () => ({ records: [{ id: 'recBV', fields: Object.assign(
        { ClientName: 'Booking Vacante', DeepLinkSiteID: '272', SearchTypes: ['DynamicPackaging'] },
        market === undefined ? {} : { DepartureMarket: market }) }] })
    });
  h.setReply('ok');
}
const promptOf = (captured) => (captured[captured.length - 1] || {}).system || '';

test('a Romanian client gets Romanian airports in the search prompt', async () => {
  stubClient('Romania');
  const { captured } = await h.callHandler({ message: 'vreau sa zbor din Cluj', clientName: 'Booking Vacante', convId: 'c_ro_air' });
  const p = promptOf(captured);
  assert.match(p, /CLJ \(Cluj-Napoca\)/, 'Cluj must be offered');
  assert.doesNotMatch(p, /always a UK airport code/);
  assert.doesNotMatch(p, /LHR \(Heathrow\)/);
  h.resetFetch(); h.setAirtableKey(null);
});

test('a client who has never set it is still told the UK list', async () => {
  stubClient(undefined);
  const { captured } = await h.callHandler({ message: 'holiday from Manchester', clientName: 'Booking Vacante', convId: 'c_gb_air' });
  const p = promptOf(captured);
  assert.match(p, /MAN \(Manchester\)/);
  assert.match(p, /If the visitor says "London" use LON/);
  h.resetFetch(); h.setAirtableKey(null);
});

test('a junk value falls back to the UK rather than emptying the list', async () => {
  stubClient('Narnia');
  const { captured } = await h.callHandler({ message: 'holiday', clientName: 'Booking Vacante', convId: 'c_junk_air' });
  assert.match(promptOf(captured), /LON \(all London\)/);
  h.resetFetch(); h.setAirtableKey(null);
});

// ── wiring ──

test('the UK-only instruction is gone from the source', () => {
  assert.doesNotMatch(SRC, /always a UK airport code/);
  assert.doesNotMatch(SRC, /suggest "London" as default, and mention other UK airports/);
  assert.match(SRC, /\$\{departureMarkets\.originPromptFor\(departureMarket\)\}/);
});

test('the market is read from the client record, defaulting before it is', () => {
  assert.match(SRC, /var departureMarket = departureMarkets\.DEFAULT;/);
  assert.match(SRC, /departureMarket = departureMarkets\.resolve\(f\.DepartureMarket\);/);
  const declared = SRC.indexOf('var departureMarket = departureMarkets.DEFAULT;');
  const used = SRC.indexOf('${departureMarkets.originPromptFor(departureMarket)}');
  assert.ok(declared !== -1 && used !== -1 && declared < used);
});

test('the API refuses a market we have no airports for', () => {
  const P = read('api/profile.js');
  assert.match(P, /departureMarkets\.isSupported\(dm\)/);
  assert.match(P, /Unsupported departure market/);
  assert.match(P, /if \(!dm\) updateFields\.DepartureMarket = null;/);
  assert.match(P, /availableDepartureMarkets: departureMarkets\.names\(\)/);
});

test('the dashboard builds its picker from the API list, not a copy', () => {
  const DASH = read('public/dashboard.html');
  assert.match(DASH, /renderChoice\('setDepartureMarket', p\.availableDepartureMarkets, p\.departureMarket/);
  assert.match(DASH, /departureMarket: document\.getElementById\('setDepartureMarket'\)\.value,/);
  const fn = DASH.slice(DASH.indexOf('function renderChoice'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  markets.MARKETS.forEach((m) => assert.equal(body.indexOf("'" + m.name + "'"), -1,
    m.name + ' is hardcoded in the picker'));
});
