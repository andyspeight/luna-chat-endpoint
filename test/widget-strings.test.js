// The widget's interface text, and the guards that keep a translation honest.
//
// Luna answered in Romanian inside an English window: every label, placeholder,
// button title and status line was a hardcoded English literal. They now come
// from one table keyed by the client's WidgetLanguage.
//
// Two failure modes are worth more than the translation itself, so they are
// pinned here. A language must not be offered without a table (that is how
// SupportedLanguages became a dashboard box that did nothing), and a table must
// not be missing keys that English has (that is how a half-translated widget
// ships with blanks in it).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const languages = require('../lib/languages');
const WIDGET = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');

// Evaluate the real table and the real t(), rather than reading them as text.
function loadStrings(lang) {
  const from = WIDGET.slice(WIDGET.indexOf('var STRINGS = {'));
  const block = from.slice(0, from.indexOf('\n}\n', from.indexOf('function t(key, vars)')) + 2);
  // t() resolves against the file-scope TGX_LANG, not C — the block renderers
  // live outside the widget's IIFE and cannot see C.
  return new Function('var TGX_LANG = ' + JSON.stringify(lang || 'en') + ';\n'
    + block + '\nreturn { STRINGS: STRINGS, t: t };')();
}

const { STRINGS } = loadStrings('en');

// ── the two guards ──

test('every language we offer has a table to draw from', () => {
  languages.LANGUAGES.forEach((l) => {
    assert.ok(STRINGS[l.code],
      l.name + ' is offered in lib/languages.js but has no strings in the widget');
  });
});

test('every table has exactly the keys English has, no more and no fewer', () => {
  const en = Object.keys(STRINGS.en).sort();
  Object.keys(STRINGS).forEach((code) => {
    if (code === 'en') return;
    const keys = Object.keys(STRINGS[code]).sort();
    const missing = en.filter((k) => keys.indexOf(k) === -1);
    const extra = keys.filter((k) => en.indexOf(k) === -1);
    assert.deepEqual(missing, [], code + ' is missing: ' + missing.join(', '));
    assert.deepEqual(extra, [], code + ' has keys English does not: ' + extra.join(', '));
  });
});

test('no table ships an empty or non-string value', () => {
  Object.keys(STRINGS).forEach((code) => {
    Object.keys(STRINGS[code]).forEach((k) => {
      const v = STRINGS[code][k];
      assert.equal(typeof v, 'string', code + '.' + k + ' is not a string');
      assert.ok(v.trim().length > 0, code + '.' + k + ' is empty');
    });
  });
});

test('a translation keeps every placeholder the English has', () => {
  // "Send to {agency}" translated without {agency} silently drops the name.
  const ph = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort();
  Object.keys(STRINGS).forEach((code) => {
    if (code === 'en') return;
    Object.keys(STRINGS.en).forEach((k) => {
      assert.deepEqual(ph(STRINGS[code][k]), ph(STRINGS.en[k]),
        code + '.' + k + ' does not carry the same placeholders as English');
    });
  });
});

test('every key the widget asks for exists in the table', () => {
  const used = new Set();
  const re = /\bt\('([A-Za-z][A-Za-z0-9]*)'/g;
  let m;
  while ((m = re.exec(WIDGET))) used.add(m[1]);
  assert.ok(used.size > 80, 'expected the widget to be using the table, found ' + used.size);
  const missing = [...used].filter((k) => STRINGS.en[k] === undefined);
  assert.deepEqual(missing, [], 'used but not defined: ' + missing.join(', '));
});

test('every key in the table is actually reachable from the widget', () => {
  // A key nothing asks for is either a leftover or a string that was meant to
  // be wired up and was not. Both are worth knowing about.
  // Everything EXCEPT the table itself, so a key's own definition does not
  // count as a use of it. Most of the card renderers sit above the table in
  // the file, so this cannot be a slice from one point onwards.
  const at = WIDGET.indexOf('var STRINGS = {');
  const end = WIDGET.indexOf('\n};', WIDGET.indexOf("  ro: {", at)) + 3;
  const body = WIDGET.slice(0, at) + WIDGET.slice(end);
  const unreachable = Object.keys(STRINGS.en).filter((k) => body.indexOf("'" + k + "'") === -1);
  assert.deepEqual(unreachable, [], 'defined but never used: ' + unreachable.join(', '));
});

// ── lookup behaviour ──

test('the language comes from the client config, and Romanian resolves', () => {
  assert.equal(loadStrings('ro').t('askMeAnything'), 'Întreabă-mă orice...');
  assert.equal(loadStrings('en').t('askMeAnything'), 'Ask me anything...');
});

test('an unknown language falls back to English rather than to nothing', () => {
  assert.equal(loadStrings('xx').t('tryAsking'), 'Try asking');
  assert.equal(loadStrings('').t('tryAsking'), 'Try asking');
});

test('a missing key falls back to English, then to the key itself', () => {
  const { t, STRINGS: S } = loadStrings('ro');
  delete S.ro.tryAsking;
  assert.equal(t('tryAsking'), 'Try asking', 'a gap must show English words');
  assert.equal(t('noSuchKeyAnywhere'), 'noSuchKeyAnywhere', 'never render blank');
});

test('placeholders are substituted, and a missing value does not print undefined', () => {
  const { t } = loadStrings('ro');
  assert.equal(t('tellMeMoreAbout', { name: 'Creta' }), 'Spune-mi mai multe despre Creta');
  assert.equal(t('tellMeMoreAbout', { name: null }), 'Spune-mi mai multe despre ');
  assert.equal(t('tellMeMoreAbout'), 'Spune-mi mai multe despre {name}');
});

// ── the screens the client complained about ──

test('the home screen labels are no longer English literals', () => {
  for (const gone of [
    '<div class="tgx-section-label">What I can help with</div>',
    '<div class="tgx-section-label" style="margin-bottom:0">Try asking</div>',
    'placeholder="Ask me anything..."',
    '<div class="tgx-status"></div>Online now</div>',
    '<span>Prefer a person?</span>',
    '<div class="tgx-date" id="tgxDateDiv">Today</div>'
  ]) {
    assert.equal(WIDGET.indexOf(gone), -1, 'still hardcoded: ' + gone);
  }
});

test('the name form a visitor meets first is translated', () => {
  for (const key of ['nameHelp', 'yourName', 'emailOptional', 'marketingOptIn', 'continueLabel']) {
    assert.ok(WIDGET.indexOf("t('" + key + "')") !== -1, key + ' is not wired up');
  }
});

test('the search button on a destination card is translated', () => {
  assert.match(WIDGET, /link\.textContent = t\('seeDeals'\)/);
  assert.match(WIDGET, /t\('tellMeMoreAbout', \{ name: props\.name \}\)/);
});

test('the typing status lines are translated', () => {
  assert.match(WIDGET, /return t\('thinkingItThrough'\)/);
  assert.match(WIDGET, /var stage1 = t\('thinking'\)/);
  assert.doesNotMatch(WIDGET, /return "Looking up your booking…"/);
});

test('the status picker no longer shadows the translator', () => {
  // pickStage2Status had a local `var t` holding the visitor's message, which
  // hid the translator function of the same name from everything inside it.
  const fn = WIDGET.split('function pickStage2Status')[1].split('\n}')[0];
  assert.doesNotMatch(fn, /var t = /, 'a local `t` here makes the whole function untranslatable');
  assert.match(fn, /var txt = /);
});

// ── the client's own copy is theirs ──

test("a client's own words are never replaced by a translation", () => {
  // Only a value still identical to the English default is swapped. Anything
  // the client typed is their copy, in whatever language they chose.
  assert.match(WIDGET, /if \(C\[k\] === D\[k\]\) \{/);
  assert.match(WIDGET, /var localised = t\(LOCALISED_DEFAULT_KEYS\[k\]\);/);
});

test('the localisable defaults all map to a real key', () => {
  const block = WIDGET.slice(WIDGET.indexOf('var LOCALISED_DEFAULT_KEYS'));
  const map = block.slice(0, block.indexOf('};') + 2);
  [...map.matchAll(/:\s*'([A-Za-z]+)'/g)].forEach((m) => {
    assert.ok(STRINGS.en[m[1]], 'LOCALISED_DEFAULT_KEYS points at a missing key: ' + m[1]);
  });
});

test('interface text going through innerHTML is escaped', () => {
  // The strings are our own constants, but the rule in this widget is that
  // anything reaching innerHTML is escaped, and a rule with exceptions is not
  // a rule anyone remembers.
  const bad = [...WIDGET.matchAll(/innerHTML[^\n]*?\+\s*t\('/g)];
  assert.deepEqual(bad.map((m) => m[0]), [], 'unescaped t() in innerHTML');
  assert.match(WIDGET, /function esc\(v\) \{/);
});

test('the string table sits at file scope, above the block renderers', () => {
  // The block renderers (destination cards, weather, maps, enquiry forms) are
  // NOT inside the widget's IIFE — they are inlined above it at file scope.
  // Defining t()/esc() inside the IIFE therefore made every t() call in a card
  // renderer a ReferenceError, which threw mid-render and meant no reply ever
  // appeared in the bubble. Nothing in the unit tests caught it; a browser did.
  const iife = WIDGET.indexOf('\n(function() {\n"use strict";');
  assert.ok(iife !== -1, 'expected the widget IIFE');
  for (const decl of ['var TGX_LANG =', 'var STRINGS = {', 'function esc(v)', 'function t(key, vars)']) {
    const at = WIDGET.indexOf(decl);
    assert.ok(at !== -1, decl + ' is missing');
    assert.ok(at < iife, decl + ' must be at file scope, above the block renderers');
  }
  // And the renderers really do use them, which is why it matters.
  const renderers = WIDGET.slice(0, iife);
  assert.match(renderers, /t\('seeDeals'\)/, 'the card renderers must be using the table');
});

test('t() resolves the language without reading the IIFE config object', () => {
  const fn = WIDGET.slice(WIDGET.indexOf('function t(key, vars)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.doesNotMatch(body, /\bC\.language\b/,
    'C is not in scope for the block renderers; read TGX_LANG instead');
  assert.match(body, /STRINGS\[TGX_LANG\]/);
  assert.match(WIDGET, /TGX_LANG = \(C\.language && STRINGS\[C\.language\]\) \? C\.language : 'en';/,
    'rebuildConfig must keep the holder in step with the client config');
});

test('the file-scope helpers take their inputs, rather than reaching into the IIFE', () => {
  // This has bitten twice, and both times it threw at render rather than at
  // parse, so the unit tests stayed green and the widget simply went blank:
  //   - t() read C.language, and C is declared inside the IIFE
  //   - welcomeBackGreeting() read userName, same problem
  // The string table and the block renderers sit ABOVE the IIFE. Anything up
  // there must take what it needs as an argument or read a file-scope holder.
  //
  // Checked per function body rather than by scanning the whole file-scope
  // region: that region is full of regex literals containing quotes, which
  // defeats any cheap comment/string stripper. A broad scan here silently
  // stopped being able to fail at all, which is worse than not having one. The
  // backstop for the general case is the Chromium smoke, which caught both.
  const iife = WIDGET.indexOf('\n(function() {\n"use strict";');
  assert.ok(iife !== -1);
  const iifeOnly = ['C', 'D', 'userName', 'visitorProfile', 'isReturningVisitor',
    'visitorEmail', 'msgs', 'convId', 'nameCollected', 'marketingConsent', 'tripBrief'];

  ['function t(key, vars)', 'function esc(v)', 'function realName(value)',
   'function welcomeBackGreeting(name)'].forEach((sig) => {
    const at = WIDGET.indexOf(sig);
    assert.notEqual(at, -1, sig + ' is missing');
    assert.ok(at < iife, sig + ' must be at file scope, above the block renderers');
    const body = WIDGET.slice(at, WIDGET.indexOf('\n}\n', at) + 2)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    iifeOnly.forEach((n) => {
      assert.doesNotMatch(body, new RegExp('(?<![\\w$.\'"])' + n + '(?![\\w$])'),
        sig + ' reads ' + n + ', which is declared inside the IIFE');
    });
  });

  // And the renderers above the IIFE really do call into the table, which is
  // why any of this matters.
  assert.match(WIDGET.slice(0, iife), /t\('seeDeals'\)/);
});

test('t() resolves the language without reading the IIFE config object', () => {
  const fn = WIDGET.slice(WIDGET.indexOf('function t(key, vars)'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.doesNotMatch(body, /\bC\.language\b/,
    'C is not in scope for the block renderers; read TGX_LANG instead');
  assert.match(body, /STRINGS\[TGX_LANG\]/);
  assert.match(WIDGET, /TGX_LANG = \(C\.language && STRINGS\[C\.language\]\) \? C\.language : 'en';/,
    'rebuildConfig must keep the holder in step with the client config');
});

test('nothing at file scope reaches for a variable that lives inside the IIFE', () => {
  // This has bitten twice now, and both times it threw at render rather than at
  // parse, so the unit tests stayed green and the widget was simply blank:
  //   - t() read C.language, and C is declared inside the IIFE
  //   - welcomeBackGreeting() read userName, same problem
  // The block renderers and the string table sit ABOVE the IIFE. Anything up
  // there must take what it needs as an argument, or read a file-scope holder.
  const iife = WIDGET.indexOf('\n(function() {\n"use strict";');
  assert.ok(iife !== -1);
  // Blank out comments and string bodies so prose and CSS cannot raise a false
  // alarm. Done with a character scan rather than regexes: a lone apostrophe
  // inside a double-quoted string ("don't") makes a regex string-matcher run on
  // to the next one and swallow most of the file, which silently turned this
  // check into one that could never fail.
  const head = (function strip(src) {
    let out = '', i = 0;
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; out += ' '; continue; }
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; out += ' '; continue; }
      if (c === "'" || c === '"' || c === '`') {
        const q = c; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        i++; out += '""'; continue;
      }
      out += c; i++;
    }
    return out;
  })(WIDGET.slice(0, iife));
  const iifeOnly = ['C', 'D', 'userName', 'visitorProfile', 'isReturningVisitor',
    'visitorEmail', 'msgs', 'convId', 'nameCollected', 'marketingConsent', 'tripBrief'];
  const leaked = iifeOnly.filter((n) =>
    new RegExp('(?<![\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])').test(head));
  assert.deepEqual(leaked, [],
    'referenced at file scope but declared inside the IIFE: ' + leaked.join(', '));
});

test('no English literal reaches the DOM from the card renderers', () => {
  // The first pass at this translation missed fifteen strings, all of them in
  // the block renderers above the IIFE, and all because they are written with
  // the el(tag, class, text) helper rather than assigned to .textContent — a
  // shape the original sweep did not look for. "Tell me more" sat under a
  // Romanian paragraph for a week.
  //
  // So look for every shape that puts words on screen, not just the one that
  // was easy to grep.
  const iife = WIDGET.indexOf('\n(function() {\n"use strict";');
  // Cut out the two DEFINITION sites. A month name inside CALENDAR_NAMES, or a
  // string inside STRINGS, is the translation, not an untranslated literal.
  let head = WIDGET.slice(0, iife);
  for (const marker of ['var STRINGS = {', 'var CALENDAR_NAMES = {']) {
    const at = head.indexOf(marker);
    if (at === -1) continue;
    const end = head.indexOf('\n};', at) + 3;
    head = head.slice(0, at) + head.slice(end);
  }
  const patterns = [
    /el\(\s*'[a-z]+'\s*,\s*(?:'[^']*'|null)\s*,\s*'([^']{2,80})'/g,  // el(tag, class, 'text')
    /\.placeholder\s*=\s*'([^']{2,80})'/g,
    /\.textContent\s*=\s*'([^']{2,80})'/g,
    /\[\s*'([A-Z][a-z]{2,20})'\s*,/g                                  // ['Label', value] summary rows
  ];
  const found = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(head))) {
      const v = m[1];
      if (!/[a-z]{2}/.test(v)) continue;          // not prose
      if (v.startsWith('http') || v.startsWith('luna-')) continue;  // urls, class names
      if (v.indexOf('{') !== -1) continue;         // a template, not a literal
      found.add(v);
    }
  }
  assert.deepEqual([...found].sort(), [],
    'these render as English whatever the widget language is: ' + [...found].join(' | '));
});

test('month and day names follow the widget language', () => {
  // A date picker in English under a Romanian conversation is the same seam as
  // an English button.
  assert.match(WIDGET, /var CALENDAR_NAMES = \{/);
  assert.match(WIDGET, /ianuarie/, 'Romanian months must exist');
  assert.match(WIDGET, /'Sâm'/, 'Romanian day names must exist');
  assert.doesNotMatch(WIDGET, /var MONTH_FULL = \[/, 'the fixed English array must be gone');
  assert.doesNotMatch(WIDGET, /var DAY_SHORT = \[/);
  // Same length as English, or a date renders blank.
  const block = WIDGET.slice(WIDGET.indexOf('var CALENDAR_NAMES = {'));
  const table = block.slice(0, block.indexOf('\n};') + 3);
  const en = (table.match(/months: \[([^\]]*)\]/g) || []);
  assert.equal(en.length, 2, 'expected a months array per language');
  en.forEach((m) => assert.equal((m.match(/'/g) || []).length / 2, 12, 'twelve months: ' + m.slice(0, 40)));
  (table.match(/days: \[([^\]]*)\]/g) || []).forEach((d) =>
    assert.equal((d.match(/'/g) || []).length / 2, 7, 'seven days: ' + d.slice(0, 40)));
});

test('the enquiry card a visitor fills in is fully translated', () => {
  // The screenshot that prompted this: a Romanian conversation, then an
  // English form asking for "Your name" under "Get this priced by".
  for (const key of ['enquiryTitle', 'enqDestination', 'enqDates', 'enqTravelling',
    'enqFrom', 'enquiryNote', 'enquirySent', 'yourName']) {
    assert.ok(WIDGET.indexOf("t('" + key + "'") !== -1, key + ' is not wired up');
  }
  assert.match(WIDGET, /t\('enquiryTitle', \{ agency: agency \}\)/);
});
