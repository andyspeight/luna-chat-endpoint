// The status lines Luna shows while she is thinking, in the widget's language.
//
// These are server strings, chosen from the visitor's message and pushed down
// the SSE stream. They were the last English left in a translated widget: the
// client's screenshot showed "Reading the bookingvacante.ro | Primul OTA
// românesc page for you…" sitting above an otherwise Romanian conversation.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const statusStrings = require('../lib/status-strings');
const languages = require('../lib/languages');
const h = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');
const { STATUS, status } = statusStrings;

// ── the table ──

test('every language we offer has status strings too', () => {
  languages.LANGUAGES.forEach((l) => {
    assert.ok(STATUS[l.code], l.name + ' is offered but has no status strings');
  });
});

test('every table has exactly the keys English has', () => {
  const en = Object.keys(STATUS.en).sort();
  Object.keys(STATUS).forEach((code) => {
    if (code === 'en') return;
    const keys = Object.keys(STATUS[code]).sort();
    assert.deepEqual(en.filter((k) => keys.indexOf(k) === -1), [], code + ' is missing keys');
    assert.deepEqual(keys.filter((k) => en.indexOf(k) === -1), [], code + ' has extra keys');
  });
});

test('a translation keeps the placeholders, so a destination is never dropped', () => {
  const ph = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort();
  Object.keys(STATUS).forEach((code) => {
    if (code === 'en') return;
    Object.keys(STATUS.en).forEach((k) => {
      assert.deepEqual(ph(STATUS[code][k]), ph(STATUS.en[k]), code + '.' + k);
    });
  });
});

test('every key the handler asks for exists', () => {
  const used = new Set();
  const re = /S\('([A-Za-z][A-Za-z0-9]*)'|status\(statusLang, '([A-Za-z][A-Za-z0-9]*)'/g;
  let m;
  while ((m = re.exec(SRC))) used.add(m[1] || m[2]);
  assert.ok(used.size > 30, 'expected the handler to be using the table, found ' + used.size);
  assert.deepEqual([...used].filter((k) => STATUS.en[k] === undefined), []);
});

test('every key in the table is used by the handler', () => {
  const unused = Object.keys(STATUS.en).filter((k) => SRC.indexOf("'" + k + "'") === -1);
  assert.deepEqual(unused, [], 'defined but never used: ' + unused.join(', '));
});

// ── lookup ──

test('Romanian resolves, with values substituted', () => {
  assert.equal(status('ro', 'weather'), 'Verific vremea…');
  assert.equal(status('ro', 'pricesFor', { destination: 'Creta' }), 'Verific prețurile pentru Creta…');
  assert.equal(status('ro', 'readingPageForYou', { page: 'bookingvacante.ro' }), 'Citesc pagina bookingvacante.ro pentru tine…');
});

test('an unknown language or key falls back rather than going blank', () => {
  assert.equal(status('xx', 'weather'), 'Checking the weather…');
  assert.equal(status('ro', 'noSuchKey'), 'noSuchKey');
  const saved = STATUS.ro.weather;
  delete STATUS.ro.weather;
  assert.equal(status('ro', 'weather'), 'Checking the weather…', 'a gap must show English');
  STATUS.ro.weather = saved;
});

test('the request language is validated, never taken on trust', () => {
  assert.equal(statusStrings.langFromRequest('Romanian'), 'ro');
  assert.equal(statusStrings.langFromRequest('ro'), 'ro');
  for (const bad of ['Klingon', '', null, undefined, {}, 'en-GB; DROP', 42]) {
    assert.equal(statusStrings.langFromRequest(bad), 'en', JSON.stringify(bad));
  }
});

// ── through the handler ──

function stub() {
  h.setAirtableKey('test-key');
  h.setFetch(async (url) => String(url).indexOf('api.airtable.com') === -1
    ? { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    : { ok: true, status: 200, json: async () => ({ records: [{ id: 'recBV', fields: { ClientName: 'Booking Vacante', WidgetLanguage: 'Romanian' } }] }) });
  h.setReply('Bineînțeles.');
}

test('a Romanian widget gets Romanian status lines on the stream', async () => {
  stub();
  const { sse } = await h.callHandler(
    { message: 'cat costa o vacanta in Creta?', clientName: 'Booking Vacante', convId: 'c_st_ro', language: 'ro' },
    { stream: '1' }
  );
  const statuses = sse.filter((e) => e.event === 'status').map((e) => e.data.text || e.data.status || JSON.stringify(e.data));
  assert.ok(statuses.length > 0, 'expected status events, got: ' + sse.map((e) => e.event).join(','));
  assert.ok(statuses.some((s) => /Verific|Caut|Îți scriu|Citesc/.test(s)),
    'expected Romanian status lines, got: ' + JSON.stringify(statuses));
  assert.ok(!statuses.some((s) => /Checking|Looking|Writing|Reading/.test(s)),
    'English left on the stream: ' + JSON.stringify(statuses));
  h.resetFetch(); h.setAirtableKey(null);
});

test('a widget that sends no language still gets English, exactly as today', async () => {
  stub();
  const { sse } = await h.callHandler(
    { message: 'how much is a holiday to Crete?', clientName: 'Booking Vacante', convId: 'c_st_en' },
    { stream: '1' }
  );
  const statuses = sse.filter((e) => e.event === 'status').map((e) => e.data.text || e.data.status || '');
  assert.ok(statuses.some((s) => /Checking|Looking|Writing/.test(s)),
    'expected English, got: ' + JSON.stringify(statuses));
  h.resetFetch(); h.setAirtableKey(null);
});

// ── wiring ──

test('the language is read before the first status event is emitted', () => {
  // The first one fires long before the client's Airtable record is read, which
  // is exactly why it comes from the request rather than the record.
  const declared = SRC.indexOf('var statusLang = statusStrings.langFromRequest(body.language);');
  const firstUse = SRC.indexOf('emitAck(buildAck(effectiveMessage, pageContext, statusLang));');
  assert.ok(declared !== -1 && firstUse !== -1);
  assert.ok(declared < firstUse, 'statusLang must be set before the first status line');
});

test('the widget tells the server which language it is drawing itself in', () => {
  const W = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');
  const bodies = W.match(/var requestBody = \{\s*\n\s*language: C\.language \|\| "en",/g) || [];
  assert.equal(bodies.length, 2, 'both the streaming and non-streaming request bodies');
});

test('no status line is left as an English literal in the handler', () => {
  for (const gone of [
    "return 'Checking the weather…'",
    "return 'Looking up your booking…'",
    "emitStatus('Writing your answer…')",
    "'Reading the ' + pageContext.title"
  ]) {
    assert.equal(SRC.indexOf(gone), -1, 'still hardcoded: ' + gone);
  }
});
