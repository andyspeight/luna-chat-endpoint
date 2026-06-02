// Luna Ably Token API — central-key model with per-client channel isolation.
//
// ONE central Ably key (ABLY_ROOT_KEY) mints ALL tokens. The root key NEVER
// ships to any browser. Isolation between clients is enforced by signed
// capability tokens scoped to a per-client channel namespace keyed on the Luna
// Chat client's Airtable record id ({clientId}). Even though all clients share
// one Ably app, a token for client A literally cannot touch client B's
// channels — Ably enforces the capability server-side.
//
// Channels (all scoped):
//   luna-chat:{clientId}:{convId}
//   luna-dashboard:{clientId}
//   luna-agents:{clientId}
//
// Two modes:
//   VISITOR (mode omitted / "visitor"): unauthenticated, from the widget.
//     Body: { convId, clientName }. Capability:
//       luna-chat:{clientId}:{convId}  subscribe, publish
//       luna-dashboard:{clientId}      subscribe, publish   (announce new convo)
//       luna-agents:{clientId}         subscribe, presence  (READ presence only)
//
//   AGENT (mode "agent"): requires a valid tg_session cookie AND entitlement to
//     the requested clientId. Capability across the whole client namespace:
//       luna-chat:{clientId}:*         subscribe, publish
//       luna-dashboard:{clientId}      subscribe, publish
//       luna-agents:{clientId}         subscribe, publish, presence (ENTER)
//
// A visitor can never enter agent presence (so cannot fake "agent online"),
// and neither side can cross client boundaries. Fails closed everywhere.
//
// Env: ABLY_ROOT_KEY (central key), AIRTABLE_KEY.

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');

function isValidConvId(id) {
  return typeof id === 'string' && /^conv_\d{10,16}_[a-z0-9]{4,12}$/i.test(id) && id.length < 64;
}
function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}
function isValidRecordId(id) {
  return typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  // CORS. Visitor path is embedded anywhere ('*'); agent path needs credentials
  // so it echoes the specific origin. We set per-request below.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  var origin = req.headers.origin || '';
  var body = req.body || {};
  var mode = (body.mode === 'agent') ? 'agent' : 'visitor';

  if (mode === 'agent') {
    // Credentialed: echo origin + allow credentials (cookie).
    var AGENT_ORIGINS = ['https://chat.travelify.io', 'https://luna-chat-endpoint.vercel.app'];
    if (AGENT_ORIGINS.indexOf(origin) !== -1) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var rootKey = process.env.ABLY_ROOT_KEY;
  var atKey = process.env.AIRTABLE_KEY;
  if (!rootKey || !atKey) {
    console.error('[ably-token] Missing ABLY_ROOT_KEY or AIRTABLE_KEY');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  // Rate limit per IP (both modes).
  var rlResult = await ratelimit.checkIpAndKey(req, { ipKey: 'ably-token', ipMax: 30, ipWindowSecs: 60 });
  if (!rlResult.allowed) return res.status(429).json({ error: 'Too many token requests' });

  var clientId = null;
  var capability = {};
  var ablyClientId = '';

  try {
    if (mode === 'agent') {
      // ── AGENT: must be signed in AND entitled to the requested client ──
      var session = await auth.validateSession(req.headers.cookie || '');
      if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Unauthorised' });

      var reqClientId = body.clientId;
      if (!isValidRecordId(reqClientId)) return res.status(400).json({ error: 'Invalid clientId' });

      var rec = await auth.resolveEntitledClient(atKey, session, reqClientId);
      if (!rec) return res.status(403).json({ error: 'Not entitled to this client' });

      clientId = rec.id;
      var ns = clientId;
      capability['luna-chat:' + ns + ':*'] = ['subscribe', 'publish'];
      capability['luna-dashboard:' + ns] = ['subscribe', 'publish'];
      capability['luna-agents:' + ns] = ['subscribe', 'publish', 'presence'];
      ablyClientId = 'agent_' + (session.user.email || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');

    } else {
      // ── VISITOR: unauthenticated, strictly limited capability ──
      var convId = (body.convId || '').trim();
      var clientName = (body.clientName || '').trim();
      if (!isValidConvId(convId)) return res.status(400).json({ error: 'Invalid convId' });
      if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });

      var crec = await auth.resolveClientByName(atKey, clientName);
      if (!crec) return res.status(404).json({ error: 'Unknown client' });

      clientId = crec.id;
      var vns = clientId;
      capability['luna-chat:' + vns + ':' + convId] = ['subscribe', 'publish'];
      capability['luna-dashboard:' + vns] = ['subscribe', 'publish'];
      capability['luna-agents:' + vns] = ['subscribe', 'presence']; // read presence, cannot publish/enter
      ablyClientId = 'visitor_' + convId;
    }
  } catch (e) {
    console.error('[ably-token] resolve error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }

  // Mint the token against the CENTRAL key, scoped to the capability above.
  try {
    var keyName = rootKey.split(':')[0];
    var tokenUrl = 'https://rest.ably.io/keys/' + encodeURIComponent(keyName) + '/requestToken';
    var tokenReq = {
      keyName: keyName,
      ttl: 2 * 60 * 60 * 1000, // 2h
      capability: JSON.stringify(capability),
      clientId: ablyClientId,
      timestamp: Date.now()
    };
    var ablyRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(rootKey).toString('base64'), 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenReq)
    });
    if (!ablyRes.ok) {
      var errText = await ablyRes.text().catch(function () { return ''; });
      console.error('[ably-token] Ably rejected token:', ablyRes.status, errText);
      return res.status(500).json({ error: 'Token issuance failed' });
    }
    var tokenDetails = await ablyRes.json();
    // Return the token PLUS the resolved clientId so the client can build the
    // correctly-scoped channel names without guessing.
    return res.status(200).json({ token: tokenDetails, clientId: clientId });
  } catch (e) {
    console.error('[ably-token] mint error:', e.message);
    return res.status(500).json({ error: 'Token issuance failed' });
  }
};
