// Luna's searches must use the same centre, radius and airport group as the
// site's own search for every destination the site knows.
//
// The site sends Travelify a curated centre point and a per-destination radius
// in MILES (the Algarve is 47, Crete 90, a ski resort 1 or 2). Luna let the
// model guess all three and told it the radius was in km with a ceiling of 12.
// The visitor got a different set of hotels from Luna than from the site.
//
// lib/geo-resolver.js carries the site's table and corrects every deep link
// the model emits. These tests pin the matching rules and the rewrite.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const geo = require('../lib/geo-resolver');

const LINK = 'https://dl.tvllnk.com/deeplink/272?st=DynamicPackaging&org=LON&dst=FAO&loc=Algarve&lat=37.1&lng=-8.2&rad=4&fr=2026-10-15&dur=7&adt=2&chd=0&inf=0';
const params = (u) => new URL(u).searchParams;

// ── the table ──

test('the table is the Travelify export, in miles, and loads', () => {
  assert.equal(geo.tableUnit, 'miles');
  assert.ok(geo.tableSize() >= 470, 'expected the full export, got ' + geo.tableSize());
});

test('the JSON is in step with the CSV (run scripts/build-geo-table.js after changing the CSV)', () => {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'geo', 'travelify-geo.csv'), 'utf8');
  const csvRows = csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
  // One exact duplicate name in the export is merged, so the table is one shorter.
  assert.ok(geo.tableSize() >= csvRows - 2 && geo.tableSize() <= csvRows,
    'CSV has ' + csvRows + ' rows, table has ' + geo.tableSize());
});

// ── matching ──

test('a plain destination name matches its row', () => {
  const r = geo.resolve('Algarve', {});
  assert.equal(r.row.name, 'Algarve, Portugal');
  assert.equal(r.row.radiusMi, 47);
  assert.equal(r.row.iata, 'FAO');
});

test('how the visitor says it does not matter: article, country, punctuation, case', () => {
  for (const loc of ['the Algarve', 'Algarve, Portugal', 'ALGARVE', ' algarve ', 'Algarve (Portugal)']) {
    assert.equal(geo.resolve(loc, {}).row.name, 'Algarve, Portugal', loc);
  }
});

test('URL-encoded names are matched as the visitor typed them', () => {
  const r = geo.rewriteLink(LINK.replace('loc=Algarve', 'loc=Costa+del+Sol').replace('lat=37.1&lng=-8.2', 'lat=36.6&lng=-4.6'));
  assert.equal(r.matched, 'Costa del Sol, Andalusia, Spain');
});

test('parenthetical aliases in the table are names in their own right', () => {
  assert.equal(geo.resolve('Zante', {}).row.name, 'Zakinthos (Zante), Greece');
  assert.equal(geo.resolve('Mallorca', {}).row.name, 'Majorca (Mallorca), Balearic Islands, Spain');
  assert.equal(geo.resolve('Majorca', {}).row.name, 'Majorca (Mallorca), Balearic Islands, Spain');
  assert.equal(geo.resolve('Burgas', {}).row.name, 'Bourgas (Burgas), Bulgaria');
});

test('Saint / St. / Sankt are one word', () => {
  assert.equal(geo.resolve('Saint Anton', {}).row.name, 'St Anton, Austria');
  assert.equal(geo.resolve('St. Anton', {}).row.name, 'St Anton, Austria');
});

test('a qualifier after a small place still finds it (St Anton am Arlberg)', () => {
  const r = geo.resolve('St Anton am Arlberg', {});
  assert.equal(r.row.name, 'St Anton, Austria');
  assert.equal(r.how, 'prefix');
});

test('a generic qualifier after a large place takes the region row', () => {
  assert.equal(geo.resolve('Crete island', {}).row.radiusMi, 90);
  assert.equal(geo.resolve('Algarve coast', {}).row.radiusMi, 47);
  assert.equal(geo.resolve('Tenerife Spain', {}).row.radiusMi, 31);
});

test('a sub-area of a large place is NOT widened to the whole region', () => {
  // "Dubai Marina" with a 28-mile radius would be the whole emirate. The
  // model's tight circle round the Marina is the better search, so leave it.
  assert.equal(geo.resolve('Dubai Marina', { lat: 25.08, lng: 55.14 }).row, null);
  assert.equal(geo.resolve('Bali Seminyak', { lat: -8.69, lng: 115.16 }).row, null);
});

test('a name the visitor shortened extends to the table name (New York → New York City)', () => {
  const r = geo.resolve('New York', { lat: 40.7, lng: -74 });
  assert.equal(r.row.name, 'New York City, New York, United States of America');
});

test('a one-letter typo on either side still matches (Magaluf / Magalluf)', () => {
  const r = geo.resolve('Magaluf', { lat: 39.5, lng: 2.53 });
  assert.equal(r.row.name, 'Magalluf, Majorca (Mallorca), Spain');
  assert.equal(r.how, 'fuzzy');
  // And the export's own typos do not stop a correctly spelled request.
  assert.equal(geo.resolve('Aegean Coast', { lat: 38.3, lng: 26.8 }).row.name, 'Aegan Coast, Turkey');
});

test('short names get no fuzzy matching, so "Bali" cannot become "Bari"', () => {
  assert.equal(geo.resolve('Bali', {}).row.name, 'Bali, Indonesia');
  assert.equal(geo.resolve('Balo', {}).row, null);
});

test('a place the table does not know is left to the model', () => {
  const r = geo.resolve('Universal Orlando', { lat: 28.47, lng: -81.47 });
  assert.equal(r.row, null);
  assert.equal(r.reason, 'miss');
});

// ── ambiguity ──

test('two rows with one name: the model dst picks (Dead Sea, Jordan vs Israel)', () => {
  assert.equal(geo.resolve('Dead Sea', { dst: 'AMM' }).row.name, 'Dead Sea, Jordan');
  assert.equal(geo.resolve('Dead Sea', { dst: 'ETM' }).row.name, 'Dead Sea, Southern District, Israel');
});

test('two rows with one name: the model coordinates pick (Manhattan NY vs KS)', () => {
  assert.equal(geo.resolve('Manhattan', { lat: 40.75, lng: -73.98 }).row.name, 'Manhattan, New York, United States');
  assert.equal(geo.resolve('Manhattan', { lat: 39.18, lng: -96.57 }).row.name, 'Manhattan, Kansas, United States');
});

test('two rows with one name and nothing to go on: leave the link alone', () => {
  const r = geo.resolve('Manhattan', {});
  assert.equal(r.row, null);
  assert.equal(r.reason, 'ambiguous');
});

test('the duplicate Zakinthos rows were merged to the wider one', () => {
  assert.equal(geo.resolve('Zakinthos', {}).row.radiusMi, 17);
});

// ── the sanity check ──

test('a name match whose centre is nowhere near the model coordinates is rejected', () => {
  // Paris, Texas. The name matches Paris, France; the coordinates do not.
  const r = geo.resolve('Paris', { lat: 33.66, lng: -95.55 });
  assert.equal(r.row, null);
  assert.equal(r.reason, 'far');
  assert.equal(r.candidate, 'Paris, France');
  assert.ok(r.distanceMi > 4000);
  // The real Paris is fine.
  assert.equal(geo.resolve('Paris', { lat: 48.85, lng: 2.35 }).row.name, 'Paris, France');
});

test('the distance allowance grows with the radius, so a region centre far from its main town still matches', () => {
  // The model puts the Maldives at Malé; the table centre is mid-archipelago.
  const r = geo.resolve('Maldives', { lat: 4.17, lng: 73.51 });
  assert.equal(r.row.radiusMi, 150);
});

test('without model coordinates there is no sanity check, but the match still applies', () => {
  assert.equal(geo.resolve('Crete', {}).row.iata, 'GR1');
});

// ── the rewrite ──

test('lat, lng, rad and dst are replaced with the site values; everything else is untouched', () => {
  const r = geo.rewriteLink(LINK);
  assert.equal(r.changed, true);
  const p = params(r.url);
  assert.equal(p.get('rad'), '47');
  assert.equal(p.get('lat'), '37.2006');
  assert.equal(p.get('lng'), '-8.315607');
  assert.equal(p.get('dst'), 'FAO');
  for (const k of ['st', 'org', 'loc', 'fr', 'dur', 'adt', 'chd', 'inf']) {
    assert.equal(p.get(k), params(LINK).get(k), k + ' must survive');
  }
  assert.ok(r.url.startsWith('https://dl.tvllnk.com/deeplink/272?'));
});

test('the airport becomes Travelify own grouping where the site uses one (Crete: HER → GR1)', () => {
  const r = geo.rewriteLink(LINK.replace('dst=FAO&loc=Algarve&lat=37.1&lng=-8.2', 'dst=HER&loc=Crete&lat=35.3&lng=25.1'));
  assert.equal(params(r.url).get('dst'), 'GR1');
  assert.equal(params(r.url).get('rad'), '90');
});

test('half-mile radii survive (St Paul\'s Bay is 0.5)', () => {
  const r = geo.rewriteLink(LINK.replace('dst=FAO&loc=Algarve&lat=37.1&lng=-8.2', 'dst=MLA&loc=St+Paul%27s+Bay&lat=35.95&lng=14.4'));
  assert.equal(r.matched, 'St. Pauls Bay, Malta');
  assert.equal(params(r.url).get('rad'), '0.5');
});

test('an Accommodation link (no dst) gets lat, lng and rad and no dst is added', () => {
  const acc = 'https://dl.tvllnk.com/deeplink/272?st=Accommodation&loc=Playa+del+Carmen&lat=20.6&lng=-87.07&rad=4&fr=2026-10-15&dur=7&adt=2&chd=1&inf=0&chdage=8&rat=5&brd=AllInclusive';
  const r = geo.rewriteLink(acc);
  const p = params(r.url);
  assert.equal(p.get('rad'), '8');
  assert.equal(p.has('dst'), false);
  assert.deepEqual(p.getAll('chdage'), ['8']);
  assert.equal(p.get('brd'), 'AllInclusive');
  assert.equal(p.get('rat'), '5');
});

test('a Flights link is never touched: it has no place, only airports', () => {
  const fl = 'https://dl.tvllnk.com/deeplink/272?st=Flights&org=LON&dst=HER&fr=2026-10-15&dur=7&adt=2&chd=0&inf=0';
  const r = geo.rewriteLink(fl);
  assert.equal(r.changed, false);
  assert.equal(r.url, fl);
});

test('a link for an unknown place is returned byte for byte', () => {
  const u = LINK.replace('loc=Algarve', 'loc=Universal+Orlando').replace('lat=37.1&lng=-8.2', 'lat=28.47&lng=-81.47');
  const r = geo.rewriteLink(u);
  assert.equal(r.changed, false);
  assert.equal(r.url, u);
});

test('rewriting is idempotent', () => {
  const once = geo.rewriteLink(LINK).url;
  const twice = geo.rewriteLink(once);
  assert.equal(twice.url, once);
  assert.equal(twice.changed, false);
});

test('the off switch returns the link unchanged', () => {
  const r = geo.rewriteLink(LINK, { enabled: false });
  assert.equal(r.url, LINK);
  assert.equal(r.changed, false);
});

test('only dl.tvllnk.com deeplinks are considered', () => {
  const other = 'https://www.example.com/deeplink/272?loc=Algarve&rad=4';
  assert.equal(geo.rewriteLink(other).url, other);
  assert.equal(geo.rewriteDeepLinks('see ' + other, { quiet: true }), 'see ' + other);
});

// ── in text ──

test('every deep link in a reply is rewritten, inside a [BLOCK] and in prose', () => {
  const crete = LINK.replace('dst=FAO&loc=Algarve&lat=37.1&lng=-8.2', 'dst=HER&loc=Crete&lat=35.3&lng=25.1');
  const text = 'Here you go [BLOCK]{"type":"destination_card","props":{"name":"Algarve","deepLink":"' + LINK + '"}}[/BLOCK] and (' + crete + ') too.';
  const out = geo.rewriteDeepLinks(text, { quiet: true });
  assert.match(out, /rad=47&/);
  assert.match(out, /rad=90&/);
  assert.match(out, /dst=GR1/);
  assert.match(out, /"\}\}\[\/BLOCK\] and \(https/, 'the JSON and the brackets round the link must survive');
});

test('text without a deep link is returned as the same string', () => {
  const t = 'No links here, just words about Crete and the Algarve.';
  assert.equal(geo.rewriteDeepLinks(t), t);
});

// ── streaming ──

test('a link split across many deltas comes out whole and corrected, and prose is not delayed', () => {
  const text = 'Here you go — tap below. [BLOCK]{"type":"destination_card","props":{"name":"Algarve","deepLink":"' + LINK + '"}}[/BLOCK] Let me know.';
  for (const chunk of [1, 3, 7, 16, 50]) {
    const sr = geo.createStreamRewriter({ quiet: true });
    let out = '';
    const emitted = [];
    for (let i = 0; i < text.length; i += chunk) { const o = sr.push(text.slice(i, i + chunk)); out += o; emitted.push(o); }
    out += sr.flush();
    assert.equal(out, geo.rewriteDeepLinks(text, { quiet: true }), 'chunk size ' + chunk);
    // The opening prose left before the link had finished arriving.
    const beforeLink = emitted.slice(0, Math.ceil('Here you go'.length / chunk) + 1).join('');
    assert.ok(beforeLink.startsWith('Here'), 'prose must stream immediately (chunk ' + chunk + ')');
    // No partial link was ever emitted.
    let seen = '';
    for (const o of emitted) {
      seen += o;
      const idx = seen.lastIndexOf('https://dl.tvllnk.com/deeplink/');
      if (idx !== -1) assert.ok(/[\s"'<>)\]}]/.test(seen.slice(idx)) || seen.slice(idx) === out.slice(out.indexOf('https://dl'), out.indexOf('https://dl') + seen.length - idx),
        'a link must only be emitted once complete (chunk ' + chunk + ')');
    }
  }
});

test('a delta that could be the start of a link is held, and released if it was not one', () => {
  const sr = geo.createStreamRewriter({ quiet: true });
  assert.equal(sr.push('see https://'), 'see ');
  assert.equal(sr.push('example.com/x '), 'https://example.com/x ');
  assert.equal(sr.flush(), '');
});

test('a link at the very end of the stream is released by flush', () => {
  const sr = geo.createStreamRewriter({ quiet: true });
  let out = sr.push('Link: ' + LINK.slice(0, 40));
  out += sr.push(LINK.slice(40));
  assert.equal(out, 'Link: ');
  const tail = sr.flush();
  assert.match(tail, /rad=47&/);
});

test('the stream rewriter honours the off switch', () => {
  const sr = geo.createStreamRewriter({ enabled: false, quiet: true });
  const out = sr.push(LINK + ' ') + sr.flush();
  assert.equal(out, LINK + ' ');
});
