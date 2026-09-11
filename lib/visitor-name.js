// Is this a name a visitor actually gave us, or a placeholder we wrote?
//
// When someone chats without giving a name, the widget persists the
// conversation as "Anonymous" so the agent's list has something to show. That
// is a label for staff, not a name the visitor chose — but it was stored in the
// same field a real name goes in, and read back out of it just the same. So a
// Romanian visitor returning to bookingvacante.ro was greeted, in English,
// as "Welcome back, Anonymous!".
//
// The placeholder is still written (the agent list would otherwise be a column
// of blanks), and is filtered here on the way back out. Anything that is only a
// placeholder, only punctuation, or only whitespace counts as no name at all,
// and the caller falls back to a greeting that does not need one.

'use strict';

// Placeholders this system (or a person filling in a form) has used for
// "no name given". Matched whole, case-insensitively.
var PLACEHOLDERS = [
  'anonymous', 'anon', 'unknown', 'guest', 'visitor', 'n/a', 'na', 'none',
  'no name', 'noname', 'test', 'null', 'undefined', '-', '--'
];

// Returns the visitor's name, or '' if we do not really have one.
function realName(value) {
  if (value === null || value === undefined) return '';
  var raw = value;
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === 'object') raw = raw.name;
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // Nothing but punctuation or digits is not a name either.
  if (!/[\p{L}]/u.test(s)) return '';
  if (PLACEHOLDERS.indexOf(s.toLowerCase()) !== -1) return '';
  return s;
}

function isPlaceholder(value) {
  var s = String(value == null ? '' : value).trim();
  return s.length > 0 && realName(s) === '';
}

module.exports = { realName: realName, isPlaceholder: isPlaceholder, PLACEHOLDERS: PLACEHOLDERS };
