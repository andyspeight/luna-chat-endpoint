// Source guards for the convId write-binding hardening.
//
// Conversations and enquiries are located by ConversationID alone, and convIds
// travel in Ably channel names. Without an owner check, anyone who knows a
// convId could overwrite or reassign another tenant's row. These guards ensure
// the binding stays in place.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONV = read('api/conversation.js');
const LOGCONV = read('api/log-conversation.js');
const ENQ = read('api/luna-enquiry.js');

test('conversation.js refuses to update a row owned by another client', () => {
  assert.match(CONV, /client:\s*'flde1PCByneD05YyG'/, 'the Client field must be mapped');
  assert.match(CONV, /existClient\.indexOf\(crec\.id\) === -1[\s\S]{0,120}status\(403\)/,
    'an update to a row owned by a different client must 403');
  assert.match(CONV, /fields\[F\.client\] = \[crec\.id\]/, 'new rows must be bound to their owner');
});

test('log-conversation.js never reassigns the client and refuses cross-client updates', () => {
  // The old unconditional reassignment must be gone.
  assert.doesNotMatch(LOGCONV, /if \(clientRecordId\) fields\[F\.client\] = \[clientRecordId\];/,
    'the unconditional client reassignment must be removed');
  assert.match(LOGCONV, /ownerId !== clientRecordId[\s\S]{0,120}status\(403\)/,
    'an update to a row owned by a different client must 403');
  assert.match(LOGCONV, /if \(!existingClient\.length\) fields\[F\.client\] = \[clientRecordId\]/,
    'the client link is only set when the row has no owner');
});

test('luna-enquiry.js scopes idempotent reuse to the same client', () => {
  assert.match(ENQ, /erOwner === clientId/, 'an existing enquiry is only reused when it belongs to this client');
  // and the idempotency formula escapes backslash before quote (no duplicate-row break)
  assert.match(ENQ, /convFormula = conversationId\.replace\(\/\\\\\/g, '\\\\\\\\'\)\.replace\(\/'\/g, "\\\\'"\)/,
    'the convId formula must be escaped backslash-first');
  // the stored value must be the clean (unescaped) convId, not the formula copy
  assert.match(ENQ, /var conversationId = clip\(body\.conversationId, 60\);/,
    'the stored conversationId must not carry formula escaping');
});
