// Luna must never send business away from the site she is embedded on.
//
// On a client's live travel website, Luna recommended the visitor check Expedia
// and Booking.com. That is the worst thing she can do: the agency pays for her,
// she sits on their site, and she handed their customer to a direct competitor.
//
// The old rule only covered being ASKED about a competitor ("if asked about a
// competitor, say...") and not disparaging them. Nothing stopped her
// volunteering one as a helpful suggestion, which is exactly what happened.
//
// These tests run the REAL handler and inspect the system prompt actually sent
// to the model for a client site.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let seq = 0;
const cid = () => 'loyalty-conv-' + (++seq);

async function clientSystemPrompt() {
  H.setReply('ok');
  const { captured } = await H.callHandler({
    message: 'where can I book this cheapest?',
    convId: cid(),
    clientName: 'Acme Travel'
  });
  assert.ok(captured.length, 'the model must have been called');
  const sys = captured[0].system;
  assert.ok(typeof sys === 'string' && sys.length > 0, 'a system prompt must be sent');
  return sys;
}

test('the client prompt carries an absolute commercial-loyalty rule', async () => {
  const sys = await clientSystemPrompt();
  assert.match(sys, /Commercial loyalty/i);
  assert.match(sys, /ABSOLUTE, no exceptions/i,
    'this must not read as a soft preference');
});

test('it forbids VOLUNTEERING a competitor, not just responding about one', async () => {
  const sys = await clientSystemPrompt();
  // The gap that let this happen: the rule was conditional on being asked.
  assert.match(sys, /not when asked, not unprompted/i,
    'the rule must bind whether or not the visitor raised it');
  assert.match(sys, /not even\s*\n?\s*when it would genuinely be helpful/i,
    'being helpful must not be an escape hatch — that is the exact rationalisation used');
});

test('the two platforms actually recommended are named as forbidden', async () => {
  const sys = await clientSystemPrompt();
  assert.match(sys, /Expedia/, 'Expedia was recommended on a live client site');
  assert.match(sys, /Booking\.com/, 'Booking.com was recommended on a live client site');
});

test('it closes the obvious workarounds', async () => {
  const sys = await clientSystemPrompt();
  assert.match(sys, /compares prices elsewhere|shops around|checks another\s*\n?\s*site/i,
    'must forbid "have a look around" style advice');
  assert.match(sys, /booking direct with an airline/i,
    'must forbid pushing the visitor to book direct instead of through the agency');
  assert.match(sys, /Do not name them even\s*\n?\s*to say we are better/i,
    'naming a competitor favourably-to-us is still naming them');
});

test('it tells Luna what to do INSTEAD, so she is not left stuck', async () => {
  const sys = await clientSystemPrompt();
  // A prohibition with no alternative just produces a worse answer.
  assert.match(sys, /ALWAYS to keep it here/i);
  assert.match(sys, /pass it to the team|take an enquiry/i);
});

test('the safety exemptions survive — FCDO and NHS are not competitors', async () => {
  const sys = await clientSystemPrompt();
  assert.match(sys, /ONLY outside sources you may ever point to/i);
  assert.match(sys, /FCDO/);
  assert.match(sys, /NHS or a GP/i);
  // And the obligations themselves must still be present.
  assert.match(sys, /gov\.uk\/foreign-travel-advice/);
  assert.match(sys, /fitfortravel\.nhs\.uk/);
});

test('the top-level NEVER list mentions it, not just the deep guardrails', async () => {
  const sys = await clientSystemPrompt();
  const neverAt = sys.indexOf('## What you must NEVER do');
  const loyaltyAt = sys.indexOf('Commercial loyalty');
  assert.ok(neverAt !== -1, 'the NEVER list must exist');
  const neverBlock = sys.slice(neverAt, neverAt + 700);
  assert.match(neverBlock, /Name or recommend another travel company/i,
    'it must appear early, not only buried in the guardrails section');
  assert.ok(neverAt < loyaltyAt, 'the summary comes before the detail');
});

test('Travelgenix own-site prompt still forbids naming competitors', async () => {
  H.setReply('ok');
  const { captured } = await H.callHandler({
    message: 'how do you compare to other providers?',
    convId: cid(),
    clientName: 'Travelgenix'
  });
  assert.match(captured[0].system, /Discuss competitor products or name competitors/i);
});
