// The client chooses where their alerts go.
//
// Until now there was one address, ContactEmail, filled in by Client Control at
// provisioning and unreachable afterwards. That is how twelve live clients ended
// up with a Travelgenix or Agendas staff address receiving their enquiries, with
// no way for them to fix it themselves.
//
// It cannot simply be made editable. ContactEmail is a SIGN-IN PATH: a client
// whose record has no AuthClientId gets into their dashboard by an exact
// ContactEmail match (lib/luna-auth.js, api/auth-session.js). A client tidying
// up their notification address would have locked themselves out of Luna.
//
// So notifications get their own field. The fallback is the point: an empty
// NotificationEmail means ContactEmail, which is what every client has today, so
// nothing changes for anyone until they change it themselves.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notifyTo = require('../lib/notify-recipient');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const DASH = read('public/dashboard.html');
const PROFILE = read('api/profile.js');
const LOGCONV = read('api/log-conversation.js');
const ENQUIRY = read('api/luna-enquiry.js');
const LEAD = read('api/notify-lead.js');
const TRANSCRIPT = read('api/email-chat-transcript.js');
const AUTH = read('lib/luna-auth.js');
const SESSION = read('api/auth-session.js');

// ── the fallback, which is the whole safety story ──

test('an empty NotificationEmail means ContactEmail, exactly as before', () => {
  assert.deepEqual(
    notifyTo.recipients({ ContactEmail: 'sales@shop.co.uk' }),
    ['sales@shop.co.uk']
  );
  assert.deepEqual(
    notifyTo.recipients({ ContactEmail: 'sales@shop.co.uk', NotificationEmail: '' }),
    ['sales@shop.co.uk']
  );
  assert.deepEqual(
    notifyTo.recipients({ ContactEmail: 'sales@shop.co.uk', NotificationEmail: '   ' }),
    ['sales@shop.co.uk']
  );
  assert.equal(notifyTo.isCustom({ ContactEmail: 'sales@shop.co.uk' }), false);
});

test('a NotificationEmail takes over completely', () => {
  const fields = { ContactEmail: 'luke.livsey@agendas.group', NotificationEmail: 'rezervari@bookingvacante.ro' };
  assert.deepEqual(notifyTo.recipients(fields), ['rezervari@bookingvacante.ro']);
  assert.equal(notifyTo.primary(fields), 'rezervari@bookingvacante.ro');
  assert.equal(notifyTo.isCustom(fields), true);
});

test('a NotificationEmail holding nothing usable falls back rather than silencing', () => {
  // Typed straight into Airtable, past the dashboard's validation. Losing every
  // enquiry is a worse outcome than sending to the old address.
  assert.deepEqual(
    notifyTo.recipients({ ContactEmail: 'sales@shop.co.uk', NotificationEmail: 'not an address' }),
    ['sales@shop.co.uk']
  );
});

test('no address anywhere is an empty list, which every caller treats as a no-op', () => {
  assert.deepEqual(notifyTo.recipients({}), []);
  assert.deepEqual(notifyTo.recipients(null), []);
  assert.deepEqual(notifyTo.recipients(undefined), []);
  assert.equal(notifyTo.primary({}), '');
});

// ── several addresses, because a shop and a manager both want the alert ──

test('commas, semicolons and pasted newlines all separate', () => {
  const want = ['a@shop.co.uk', 'b@shop.co.uk'];
  assert.deepEqual(notifyTo.parseList('a@shop.co.uk, b@shop.co.uk'), want);
  assert.deepEqual(notifyTo.parseList('a@shop.co.uk;b@shop.co.uk'), want);
  assert.deepEqual(notifyTo.parseList('a@shop.co.uk\nb@shop.co.uk'), want);
  assert.deepEqual(notifyTo.parseList('  a@shop.co.uk ,, b@shop.co.uk  '), want);
});

test('the same address twice is one recipient, not two emails', () => {
  assert.deepEqual(
    notifyTo.parseList('Sales@Shop.co.uk, sales@shop.co.uk'),
    ['Sales@Shop.co.uk']
  );
});

test('the list is capped, so one field cannot turn into a mailshot', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => n + '@shop.co.uk').join(',');
  assert.equal(notifyTo.parseList(six).length, notifyTo.MAX_RECIPIENTS);
});

test('one bad entry in a list does not take the good ones with it', () => {
  assert.deepEqual(
    notifyTo.parseList('sales@shop.co.uk, rubbish, manager@shop.co.uk'),
    ['sales@shop.co.uk', 'manager@shop.co.uk']
  );
});

// ── nothing that reaches a mail header gets to be creative ──

test('an address carrying a newline is not an address', () => {
  // The classic header injection. Whitespace is excluded from the pattern, so
  // this never reaches SendGrid as a recipient.
  assert.equal(notifyTo.isEmail('sales@shop.co.uk\nBcc: someone@else.com'), false);
  assert.deepEqual(notifyTo.parseList('sales@shop.co.uk\r\nBcc: someone@else.com'), ['sales@shop.co.uk']);
  assert.equal(notifyTo.isEmail('sales@shop.co.uk, other@shop.co.uk'), false);
});

test('a paste accident is rejected on length', () => {
  assert.equal(notifyTo.isEmail('a'.repeat(300) + '@shop.co.uk'), false);
});

// ── what we accept, SendGrid must accept ──
//
// The first version of this gate was the loose pattern the old notification
// paths used. It waved through addresses that bounce, and because a stored
// value is non-empty, a stored bad value SUPPRESSES the ContactEmail fallback.
// A client pasting "<sales@shop.co.uk>" out of Outlook would have seen "Saved!"
// and then lost every enquiry, silently. Found by an adversarial review.

test('addresses that would bounce are refused, not saved', () => {
  const bounces = [
    'bob@shop.co.uk.',          // trailing full stop, the commonest paste error
    '<bob@shop.co.uk>',         // angle brackets out of a mail client
    'bob@shop.co.uk>',          // half of the same
    '.bob@shop.co.uk',          // leading dot
    'bob.@shop.co.uk',          // trailing dot on the local part
    'bob..smith@shop.co.uk',    // doubled dot
    'bob@shop..co.uk',          // doubled dot in the domain
    'bob@-shop.co.uk',          // label starting with a hyphen
    'bob@shop-.co.uk',          // label ending with a hyphen
    'bob@shop.c',               // one-letter TLD
    'bob@shop.co.123',          // numeric TLD
    'bob@localhost',            // no dot at all
    '"bob"@shop.co.uk',         // quoted local part
    'bob(hi)@shop.co.uk'        // comment syntax
  ];
  for (const b of bounces) {
    assert.equal(notifyTo.isEmail(b), false, 'accepted a bouncing address: ' + b);
    assert.equal(notifyTo.validate(b).ok, false, 'saved a bouncing address: ' + b);
  }
});

test('a bad stored value falls back instead of going quiet', () => {
  // This is the point of the whole exercise. Anything the gate now rejects is
  // dropped by parseList, so recipients() returns ContactEmail rather than an
  // address nothing can be delivered to.
  assert.deepEqual(
    notifyTo.recipients({ NotificationEmail: '<bob@shop.co.uk>', ContactEmail: 'real@shop.co.uk' }),
    ['real@shop.co.uk']
  );
});

test('every address a real client already uses still passes', () => {
  // Checked against the live Clients table. A stricter rule that rejected one
  // of these would have silenced that client's alerts, which is the exact
  // failure being fixed. The Gmail +alias and the hyphenated domain are the
  // two that a careless tightening breaks.
  const live = [
    'luke.livsey@agendas.group', 'andyspeight06+test@gmail.com',
    'andy.speight@agendas.group', 'admin@travelbookers.co.uk',
    'rashad.ali@cyphertravelsoftware.com', 'rares.biris@transilvania-soft.ro',
    'keith@hnholidays.co.uk', 'luis@travelnet.ie', 'jamie@jamiewaketravel.co.uk',
    'james@exploreescapes.co.uk', 'darren.swan@agendas.group',
    'hakon@snowdragonskiholidays.com', 'info@travelgenix.io',
    'stefan@tailorevents.se', 'tracy@yourticketgenie.com',
    'scott@murraytravel.co.uk', 'director@thatsmydreamholiday.com',
    'paras@globaltravelsolution.co.uk', 'tania@getzendra.com'
  ];
  for (const e of live) {
    assert.equal(notifyTo.isEmail(e), true, 'rejected a live client address: ' + e);
  }
});

test('ordinary shapes people actually type still pass', () => {
  for (const e of ['a@b.io', 'sales+luna@shop.co.uk', 'first.last@sub.domain.example.com',
                   'user_name@shop-site.com', "o'brien@shop.ie".replace(/'/g, '')]) {
    assert.equal(notifyTo.isEmail(e), true, 'rejected a normal address: ' + e);
  }
});

// ── validation on the way in from the dashboard ──

test('clearing the box is valid, and means go back to the default', () => {
  assert.deepEqual(notifyTo.validate(''), { ok: true, value: '' });
  assert.deepEqual(notifyTo.validate('   '), { ok: true, value: '' });
  assert.deepEqual(notifyTo.validate(null), { ok: true, value: '' });
});

test('a good value is stored tidied up, not as typed', () => {
  const r = notifyTo.validate('  Sales@shop.co.uk ,, sales@SHOP.co.uk , manager@shop.co.uk ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Sales@shop.co.uk, manager@shop.co.uk');
});

test('a typo comes back as something the client can act on', () => {
  const r = notifyTo.validate('sales@shop');
  assert.equal(r.ok, false);
  assert.match(r.error, /sales@shop/, 'the message must name what was wrong');
  assert.doesNotMatch(r.error, /^Save failed/);
});

test('too many addresses is refused with the number and the way out', () => {
  const r = notifyTo.validate(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => n + '@shop.co.uk').join(','));
  assert.equal(r.ok, false);
  assert.match(r.error, /6 addresses/);
  assert.match(r.error, /group address/);
});

// ── every notification path resolves the recipient in the one place ──

test('all four notification paths ask the shared resolver', () => {
  const paths = {
    'api/log-conversation.js': LOGCONV,
    'api/luna-enquiry.js': ENQUIRY,
    'api/notify-lead.js': LEAD,
    'api/email-chat-transcript.js': TRANSCRIPT
  };
  for (const [name, src] of Object.entries(paths)) {
    assert.match(src, /require\('\.\.\/lib\/notify-recipient'\)/, name + ' does not use the shared resolver');
    assert.match(src, /notifyTo\.(recipients|primary)\(/, name + ' does not call it');
  }
});

test('no notification path picks the recipient straight off ContactEmail any more', () => {
  // This is the drift guard. Four places used to read the same field their own
  // way; a fifth copy is how one of them would quietly keep emailing the old
  // address after a client had changed it.
  const paths = {
    'api/log-conversation.js': LOGCONV,
    'api/luna-enquiry.js': ENQUIRY,
    'api/notify-lead.js': LEAD,
    'api/email-chat-transcript.js': TRANSCRIPT
  };
  for (const [name, src] of Object.entries(paths)) {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /(fields|clientFields|f)\.ContactEmail/,
      name + ' still reads ContactEmail directly — route it through notify-recipient');
  }
});

test('the enquiry email addresses every recipient, not just the first', () => {
  assert.match(ENQUIRY, /to: to\.map\(function \(addr\) \{ return \{ email: addr \}; \}\)/);
});

test('the transcript Reply-To takes a single mailbox, so it takes the first', () => {
  assert.match(TRANSCRIPT, /clientReplyEmail = notifyTo\.primary\(fields\) \|\| null;/);
});

// ── the sign-in path is untouched, which is why this field exists ──

test('ContactEmail is still what an un-migrated client signs in with', () => {
  assert.match(AUTH, /LOWER\(\{ContactEmail\}\)=/);
  assert.match(SESSION, /LOWER\(\{ContactEmail\}\)=/);
});

test('the profile API never writes ContactEmail', () => {
  // A client editing their notification address must not be able to change the
  // address they log in with. There is no write path, and there must not be one.
  assert.doesNotMatch(PROFILE, /updateFields\.ContactEmail/);
  assert.doesNotMatch(PROFILE, /ContactEmail:\s/);
});

test('the dashboard offers no way to edit the sign-in address', () => {
  assert.equal(DASH.indexOf('setContactEmail'), -1);
  assert.doesNotMatch(DASH, /\bemail:\s*document\.getElementById/);
});

// ── the API and the dashboard ──

test('the profile API sends the setting, and what it resolves to today', () => {
  assert.match(PROFILE, /notificationEmail: fields\.NotificationEmail \|\| '',/);
  assert.match(PROFILE, /notificationEmailEffective: notifyTo\.recipients\(fields\)\.join\(', '\),/);
  assert.match(PROFILE, /notificationEmailMax: notifyTo\.MAX_RECIPIENTS,/);
});

test('the profile API validates before it stores, and an empty value clears it', () => {
  assert.match(PROFILE, /var ne = notifyTo\.validate\(body\.notificationEmail\);/);
  assert.match(PROFILE, /if \(!ne\.ok\) return res\.status\(400\)\.json\(\{ error: ne\.error \}\);/);
  assert.match(PROFILE, /updateFields\.NotificationEmail = ne\.value \|\| null;/);
});

test('the dashboard has the field, loads it and saves it', () => {
  assert.match(DASH, /id="setNotificationEmail"/);
  assert.match(DASH, /renderNotificationEmail\(p\);/);
  assert.match(DASH, /notificationEmail: document\.getElementById\('setNotificationEmail'\)\.value/);
});

test('a save that never read the profile cannot blank the address', () => {
  // The widget editor delegates to this same save function without opening
  // Settings, so the box can still be empty because nothing has filled it in
  // yet. Sending that empty value would clear the client's address and stop
  // their alerts, silently. An absent key is left alone by the API.
  assert.match(DASH, /\.\.\.\(profileLoaded \? \{ notificationEmail: document\.getElementById\('setNotificationEmail'\)\.value \} : \{\}\)/);
  assert.match(PROFILE, /if \(body\.notificationEmail !== undefined\) \{/);
});

test('the dashboard says where alerts are actually going right now', () => {
  // A blank box reads as "nothing is configured", when in fact the account
  // contact address has been receiving everything all along. That sentence is
  // the whole reason a client can find this setting at all.
  //
  // The first version of this test asserted three loose patterns against the
  // whole function body, and an adversarial review proved every one of them
  // was satisfied by a DIFFERENT branch than the one being described:
  // /notificationEmailEffective/ matched the variable declaration, /account
  // contact address/ matched the first branch's copy, and /nobody is being
  // emailed/ matched the last. Nothing bound to the middle branch at all.
  // Deleting that branch outright left the whole suite green. It is the branch
  // every one of the 29 live clients hits today, because none of them has set
  // a NotificationEmail, so the untested case was the only case in production.
  //
  // So each branch is now pinned to the sentence it actually renders.
  const fn = DASH.slice(DASH.indexOf('function renderNotificationEmail'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);

  // 1. the client has set their own address
  assert.match(body, /note\.textContent = 'Alerts are going to ' \+ effective \+/,
    'the custom-address branch must name the address it is going to');
  assert.match(body, /Clear this box to go back to your account contact address/,
    'the client must be told how to undo it');

  // 2. nothing set, so it falls back — the branch every live client sees
  assert.match(
    body,
    /note\.textContent = 'Nothing set here, so alerts are going to your account contact address, '\s*\+ effective \+/,
    'the fallback branch must exist AND name the address alerts are reaching'
  );
  assert.match(body, /Type an address above to send them somewhere else instead/);

  // 3. no address anywhere
  assert.match(body, /note\.textContent = 'No address is set, so nobody is being emailed/,
    'the no-address-at-all case must say so plainly');

  // and all three are still distinct branches of one chain
  assert.match(body, /if \(input\.value\) \{[\s\S]*\} else if \(effective\) \{[\s\S]*\} else \{/,
    'the three cases must stay three branches');
});

test('the client record is never concatenated into markup', () => {
  const fn = DASH.slice(DASH.indexOf('function renderNotificationEmail'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.doesNotMatch(body, /innerHTML/, 'an address off a client record must go in as text');
  assert.match(body, /note\.textContent =/);
});

test('a rejected save shows the reason, not the status code', () => {
  assert.match(DASH, /errBody\.error \|\| \('Save failed: ' \+ res\.status\)/);
});
