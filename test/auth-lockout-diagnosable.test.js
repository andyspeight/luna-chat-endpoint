// A locked-out client must be diagnosable from the logs alone.
//
// Jamie Wake Travel hit "No Luna Chat client linked to your account". The 404
// path returned without logging anything, so there was no way to see WHICH
// identity had failed to match — his auth client id and the email he signed in
// with are exactly the two values needed to fix his record, and neither was
// recorded. The only route left was to ask the client what they typed.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth-session.js'), 'utf8');

function noMatchBlock() {
  const start = SRC.indexOf('if (candidates.length === 0)');
  assert.ok(start !== -1, 'the no-match branch must exist');
  return SRC.slice(start, SRC.indexOf('}', SRC.indexOf('return res.status(404)', start)) + 1);
}

test('the no-client-matched path logs before returning 404', () => {
  const block = noMatchBlock();
  assert.match(block, /console\.(warn|error|log)\(/,
    'a client being locked out must never be silent in the logs');
  const logAt = block.search(/console\.(warn|error|log)\(/);
  const returnAt = block.indexOf('return res.status(404)');
  assert.ok(logAt !== -1 && logAt < returnAt, 'the log must come before the return');
});

test('it records the two values needed to fix the record', () => {
  const block = noMatchBlock();
  assert.match(block, /email/, 'the signed-in email must be logged — it goes in ContactEmail');
  assert.match(block, /currentAuthClientId/, 'the auth client id must be logged — it goes in AuthClientId');
});

test('the log line says what to do with them', () => {
  // Future me, at 9pm, with a client on the phone.
  const block = noMatchBlock();
  assert.match(block, /AuthClientId/);
  assert.match(block, /ContactEmail/);
});

test('the visitor-facing message stays unchanged and gives no internals away', () => {
  const block = noMatchBlock();
  assert.match(block, /No Luna Chat client linked to your account/);
  assert.doesNotMatch(block, /res\.status\(404\)\.json\(\{[^}]*email/,
    'the response body must not echo the email or ids back to the browser');
});
