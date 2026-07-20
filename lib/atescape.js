// Safe escaping for user input embedded in an Airtable formula string literal.
//
// Airtable formulas quote string literals with single quotes: {Field}='<value>'.
// The common `value.replace(/'/g, "\\'")` is NOT safe: it escapes the quote but
// NOT the backslash, so an input of a backslash followed by a quote becomes
// backslash-backslash-quote, which Airtable reads as an escaped backslash then a
// STRING TERMINATOR — the attacker is now outside the string and can alter the
// filter logic (cross-tenant record selection). The fix is to escape the
// backslash FIRST, then the quote.
//
// Also strips control characters, which have no place in a name/id/query and
// could otherwise confuse the formula parser.
'use strict';

var CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

function escapeFormulaString(v) {
  return String(v == null ? '' : v)
    .replace(CONTROL_CHARS, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

module.exports = { escapeFormulaString };
