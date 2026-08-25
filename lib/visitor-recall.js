// lib/visitor-recall.js
//
// Cross-device recall, done safely.
//
// WHY THIS EXISTS. /api/visitor-history used to accept an email and hand back
// that person's memory. Neither half of the request was a credential: clientName
// is public (it is in the embed snippet on every page of every client's site)
// and the email was never verified. So it answered "has this person been talking
// to this travel agent, and what about" for anybody who asked. It was removed on
// 25 Aug 2026, which cost the feature: recall stopped following a visitor to a
// new device.
//
// This brings it back by making the email an address we PROVE the visitor
// controls, with a one-time code emailed to it. The rules that keep it from
// becoming the same oracle again:
//
//   1. THE REQUEST STEP TELLS THE CALLER NOTHING. It returns exactly the same
//      response whether or not the address has ever chatted with that client.
//      The only signal is the email itself, which lands in the real owner's
//      inbox. Anything else rebuilds the thing we just deleted.
//
//   2. NO MAIL TO STRANGERS. A code is only ever sent to an address that HAS
//      chatted with this client. Otherwise anyone could point us at arbitrary
//      addresses and use us to post mail.
//
//   3. FAILURES ARE INDISTINGUISHABLE. "No code was ever issued", "wrong code"
//      and "expired" all return one message. Telling them apart would leak
//      whether the address is known.
//
//   4. THE CODE IS SHORT-LIVED, SINGLE USE AND ATTEMPT-CAPPED. Six digits is
//      only a million combinations, so it survives on being cheap to guess
//      wrong exactly five times.

'use strict';

const crypto = require('crypto');

const CODE_TTL_SECS = 10 * 60;   // long enough to switch to an inbox, short enough to matter
const MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;

// One message for every failure. See rule 3.
const GENERIC_FAILURE = 'That code was not recognised. It may have expired — request a new one.';

function normaliseEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function isValidEmail(e) {
  const s = normaliseEmail(e);
  return s.length > 0 && s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isValidCode(c) {
  return typeof c === 'string' && new RegExp('^\\d{' + CODE_DIGITS + '}$').test(c);
}

// Cryptographically random, and uniformly distributed.
//
// Math.random is not acceptable here: V8's generator is seeded per page and its
// state is recoverable from a few outputs. Modulo on a single random byte would
// also bias the low digits, so draw a uniform integer instead.
function newCode() {
  const max = Math.pow(10, CODE_DIGITS);
  return String(crypto.randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

// The code is stored as an HMAC, never in the clear.
//
// Keyed rather than a bare hash because six digits is a million combinations:
// a plain SHA-256 of the code could be reversed instantly from a Redis dump.
// Binding the client and the address into the message means a stolen digest
// cannot be replayed against a different visitor.
function hashCode(secret, clientId, email, code) {
  return crypto.createHmac('sha256', String(secret || ''))
    .update(String(clientId) + '\n' + normaliseEmail(email) + '\n' + String(code))
    .digest('hex');
}

// Constant-time. A length check first is safe: the length is not secret.
function codesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

// Redis key. The address is hashed rather than stored in the clear, so the key
// space is not a list of which visitors talk to which agency.
function codeKey(secret, clientId, email) {
  const h = crypto.createHmac('sha256', String(secret || ''))
    .update(String(clientId) + '\n' + normaliseEmail(email))
    .digest('hex')
    .slice(0, 32);
  return 'recall:' + h;
}

// The HMAC key. A dedicated secret is preferred; AIRTABLE_KEY is the fallback
// because it is always configured on this project and never leaves the server.
// Only ever used server-side, never transmitted.
function recallSecret() {
  return process.env.LUNA_RECALL_SECRET || process.env.AIRTABLE_KEY || '';
}

module.exports = {
  CODE_TTL_SECS,
  MAX_ATTEMPTS,
  CODE_DIGITS,
  GENERIC_FAILURE,
  normaliseEmail,
  isValidEmail,
  isValidCode,
  newCode,
  hashCode,
  codesMatch,
  codeKey,
  recallSecret
};
