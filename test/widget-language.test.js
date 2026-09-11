// The widget's interface language, and the Lang parameter on search deep links.
//
// Luna has always answered in the visitor's own language. What she could not do
// was present herself in the client's: every label, placeholder and status
// message was hardcoded English, and the search results page came back in
// whatever the booking platform defaulted to. A Romanian agency got a Romanian
// conversation inside an English widget.
//
// WidgetLanguage on the client record now drives both. The rule that matters
// most here is the one about NOT setting it: a client who has never opened the
// setting must keep today's behaviour exactly, deep link included, because
// forcing Lang=EN on them could turn a correct results page into an English one.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const languages = require('../lib/languages');
const deeplink = require('../lib/deeplink');
const h = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

// ── the language list ──

test('every listed language is shaped so the widget and the deep link can use it', () => {
  languages.LANGUAGES.forEach((l) => {
    assert.match(l.code, /^[a-z]{2}$/, l.name + ' needs a two-letter code');
    assert.match(l.deepLink, /^[A-Z]{2}$/, l.name + ' needs a deep link code');
    assert.ok(l.endonym, l.name + ' needs its own name in its own language');
  });
  // (That a listed language actually HAS a translation is guarded in
  // test/widget-strings.test.js, next to the string tables themselves.)
});

test('English is the default and the first choice', () => {
  assert.equal(languages.DEFAULT.code, 'en');
  assert.equal(languages.names()[0], 'English');
});

test('a language resolves from a name, a code, or an Airtable select object', () => {
  assert.equal(languages.codeFor('Romanian'), 'ro');
  assert.equal(languages.codeFor('romanian'), 'ro');
  assert.equal(languages.codeFor('ro'), 'ro');
  assert.equal(languages.codeFor({ name: 'Romanian' }), 'ro');
  assert.equal(languages.codeFor(['Romanian']), 'ro');
  assert.equal(languages.deepLinkCodeFor('Romanian'), 'RO');
});

test('anything unrecognised falls back to English instead of throwing', () => {
  for (const v of ['', null, undefined, 'Klingon', {}, [], 0, false]) {
    assert.equal(languages.codeFor(v), 'en', JSON.stringify(v));
  }
});

test('isSupported is strict, so an unknown value can never be stored', () => {
  assert.equal(languages.isSupported('Romanian'), true);
  assert.equal(languages.isSupported('ro'), true);
  assert.equal(languages.isSupported('Klingon'), false);
  assert.equal(languages.isSupported(''), false);
  assert.equal(languages.isSupported(null), false);
});

// ── the deep link parameter ──

const PKG = 'https://dl.tvllnk.com/deeplink/272?st=DynamicPackaging&org=LON&dst=HER&loc=Crete&lat=35.3&lng=25.1&rad=4&fr=2026-10-15&dur=7&adt=2&chd=0&inf=0';
const FLIGHTS = 'https://dl.tvllnk.com/deeplink/272?st=Flights&org=LON&dst=HER&fr=2026-10-15&dur=7&adt=2&chd=0&inf=0';
const params = (u) => new URL(u).searchParams;

test('the language is set on a package search, alongside the geo correction', () => {
  const r = deeplink.rewriteLink(PKG, { lang: 'RO' });
  const p = params(r.url);
  assert.equal(p.get('Lang'), 'RO');
  assert.equal(p.get('rad'), '90', 'the geo correction must still happen');
  assert.equal(p.get('dst'), 'GR1');
});

test('the language is set on a FLIGHTS search too, which geo deliberately skips', () => {
  // A flights results page should be in the agency's language just as much as a
  // package one. Geography has nothing to say about it, language does.
  const r = deeplink.rewriteLink(FLIGHTS, { lang: 'RO' });
  assert.equal(params(r.url).get('Lang'), 'RO');
  assert.equal(r.changed, true);
  assert.equal(params(r.url).get('dst'), 'HER', 'flights keep the model airports');
});

test('no language means the parameter is not added at all', () => {
  for (const opts of [undefined, {}, { lang: '' }, { lang: null }]) {
    const r = deeplink.rewriteLink(FLIGHTS, opts);
    assert.equal(r.url, FLIGHTS, JSON.stringify(opts));
    assert.equal(params(deeplink.rewriteLink(PKG, opts).url).has('Lang'), false);
  }
});

test('a malformed language code is ignored rather than written through', () => {
  for (const bad of ['ROU', 'R', '12', 'r o', 'RO;DROP']) {
    assert.equal(params(deeplink.rewriteLink(PKG, { lang: bad }).url).has('Lang'), false, bad);
  }
});

test('a lowercase code is normalised to the upper case the deep link expects', () => {
  assert.equal(params(deeplink.rewriteLink(PKG, { lang: 'ro' }).url).get('Lang'), 'RO');
});

test('rewriting a link that already carries the language changes nothing', () => {
  const once = deeplink.rewriteLink(PKG, { lang: 'RO' }).url;
  const twice = deeplink.rewriteLink(once, { lang: 'RO' });
  assert.equal(twice.url, once);
  assert.equal(twice.changed, false);
});

test('the off switch suppresses the language as well as the geography', () => {
  assert.equal(deeplink.rewriteLink(PKG, { lang: 'RO', enabled: false }).url, PKG);
});

test('a link is still held whole while it streams, with the language applied', () => {
  const text = 'Uite [BLOCK]{"deepLink":"' + FLIGHTS + '"}[/BLOCK] gata.';
  const sr = deeplink.createStreamRewriter({ lang: 'RO', quiet: true });
  let out = '';
  for (let i = 0; i < text.length; i += 5) out += sr.push(text.slice(i, i + 5));
  out += sr.flush();
  assert.equal(out, deeplink.rewriteDeepLinks(text, { lang: 'RO', quiet: true }));
  assert.match(out, /Lang=RO/);
});

// ── end to end through the real handler ──

// A client record carrying whatever WidgetLanguage the test wants.
function stubClient(widgetLanguage) {
  h.setAirtableKey('test-key');
  h.setFetch(async (url) => {
    const u = String(url);
    if (u.indexOf('api.airtable.com') === -1) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const fields = { ClientName: 'Booking Vacante' };
    if (widgetLanguage !== undefined) fields.WidgetLanguage = widgetLanguage;
    return { ok: true, status: 200, json: async () => ({ records: [{ id: 'recBV', fields: fields }] }) };
  });
}

const REPLY = 'Uite [BLOCK]{"type":"destination_card","props":{"name":"Creta","deepLink":"' + PKG + '"}}[/BLOCK]';
const linkIn = (t) => {
  const m = /https:\/\/dl\.tvllnk\.com\/deeplink\/[^\s"'<>)\]}\\]+/.exec(t || '');
  return m ? new URL(m[0]).searchParams : null;
};

test('a client set to Romanian gets Lang=RO on the link the visitor taps', async () => {
  stubClient('Romanian');
  h.setReply(REPLY);
  const { res } = await h.callHandler({ message: 'vreau o vacanta in Creta', clientName: 'Booking Vacante', convId: 'c_ro' });
  const p = linkIn(res.body.reply);
  assert.ok(p, 'expected a deep link in the reply');
  assert.equal(p.get('Lang'), 'RO');
  assert.equal(p.get('rad'), '90', 'the geo correction still applies');
  h.resetFetch(); h.setAirtableKey(null);
});

test('an Airtable singleSelect object is handled, not stringified into nonsense', async () => {
  stubClient({ id: 'sel1', name: 'Romanian' });
  h.setReply(REPLY);
  const { res } = await h.callHandler({ message: 'vreau o vacanta', clientName: 'Booking Vacante', convId: 'c_obj' });
  assert.equal(linkIn(res.body.reply).get('Lang'), 'RO');
  h.resetFetch(); h.setAirtableKey(null);
});

test('a client who has NEVER chosen a language keeps todays link exactly', async () => {
  // The whole point: no setting means no Lang parameter, so a results page that
  // is already correct on the booking platform is left alone.
  stubClient(undefined);
  h.setReply(REPLY);
  const { res } = await h.callHandler({ message: 'holiday to Crete', clientName: 'Booking Vacante', convId: 'c_none' });
  const p = linkIn(res.body.reply);
  assert.equal(p.has('Lang'), false, 'no choice must mean no parameter');
  assert.equal(p.get('rad'), '90', 'geo is unconditional and still applies');
  h.resetFetch(); h.setAirtableKey(null);
});

test('a junk value in the field is treated as no choice, not as a broken code', async () => {
  stubClient('Klingon');
  h.setReply(REPLY);
  const { res } = await h.callHandler({ message: 'holiday', clientName: 'Booking Vacante', convId: 'c_junk' });
  assert.equal(linkIn(res.body.reply).has('Lang'), false);
  h.resetFetch(); h.setAirtableKey(null);
});

// ── wiring ──

test('every deep link rewrite site carries the language', () => {
  const sites = SRC.match(/lang: deepLinkLang/g) || [];
  assert.equal(sites.length, 6, 'three streaming rewriters and three final passes');
});

test('the deep link language is separate from the widget language', () => {
  assert.match(SRC, /var deepLinkLang = '';/);
  assert.match(SRC, /if \(languages\.isSupported\(f\.WidgetLanguage\)\) deepLinkLang = widgetLanguage\.deepLink;/);
  assert.doesNotMatch(SRC, /lang: widgetLanguage\.deepLink/,
    'using the resolved default here would force Lang=EN on every client');
});

test('the profile API refuses a language we cannot actually render', () => {
  const P = fs.readFileSync(path.join(__dirname, '..', 'api', 'profile.js'), 'utf8');
  assert.match(P, /languages\.isSupported\(wl\)/);
  assert.match(P, /Unsupported widget language/);
  assert.match(P, /if \(!wl\) updateFields\.WidgetLanguage = null;/, 'clearing the choice must be possible');
});
