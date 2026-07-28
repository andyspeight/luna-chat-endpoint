// api/agent-specialisms.js
// ─────────────────────────────────────────────────────────────────────────────
// Owner-managed store for live-chat agents' free-text specialisms, used by
// skills-based routing. Kept as a JSON map { agentEmail: "Indian Ocean, Luxury" }
// on the client's own record (AgentSpecialisms), so no new table or per-agent
// auth identity is needed — the dashboard Team panel writes it, and each agent's
// dashboard reads the map (picking its own row by the signed-in email) to
// broadcast its specialisms in presence for routing.
//
// Auth: same posture as the other dashboard data endpoints — a valid central
// session that is entitled to the client. Never trust X-Client-Name alone.
//
//   GET  ?client=<name>            -> { map: { email: specialisms } }
//   POST { client, email, specialisms }  -> upsert one agent (empty specialisms deletes)
//
// Env: AIRTABLE_KEY.

'use strict';

const auth = require('../lib/luna-auth');
const ratelimit = require('../lib/ratelimit');

const AT_BASE = 'app6Ot3eOb3DangkB';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';
const F_SPECIALISMS = 'fldnVJgLfrZLNcYWK'; // Clients.AgentSpecialisms (JSON)

const AGENT_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io',
  'https://luna-chat.travelify.io',
  'http://localhost:3000',
  'http://localhost:5173'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && AGENT_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function isEmail(s) { return typeof s === 'string' && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s); }
function clip(s, n) { return String(s == null ? '' : s).slice(0, n).trim(); }

// Parse the stored JSON map defensively — a corrupt value must never throw.
function parseMap(raw) {
  if (!raw) return {};
  try {
    var o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
  } catch (e) { /* ignore */ }
  return {};
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var clientName = (req.headers['x-client-name'] || (req.body && req.body.client) || req.query.client || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Missing client identifier' });

  // ── AUTH (fail fast) ──
  var session = await auth.validateSession(req.headers.cookie || '');
  if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Not signed in' });

  try {
    var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'agent-specialisms', ipMax: 60, ipWindowSecs: 60 });
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });
  } catch (e) { /* limiter unavailable — proceed */ }

  try {
    var clientRec = await auth.resolveClientByName(atKey, clientName);
    if (!clientRec) return res.status(404).json({ error: 'Unknown client' });
    var entitled = await auth.resolveEntitledClient(atKey, session, clientRec.id);
    if (!entitled) return res.status(403).json({ error: 'Not entitled to this client' });

    var fields = (clientRec.fields || {});
    var map = parseMap(fields.AgentSpecialisms);

    if (req.method === 'GET') {
      return res.status(200).json({ map: map });
    }

    // POST — upsert one agent's specialisms. Empty specialisms removes the entry.
    var body = req.body || {};
    var email = clip(body.email, 200).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    var specialisms = clip(body.specialisms, 500);

    if (specialisms) map[email] = specialisms; else delete map[email];

    // Cap total size so the field can't be bloated (Airtable long-text is generous
    // but we keep it sane — a few hundred agents at most).
    var serialised = JSON.stringify(map);
    if (serialised.length > 90000) return res.status(413).json({ error: 'Too many entries' });

    var patchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CLIENTS_TABLE + '/' + clientRec.id;
    var patchFields = {};
    patchFields[F_SPECIALISMS] = serialised;
    var pr = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: patchFields })
    });
    if (!pr.ok) {
      var pe = await pr.text().catch(function () { return ''; });
      console.error('[agent-specialisms] write failed:', pr.status, pe.slice(0, 200));
      return res.status(502).json({ error: 'Upstream error' });
    }
    return res.status(200).json({ ok: true, map: map });
  } catch (e) {
    console.error('[agent-specialisms] error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }
};
