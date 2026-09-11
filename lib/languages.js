// The languages the Luna Chat widget can present itself in.
//
// This is about the widget's OWN furniture — its labels, placeholders, status
// messages and the Lang parameter on a search deep link. It is NOT about what
// language Luna answers in: she detects that from the visitor and follows them,
// in every language, regardless of what is set here. A German visitor on a
// Romanian agency's site gets German answers inside a Romanian widget, which is
// the right way round: the site belongs to the agency, the conversation belongs
// to the visitor.
//
// A language only belongs in this list once its strings are actually translated
// in public/widget-core.js (STRINGS) and lib/status-strings.js. Listing one
// before that just gives a client a setting that half works, which is how
// SupportedLanguages and MultilingualEnabled ended up as dashboard boxes that
// did nothing at all.
//
// To add a language: translate both string tables, add a row here, and add the
// choice to the WidgetLanguage field (fldRnOjynRDTqTn9a) on the Luna Clients
// table. The dashboard picker and the API validator both read this list.

'use strict';

// name: what a human picks in the dashboard and what Airtable stores.
// code: the widget's string-table key.
// deepLink: what the Travelify deep link's Lang parameter takes.
var LANGUAGES = [
  { name: 'English',  code: 'en', deepLink: 'EN', endonym: 'English' },
  { name: 'Romanian', code: 'ro', deepLink: 'RO', endonym: 'Română' }
];

var DEFAULT = LANGUAGES[0];

var byName = new Map();
var byCode = new Map();
LANGUAGES.forEach(function (l) {
  byName.set(l.name.toLowerCase(), l);
  byCode.set(l.code, l);
});

// Accepts whatever Airtable hands back: a plain string, a singleSelect object,
// a language code, or nothing at all. Never throws, never returns null — an
// unrecognised value falls back to English rather than leaving the widget with
// no strings to draw.
function resolve(value) {
  var raw = value;
  // Order matters: an Array is typeof 'object', so unwrap it FIRST or the
  // array branch below can never be reached and ['Romanian'] silently
  // resolves to English.
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === 'object') raw = raw.name;
  var key = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!key) return DEFAULT;
  return byName.get(key) || byCode.get(key) || DEFAULT;
}

function isSupported(value) {
  if (value === null || value === undefined || value === '') return false;
  var raw = value && typeof value === 'object' ? value.name : value;
  var key = String(raw).trim().toLowerCase();
  return byName.has(key) || byCode.has(key);
}

module.exports = {
  LANGUAGES: LANGUAGES,
  DEFAULT: DEFAULT,
  resolve: resolve,
  isSupported: isSupported,
  // Convenience wrappers so callers do not each re-implement the fallback.
  codeFor: function (v) { return resolve(v).code; },
  deepLinkCodeFor: function (v) { return resolve(v).deepLink; },
  names: function () { return LANGUAGES.map(function (l) { return l.name; }); }
};
