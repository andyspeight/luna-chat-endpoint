// Luna Conversation API — server-side proxy for persisting chat conversations.
//
// WHY THIS EXISTS (security): the widget used to write/read the Airtable
// Conversations table DIRECTLY from the browser with an Airtable bearer token
// (C.airtableKey), which meant a working token shipped to every visitor's
// browser — read/write to the whole base. This endpoint moves that work
// server-side: the widget calls us, we call Airtable with the SERVER-held key
// (AIRTABLE_KEY). No Airtable token ever reaches a browser again.
//
// It performs a single operation: UPSERT a conversation row keyed on
// ConversationID. Create if absent, PATCH if present. Nothing else — it cannot
// read arbitrary data, cannot touch other tables, and the base/table/field ids
// are hardcoded here so a caller cannot redirect writes. Even if abused, the
// blast radius is "junk conversation rows", not a base-wide key.
//
// Body (POST): { convId, clientName, visitorName?, email?, handler?, history?, startedAt? }
// Returns: { ok: true, id, created } | { error }
//
// Conventions (CORS, rate-limit, validation, fail-closed) mirror ably-token.js.
// Env: AIRTABLE_KEY (server-held).

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');

// ── Fixed Luna Chat conversations location (NEVER taken from the client) ──
const BASE = 'app6Ot3eOb3DangkB';
const TABLE = 'tblyin27D2J9ejHvf'; // Conversations
const F = {
  convId:    'fldgQj90mYwsVO4yK', // ConversationID
  visitor:   'fldqx6k7WvrqE8BW1', // VisitorName
  handler:   'fldYdZq59FCpKQ7Hf', // Handler
  startedAt: 'fldSoy7BMqyzVb5pp', // StartedAt
  updatedAt: 'fld1GghMiUnAmdtow', // UpdatedAt
  history:   'fldZ38GYN4XbHGl03', // History (long text)
  email:     'fldZXcvl7k3FS5Gu7', // Email
  visitorId: 'fldHkuGAIZMHYLWoC', // VisitorId (for returning/cross-device recall)
  rating:    'fldw186Uuq2CP4hIc'  // VisitorRating (CSAT, 1-5)
};

const HANDLERS = ['Bot', 'AI', 'Waiting', 'Agent', 'Closed', 'Resolved'];
const MAX_HISTORY = 50000;
const MAX_NAME = 200;
const MAX_EMAIL = 200;

function isValidConvId(id) {
  // Same strict pattern as ably-token.js — both historical prefixes, bounded.
  return typeof id === 'string' && /^(?:conv|v)_\d{10,16}_[a-z0-9]{4,12}$/i.test(id) && id.length < 64;
}
function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Embeddable widget calls from arbitrary client sites and never sends
  // credentials, so a wildcard origin is correct here (mirrors the visitor
  // path in ably-token.js). No credentials are ever accepted.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    console.error('[conversation] Missing AIRTABLE_KEY');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  // Rate limit per IP — this writes to Airtable, so cap anonymous abuse.
  var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'conversation', ipMax: 30, ipWindowSecs: 60 });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  var body = req.body || {};
  var convId = (body.convId || '').trim();
  var clientName = (body.clientName || '').trim();

  if (!isValidConvId(convId)) return res.status(400).json({ error: 'Invalid convId' });
  if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });

  // Confirm the client is real before writing anything (anti-abuse; ties the
  // row to a known client exactly as the rest of the platform does).
  try {
    var crec = await auth.resolveClientByName(atKey, clientName);
    if (!crec) return res.status(404).json({ error: 'Unknown client' });
  } catch (e) {
    console.error('[conversation] client resolve error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }

  // Build the field set from validated inputs. UpdatedAt is always server-set.
  var now = new Date().toISOString();
  var fields = {};
  fields[F.updatedAt] = now;

  if (typeof body.visitorName === 'string' && body.visitorName.trim()) {
    fields[F.visitor] = str(body.visitorName.trim(), MAX_NAME);
  }
  if (body.email && isValidEmail(body.email.trim())) {
    fields[F.email] = body.email.trim();
  }
  if (typeof body.visitorId === 'string' && /^[A-Za-z0-9_\-]{6,64}$/.test(body.visitorId.trim())) {
    fields[F.visitorId] = body.visitorId.trim();
  }
  var _rating = Number(body.rating);
  if (Number.isInteger(_rating) && _rating >= 1 && _rating <= 5) {
    fields[F.rating] = _rating; // visitor CSAT
  }
  if (typeof body.handler === 'string' && HANDLERS.indexOf(body.handler) !== -1) {
    fields[F.handler] = body.handler;
  }
  if (typeof body.history === 'string' && body.history.length) {
    fields[F.history] = str(body.history, MAX_HISTORY);
  }

  var atBase = 'https://api.airtable.com/v0/' + BASE + '/' + TABLE;
  var authHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };

  try {
    // convId is strictly validated above (no quotes/specials) so it is safe to
    // embed in the formula. Find an existing row for this conversation.
    var searchUrl = atBase + '?filterByFormula=' + encodeURIComponent("{ConversationID}='" + convId + "'") + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    if (!sRes.ok) {
      var sErr = await sRes.text().catch(function () { return ''; });
      console.error('[conversation] Airtable search failed:', sRes.status, sErr.slice(0, 200));
      return res.status(502).json({ error: 'Upstream error' });
    }
    var sData = await sRes.json();

    if (sData.records && sData.records.length > 0) {
      // ── UPDATE existing row ──
      var recId = sData.records[0].id;
      var uRes = await fetch(atBase + '/' + recId, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ fields: fields, typecast: true })
      });
      if (!uRes.ok) {
        var uErr = await uRes.text().catch(function () { return ''; });
        console.error('[conversation] Airtable update failed:', uRes.status, uErr.slice(0, 200));
        return res.status(502).json({ error: 'Upstream error' });
      }
      return res.status(200).json({ ok: true, id: recId, created: false });
    }

    // ── CREATE new row ── (set ConversationID + StartedAt on first write)
    fields[F.convId] = convId;
    fields[F.startedAt] = (typeof body.startedAt === 'string' && body.startedAt) ? body.startedAt : now;
    if (!fields[F.handler]) fields[F.handler] = 'Bot';

    var cRes = await fetch(atBase, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ records: [{ fields: fields }], typecast: true })
    });
    if (!cRes.ok) {
      var cErr = await cRes.text().catch(function () { return ''; });
      console.error('[conversation] Airtable create failed:', cRes.status, cErr.slice(0, 200));
      return res.status(502).json({ error: 'Upstream error' });
    }
    var cData = await cRes.json();
    var newId = (cData.records && cData.records[0] && cData.records[0].id) || null;
    return res.status(200).json({ ok: true, id: newId, created: true });

  } catch (e) {
    console.error('[conversation] upsert error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }
};
