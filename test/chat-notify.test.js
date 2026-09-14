// Tell the client when someone actually chats with them.
//
// Travelgenix had 36 conversations on their own website and heard about none.
// Four visitors clicked "Speak to our team" and nothing reached anybody,
// because the only email Luna sent came from the "leave a message" form, which
// none of them used. Everything else lived as a row in Airtable and a
// notification inside a dashboard nobody had open.
//
// The rule that matters: one email per conversation, not one per message, and a
// separate clearly-marked one the moment a visitor asks for a human.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notify = require('../lib/chat-notify');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'log-conversation.js'), 'utf8');

// ── when to send ──

test('a new conversation with a real visitor message is notified once', () => {
  const d = notify.decideNotification({ isNew: true, hasVisitorMessage: true });
  assert.equal(d.notify, true);
  assert.equal(d.urgent, false);
});

test('a later update to the same conversation is NOT notified again', () => {
  // One email per chat. One per message is how an alert becomes a mail rule.
  const d = notify.decideNotification({ isNew: false, hasVisitorMessage: true });
  assert.equal(d.notify, false);
});

test('asking for a human is notified, and marked urgent', () => {
  const d = notify.decideNotification({ isNew: false, hasVisitorMessage: true, escalated: true, wasEscalated: false });
  assert.equal(d.notify, true);
  assert.equal(d.urgent, true);
  assert.match(d.reason, /human/);
});

test('a handover on a brand new conversation is urgent, not merely new', () => {
  // "Speak to our team" as the first thing they click — the exact case that was
  // silently dropped four times on travelgenix.io.
  const d = notify.decideNotification({ isNew: true, hasVisitorMessage: true, escalated: true, wasEscalated: false });
  assert.equal(d.urgent, true);
});

test('a visitor who already asked is not chased on every later write', () => {
  const d = notify.decideNotification({ isNew: false, hasVisitorMessage: true, escalated: true, wasEscalated: true });
  assert.equal(d.notify, false);
});

test('a bot greeting nobody replied to is never emailed', () => {
  // Emailing these is how a useful alert gets muted.
  assert.equal(notify.decideNotification({ isNew: true, hasVisitorMessage: false }).notify, false);
  assert.equal(notify.decideNotification({ isNew: true, hasVisitorMessage: false, escalated: true }).notify, false);
});

test('a visitor message is detected from the stored transcript shape', () => {
  assert.equal(notify.hasVisitorMessage('bot: Good morning! How can we help you today?'), false);
  assert.equal(notify.hasVisitorMessage('bot: Good morning!\nuser: Speak to our team'), true);
  assert.equal(notify.hasVisitorMessage('bot: hi\nuser:   '), false, 'an empty visitor line is not a message');
  assert.equal(notify.hasVisitorMessage(''), false);
  assert.equal(notify.hasVisitorMessage(null), false);
});

// ── what it says ──

test('a handover email says so in the subject, where it will be seen', () => {
  const m = notify.buildChatEmail({ clientName: 'Travelgenix', urgent: true, summary: 'bot: hi\nuser: Speak to our team' });
  assert.match(m.subject, /wants to talk to you/);
  assert.match(m.html, /Waiting to speak to someone/);
});

test('an ordinary chat reads as a record, not an alarm', () => {
  const m = notify.buildChatEmail({ clientName: 'Travelgenix', visitorName: 'Luke', summary: 'bot: hi\nuser: Can I see a demo?' });
  assert.match(m.subject, /New chat on Travelgenix — Luke/);
  assert.doesNotMatch(m.html, /Waiting to speak/);
});

test('"Anonymous" never appears as a name, because it is ours not theirs', () => {
  const m = notify.buildChatEmail({ clientName: 'Travelgenix', visitorName: 'Anonymous', summary: 'bot: hi\nuser: hello' });
  assert.doesNotMatch(m.subject, /Anonymous/);
  assert.doesNotMatch(m.html, /Anonymous/);
});

test('the transcript is readable, with the visitor own words marked out', () => {
  const m = notify.buildChatEmail({ clientName: 'X', summary: 'bot: Good morning!\nuser: Speak to our team' });
  assert.match(m.html, /Visitor:/);
  assert.match(m.html, /Luna:/);
  assert.match(m.html, /Speak to our team/);
});

test('everything visitor-supplied is escaped, since it goes into an email', () => {
  const m = notify.buildChatEmail({
    clientName: 'X',
    visitorName: '<img src=x onerror=alert(1)>',
    visitorEmail: 'a"b@example.com',
    summary: 'user: <script>alert(1)</script>'
  });
  assert.doesNotMatch(m.html, /<script>/);
  assert.doesNotMatch(m.html, /<img src=x/);
  assert.match(m.html, /&lt;script&gt;/);
});

test('a chat with no contact details says how to reply anyway', () => {
  const m = notify.buildChatEmail({ clientName: 'X', summary: 'user: hi', dashboardUrl: 'https://d/' });
  assert.match(m.html, /did not leave contact details/);
  assert.match(m.html, /Open the conversation/);
});

test('a long transcript is capped rather than posting the whole thing', () => {
  const long = Array.from({ length: 200 }, (_, i) => 'user: line ' + i).join('\n');
  const m = notify.buildChatEmail({ clientName: 'X', summary: long });
  assert.ok((m.html.match(/line \d+/g) || []).length <= 40);
});

// ── the wiring ──

test('the notification is sent AFTER the record is written', () => {
  // A mail failure must never cost us the conversation row.
  const write = SRC.indexOf('Create failed');
  const send = SRC.indexOf('chatNotify.decideNotification');
  assert.ok(write !== -1 && send !== -1 && write < send, 'notify must come after the write');
});

test('a failed notification cannot fail the request', () => {
  assert.match(SRC, /catch \(notifyErr\) \{[\s\S]{0,160}non-fatal/);
});

test('it is awaited, because Vercel kills unawaited promises', () => {
  assert.match(SRC, /await sendChatNotification\(/);
});

test('it sends to the client ContactEmail, and no-ops when there is none', () => {
  assert.match(SRC, /var to = String\(f\.ContactEmail \|\| ''\)\.trim\(\);/);
  assert.match(SRC, /no ContactEmail for/);
  assert.match(SRC, /if \(!key\) return;/, 'no SendGrid key must be a silent no-op');
});

test('the client lookup returns the record, not just its id', () => {
  // It is the lookup that already has the ContactEmail; a second one would be
  // a second Airtable round trip on every conversation.
  assert.match(SRC, /var clientRecord = await findClientByName\(atKey, clientName\);/);
  assert.match(SRC, /var clientRecordId = clientRecord \? clientRecord\.id : null;/);
});
