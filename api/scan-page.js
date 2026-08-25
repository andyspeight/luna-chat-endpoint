// api/scan-page.js
// Fetches a webpage URL and extracts clean text content for Luna's knowledge base.
// Called by the dashboard Settings > Train Luna feature.
//
// AUTH: the central tg_session cookie, plus an entitlement check on the client
// being trained. Same pattern as /api/luna-brain and /api/profile.
//
// It used to accept the X-Client-Name header on its own, with a comment claiming
// tg-auth-gate had already authenticated the caller. That was wrong: tg-auth-gate
// runs in the browser, so it gates the PAGE, not the endpoint.
// Anyone who knew a client's name — it is in the embed snippet on every one of
// their web pages — could post here and use our server as an open URL fetcher,
// and every scan they triggered ate that client's rate-limit budget.
//
// Order matters below: the per-IP limit is checked BEFORE the session hop, so a
// flood cannot be turned into a flood against id.travelify.io. The per-client
// limit is checked after, keyed on the resolved record id rather than on an
// attacker-supplied string.
//
// The SSRF-hardened fetch and text extraction live in lib/safe-scrape.js, shared
// with the proactive discovery crawler so the protections never drift apart.

const ratelimit = require('../lib/ratelimit');
const scrape = require('../lib/safe-scrape');
const auth = require('../lib/luna-auth');

// Credentialed requests cannot use a wildcard origin, and this endpoint now
// needs the session cookie. The dashboard calls it same-origin, so this list
// only matters if it is ever called from another of our hosts.
const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var clientName = String(req.headers['x-client-name'] || '').trim();
  var body = req.body || {};
  var url = body.url;

  if (!clientName) {
    return res.status(400).json({ error: 'Missing client identifier' });
  }

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  // Per-IP limit BEFORE the auth hop — an unauthenticated flood must not become
  // a flood against the login service.
  var ipCheck = await ratelimit.checkIpAndKey(req, {
    ipKey: 'scan-page',
    ipMax: 20,            // 20 scans/min/IP
    ipWindowSecs: 60
  });
  if (!ipCheck.allowed) {
    return res.status(429).json({
      success: false,
      error: 'Too many scan requests. Please wait a minute and try again.'
    });
  }

  var session = await auth.validateSession(req.headers.cookie || '');
  if (!session.ok) {
    return res.status(session.status || 401).json({ error: session.error || 'Not signed in' });
  }

  var client;
  try {
    client = await auth.resolveClientByName(atKey, clientName);
  } catch (e) {
    console.error('[scan-page] client lookup failed:', e && e.message);
    return res.status(502).json({ error: 'Could not check your account. Please try again.' });
  }
  if (!client) return res.status(404).json({ error: 'Client not found' });

  var entitled = await auth.resolveEntitledClient(atKey, session, client.id);
  if (!entitled) return res.status(403).json({ error: 'Not entitled to this client' });

  // Per-client limit, keyed on the RESOLVED record id. Keying it on the header
  // let anyone spend a client's budget, and let one client spend another's by
  // sending their name.
  //
  // check() directly, not checkIpAndKey() again — that would INCR the per-IP
  // counter a second time for the same request and silently halve the IP limit.
  var clientCheck = await ratelimit.check('rl:scan-page:client:' + client.id, 10, 60);
  if (!clientCheck.allowed) {
    return res.status(429).json({
      success: false,
      error: 'Too many scan requests. Please wait a minute and try again.'
    });
  }

  // Delegate the SSRF-checked fetch + readable-text extraction to the shared lib.
  var result = await scrape.scrapeUrl(url, { timeoutMs: 15000, maxHops: 3 });

  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false,
      error: result.error
    });
  }

  return res.status(200).json({
    success: true,
    url: result.url,
    title: result.title,
    content: result.content,
    charCount: result.charCount,
    wordCount: result.wordCount
  });
};
