// api/scan-page.js
// Fetches a webpage URL and extracts clean text content for Luna's knowledge base.
// Called by the dashboard Settings > Train Luna feature.
//
// Auth: X-Client-Name header. The dashboard is gated by tg-auth-gate, which
// manages session cookies — so requests reaching this endpoint from the
// dashboard are already authenticated at the gate. We require X-Client-Name
// purely to scope the rate limiter and surface the client in logs.
//
// The SSRF-hardened fetch and text extraction live in lib/safe-scrape.js, shared
// with the proactive discovery crawler so the protections never drift apart.

const ratelimit = require('../lib/ratelimit');
const scrape = require('../lib/safe-scrape');

module.exports = async function handler(req, res) {
  // CORS — X-Client-Pass kept in allowed headers list for back-compat,
  // even though we no longer require it. Safe to remove in a future cleanup.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name, X-Client-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var clientName = req.headers['x-client-name'];
  var body = req.body || {};
  var url = body.url;

  // Auth: just X-Client-Name (tg-auth-gate session cookie handles real auth at the gate).
  if (!clientName) {
    return res.status(401).json({ error: 'Missing client identifier' });
  }

  // Rate limit: per-IP + per-client (fails open on Redis error)
  var rlResult = await ratelimit.checkIpAndKey(req, {
    ipKey: 'scan-page',
    ipMax: 20,            // 20 scans/min/IP
    ipWindowSecs: 60,
    keyKey: 'scan-page:client:' + clientName,
    keyMax: 10,           // 10 scans/min/client
    keyWindowSecs: 60
  });
  if (!rlResult.allowed) {
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
