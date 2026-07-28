// End-to-end smoke test against a REAL deployed Luna endpoint.
//
// Unlike the unit tests, this makes real HTTP calls and real model calls, so it
// spends a little Anthropic budget and reads the live knowledge base. Run it by
// hand against a staging (or production) deploy to confirm the fixes behave on
// the real stack, and — crucially — to SEE the brain being used via the
// kbGrounded flag on each answer.
//
// Usage:
//   LUNA_ENDPOINT="https://chat.travelify.io/api/luna-chat" \
//   LUNA_CLIENT="Your Client Name" \
//   npm run smoke
//
// Hard checks (fail the run): HTTP 200, non-empty reply, no raw protocol markers
// ([BLOCK], [/BLOCK], [LANG:], [FQ], [OPT], [BOOKING_LOOKUP:]) leaking into the
// visible reply. Soft checks (warn only): whether the brain grounded an answer
// it was expected to — soft because it depends on what is actually in your KB.

const ENDPOINT = process.env.LUNA_ENDPOINT;
const CLIENT = process.env.LUNA_CLIENT || 'Smoke Test';

if (!ENDPOINT) {
  console.log('SKIP: set LUNA_ENDPOINT to a deployed /api/luna-chat URL to run the smoke test.');
  console.log('  e.g. LUNA_ENDPOINT="https://chat.travelify.io/api/luna-chat" LUNA_CLIENT="Acme Travel" npm run smoke');
  process.exit(0);
}

// Each case: a message, and whether we EXPECT the curated brain to ground it.
// expectGrounded is a soft signal — travel/destination/policy questions should
// normally pull from the Luna Brain or destination context; greetings should not.
const CASES = [
  { message: 'What currency is used in Crete?', expectGrounded: true },
  { message: 'What plug type do they use in Spain?', expectGrounded: true },
  { message: 'Do I need a visa for Turkey with a UK passport?', expectGrounded: true },
  { message: 'What is the weather like in Tenerife in December?', expectGrounded: true },
  { message: 'Tell me about things to do in the Algarve', expectGrounded: true },
  { message: 'Hi there', expectGrounded: false },

  // COMMERCIAL LOYALTY bait. On a live client site Luna recommended the visitor
  // check Expedia and Booking.com — handing that agency's customer straight to a
  // competitor. The prompt rule alone proves nothing, so these deliberately
  // tempt her into it and the reply is checked for competitor names.
  { message: 'Where can I book this cheaper?', expectGrounded: false, noCompetitor: true },
  { message: 'Should I just book on Booking.com instead?', expectGrounded: false, noCompetitor: true },
  { message: 'Is it cheaper to book direct with the hotel?', expectGrounded: false, noCompetitor: true },
  { message: 'What other sites should I compare prices on?', expectGrounded: false, noCompetitor: true },
  { message: 'You do not seem to offer what I want, where else should I look?', expectGrounded: false, noCompetitor: true }
];

const MARKER_RE = /\[BLOCK\]|\[\/BLOCK\]|\[LANG:|\[FQ\]|\[OPT\]|\[BOOKING_LOOKUP:/i;

// Naming any of these on a client's own website is a hard failure.
const COMPETITOR_RE = /\b(expedia|booking\.com|skyscanner|kayak|tripadvisor|lastminute|loveholidays|on the beach|trivago|agoda|hotels\.com|airbnb|trailfinders|jet2holidays)\b/i;

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

async function ask(message) {
  const body = {
    message,
    convId: 'smoke_' + Math.random().toString(36).slice(2, 10),
    clientName: CLIENT,
    history: []
    // note: no stream flag → plain JSON response with kbGrounded
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* leave null */ }
  return { status: res.status, json };
}

(async () => {
  console.log('Luna E2E smoke test');
  console.log('  endpoint: ' + ENDPOINT);
  console.log('  client:   ' + CLIENT);
  console.log('');

  let hardFails = 0;
  let softWarns = 0;
  let grounded = 0;

  for (const c of CASES) {
    let line;
    try {
      const { status, json } = await ask(c.message);
      const reply = (json && typeof json.reply === 'string') ? json.reply : '';
      const kb = !!(json && json.kbGrounded);
      if (kb) grounded++;

      const problems = [];
      if (status !== 200) problems.push('HTTP ' + status);
      if (!reply || reply.trim().length < 2) problems.push('empty reply');
      if (MARKER_RE.test(reply)) problems.push('raw marker leaked into reply');
      if (c.noCompetitor) {
        const named = reply.match(COMPETITOR_RE);
        if (named) problems.push('NAMED A COMPETITOR: "' + named[0] + '" — sends business off the client site');
      }

      if (problems.length) { hardFails++; }
      if (c.expectGrounded && !kb) { softWarns++; }

      const flag = problems.length ? 'FAIL' : (c.expectGrounded && !kb ? 'WARN' : 'PASS');
      line = pad(flag, 5) + ' brain=' + (kb ? 'yes' : 'no ') + '  ' + pad('"' + c.message + '"', 52)
        + (problems.length ? '  <- ' + problems.join(', ') : (c.expectGrounded && !kb ? '  <- expected the brain to ground this' : ''));
    } catch (err) {
      hardFails++;
      line = pad('FAIL', 5) + '            ' + pad('"' + c.message + '"', 52) + '  <- ' + err.message;
    }
    console.log(line);
  }

  console.log('');
  console.log('brain grounded ' + grounded + '/' + CASES.length + ' answers');
  console.log(hardFails + ' hard failures, ' + softWarns + ' soft warnings');
  if (hardFails > 0) {
    console.log('RESULT: FAIL (structural problems — investigate before shipping)');
    process.exit(1);
  }
  if (softWarns > 0) {
    console.log('RESULT: PASS with warnings (brain did not ground a question it was expected to — check the KB has that fact)');
    process.exit(0);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})();
