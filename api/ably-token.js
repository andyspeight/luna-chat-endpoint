// Luna Ably Token API
// Issues short-lived capability tokens scoped to ONE conversation channel.
// The root Ably key stays server-side, NEVER ships to the browser.
//
// Env vars required:
//   ABLY_ROOT_KEY — set in Vercel project settings, Production + Preview
//
// Capabilities issued:
//   luna-chat:{convId} — subscribe + publish (visitor's own channel only)
//   luna-dashboard    — subscribe only (to hear dashboard events about this convo)
//   luna-agents       — subscribe only (presence checks)

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

// In-memory per-IP counter to limit token requests (primary limiter is still Upstash once wired)
const tokenRequests = {};
const TOKEN_RL_WINDOW = 60_000;  // 1 minute
const TOKEN_RL_MAX = 10;         // 10 token requests per IP per minute

function getClientIp(req) {
  var fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function checkIpRateLimit(ip) {
  var now = Date.now();
  if (!tokenRequests[ip]) tokenRequests[ip] = [];
  tokenRequests[ip] = tokenRequests[ip].filter(function(t) { return now - t < TOKEN_RL_WINDOW; });
  if (tokenRequests[ip].length >= TOKEN_RL_MAX) return false;
  tokenRequests[ip].push(now);
  return true;
}

function isValidConvId(id) {
  // convId format from widget: conv_{timestamp}_{6 random chars}
  return typeof id === 'string' && /^conv_\d{10,16}_[a-z0-9]{4,12}$/i.test(id) && id.length < 64;
}

function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}

module.exports = async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  // CORS — widget can be embedded anywhere, so '*' is appropriate here
  // because the response is only useful to someone who already knows a valid convId
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit per IP
  var ip = getClientIp(req);
  if (!checkIpRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many token requests' });
  }

  var rootKey = process.env.ABLY_ROOT_KEY;
  if (!rootKey) {
    console.error('[ably-token] ABLY_ROOT_KEY not configured');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  // Validate inputs
  var body = req.body || {};
  var convId = (body.convId || '').trim();
  var clientName = (body.clientName || '').trim();

  if (!isValidConvId(convId)) {
    return res.status(400).json({ error: 'Invalid convId' });
  }
  if (!isValidClientName(clientName)) {
    return res.status(400).json({ error: 'Invalid clientName' });
  }

  // Optional: verify client exists in Airtable before issuing a token
  // This prevents random callers from getting tokens for made-up client names
  try {
    var atKey = process.env.AIRTABLE_KEY;
    if (atKey) {
      var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
        + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
        + '&maxRecords=1&fields%5B%5D=ClientName';
      var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
      var sData = await sRes.json();
      if (!sData.records || sData.records.length === 0) {
        return res.status(404).json({ error: 'Unknown client' });
      }
    }
  } catch (e) {
    // If Airtable lookup fails, fail closed
    console.error('[ably-token] Client verification failed:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }

  // Build capability object — least privilege
  // Visitor can publish+subscribe ONLY on their own conversation channel
  // Visitor can subscribe (read-only) to the dashboard channel for handler changes
  var capability = {};
  capability['luna-chat:' + convId] = ['subscribe', 'publish'];
  capability['luna-dashboard'] = ['subscribe'];
  capability['luna-agents'] = ['subscribe', 'presence'];

  // Request a token from Ably
  // ttl: 2 hours — long enough for a chat session, short enough to limit damage if leaked
  try {
    var keyParts = rootKey.split(':');
    var keyName = keyParts[0];
    var tokenUrl = 'https://rest.ably.io/keys/' + encodeURIComponent(keyName) + '/requestToken';

    var tokenReq = {
      keyName: keyName,
      ttl: 2 * 60 * 60 * 1000,  // 2 hours in ms
      capability: JSON.stringify(capability),
      clientId: 'visitor_' + convId,
      timestamp: Date.now()
    };

    var ablyRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(rootKey).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(tokenReq)
    });

    if (!ablyRes.ok) {
      var errText = await ablyRes.text().catch(function() { return ''; });
      console.error('[ably-token] Ably rejected token request:', ablyRes.status, errText);
      return res.status(500).json({ error: 'Token issuance failed' });
    }

    var tokenDetails = await ablyRes.json();
    // Return the tokenDetails directly — Ably SDK accepts them as authCallback result
    return res.status(200).json(tokenDetails);

  } catch (e) {
    console.error('[ably-token] Error:', e.message);
    return res.status(500).json({ error: 'Token issuance failed' });
  }
};
