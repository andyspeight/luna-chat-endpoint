// Who do we email when something happens on a client's chat?
//
// Until now the answer was one field, ContactEmail, set once when Client
// Control provisioned the client and never touchable again. That field is
// doing two unrelated jobs:
//
//   1. it is where every notification goes — new chat, booking enquiry,
//      leave-a-message, and the Reply-To on a visitor's own transcript,
//   2. it is a SIGN-IN PATH. A client whose record has no AuthClientId can
//      only get into their dashboard by an exact ContactEmail match
//      (lib/luna-auth.js, api/auth-session.js).
//
// Which is why ContactEmail is NOT editable in the dashboard and must not
// become so: a client tidying up their notification address would lock
// themselves out of the product. So notifications get their own field,
// NotificationEmail (fldMxNXqfcurHXv3c on Clients), which the client owns and
// nothing else reads.
//
// The fallback is the whole point. NotificationEmail starts empty on all 29
// existing clients, and an empty one means "carry on exactly as before" —
// ContactEmail. Nothing changes for anyone until they choose to change it.
//
// Several addresses are allowed, comma separated, because a shop with a sales
// inbox and a manager both wanting the alert is the normal case.

'use strict';

// Matches the test every other notification path in this codebase already
// uses, so a recipient that was valid yesterday stays valid today.
var EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// Five is past the point where a real shop is using a distribution list
// instead. It also caps what one PATCH can turn into outbound mail.
var MAX_RECIPIENTS = 5;
// RFC 5321 ceiling for a whole address. Anything longer is a paste accident.
var MAX_ADDRESS = 254;

function isEmail(value) {
  var s = String(value == null ? '' : value).trim();
  return s.length > 0 && s.length <= MAX_ADDRESS && EMAIL_RE.test(s);
}

// Split a stored or submitted value into the addresses it actually contains.
// Commas, semicolons and newlines all separate, because people paste from
// Outlook. Invalid entries are dropped, not guessed at. Deduped case
// insensitively, keeping the first spelling the client typed.
function parseList(value) {
  if (value === null || value === undefined) return [];
  var raw = value;
  if (Array.isArray(raw)) raw = raw.join(',');
  var parts = String(raw).split(/[,;\n\r]+/);
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < parts.length; i++) {
    var one = parts[i].trim();
    if (!isEmail(one)) continue;
    var key = one.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(one);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

// Every address that should receive a notification for this client, given the
// raw Airtable fields object. Empty array means "do not send" — every caller
// treats that as a silent no-op, never an error.
//
// A NotificationEmail holding nothing usable falls through to ContactEmail
// rather than silencing the client. Someone typing rubbish straight into
// Airtable should not stop their enquiries arriving.
function recipients(fields) {
  var f = fields || {};
  var chosen = parseList(f.NotificationEmail);
  if (chosen.length) return chosen;
  return parseList(f.ContactEmail);
}

// The single address to use where only one is possible — a Reply-To header,
// a log line. '' when there is none.
function primary(fields) {
  return recipients(fields)[0] || '';
}

// True when this client has set their own notification address, i.e. the
// alerts are no longer going to whatever ContactEmail happens to hold.
function isCustom(fields) {
  return parseList((fields || {}).NotificationEmail).length > 0;
}

// Check a value on its way in from the dashboard. Returns the normalised
// string to store, or an error the client can act on. An empty value is
// valid and means "clear it, go back to the default".
function validate(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return { ok: true, value: '' };

  var parts = raw.split(/[,;\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!parts.length) return { ok: true, value: '' };
  if (parts.length > MAX_RECIPIENTS) {
    return {
      ok: false,
      error: 'That is ' + parts.length + ' addresses. Up to ' + MAX_RECIPIENTS
        + ' can be listed here — use a group address if you need more.'
    };
  }
  for (var i = 0; i < parts.length; i++) {
    if (!isEmail(parts[i])) {
      return { ok: false, error: 'That does not look like an email address: ' + parts[i] };
    }
  }
  // Store the cleaned-up, deduplicated version rather than what was typed.
  return { ok: true, value: parseList(parts.join(',')).join(', ') };
}

module.exports = {
  isEmail: isEmail,
  parseList: parseList,
  recipients: recipients,
  primary: primary,
  isCustom: isCustom,
  validate: validate,
  MAX_RECIPIENTS: MAX_RECIPIENTS
};
