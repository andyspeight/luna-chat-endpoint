// Luna Visitor History — server-side lookup for returning/cross-device memory.
//
// Given a clientName + an email and/or a visitorId, returns a COMPACT memory of
// that visitor's prior conversations with THIS client so the widget can greet a
// returning visitor (even on a new device) and give Luna continuity.
//
// Deliberately minimal exposure (privacy): returns only the visitor's name,
// when they were last seen, a conversation count, and a short topics/summary
// string — never full transcripts, and only ever scoped to the one client.
// Note: email is not verified (no OTP), so treat the returned memory as a
// convenience, not proof of identity. Read-only; cannot write or touch other
// tables; base/table/field ids are hardcoded so a caller cannot redirect it.
//
// Body (POST): { clientName, email?, visitorId? }  (at least one of email/visitorId)
// Returns: { found, name?, lastSeen?, count?, summary? }
// Env: AIRTABLE_KEY (server-held).

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');

const BASE = 'app6Ot3eOb3DangkB';
const TABLE = 'tblyin27D2J9ejHvf'; // Conversations
const F = {
  visitor:       'fldqx6k7WvrqE8BW1', // VisitorName
  email:         'fldZXcvl7k3FS5Gu7', // VisitorEmail
  visitorId:     'fldHkuGAIZMHYLWoC', // VisitorId
  summary:       'fldZ38GYN4XbHGl03', // Summary / running history
  lastMessageAt: 'fld1GghMiUnAmdtow', // LastMessageAt
  client:        'flde1PCByneD05YyG', // Client (link)
  topicTags:     'fldQNFhnyo3W2ngTZ'  // TopicTags (multipleSelects)
};

function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function isValidVisitorId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_\-]{6,64}$/.test(v);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Origin', '*'); // embeddable widget; no credentials

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) { console.error('[visitor-history] Missing AIRTABLE_KEY'); return res.status(500).json({ error: 'Service misconfigured' }); }

  var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'visitor-history', ipMax: 30, ipWindowSecs: 60 });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  var body = req.body || {};
  var clientName = (body.clientName || '').trim();
  var email = (body.email || '').trim();
  var visitorId = (body.visitorId || '').trim();

  if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });
  var useEmail = isValidEmail(email);
  var useVid = isValidVisitorId(visitorId);
  if (!useEmail && !useVid) return res.status(400).json({ error: 'Provide a valid email or visitorId' });

  try {
    var crec = await auth.resolveClientByName(atKey, clientName);
    if (!crec) return res.status(404).json({ error: 'Unknown client' });
    var clientRecId = crec.id || crec;

    var clauses = [];
    if (useEmail) clauses.push("{VisitorEmail}='" + email.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    if (useVid) clauses.push("{VisitorId}='" + visitorId.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
    var formula = clauses.length > 1 ? 'OR(' + clauses.join(',') + ')' : clauses[0];

    var url = 'https://api.airtable.com/v0/' + BASE + '/' + TABLE
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&maxRecords=50&returnFieldsByFieldId=true';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.error('[visitor-history] search failed:', r.status); return res.status(502).json({ error: 'Upstream error' }); }
    var d = await r.json();

    // Keep only this client's conversations, most recent first.
    var rows = (d.records || []).filter(function (rec) {
      var link = (rec.fields && rec.fields[F.client]) || [];
      return Array.isArray(link) && link.indexOf(clientRecId) !== -1;
    }).sort(function (a, b) {
      return new Date(b.fields[F.lastMessageAt] || 0) - new Date(a.fields[F.lastMessageAt] || 0);
    });

    if (!rows.length) return res.status(200).json({ found: false });

    var recent = rows[0].fields;
    var name = '';
    for (var i = 0; i < rows.length && !name; i++) { name = rows[i].fields[F.visitor] || ''; }

    // Aggregate clean topic tags across their conversations.
    var topics = [];
    rows.forEach(function (row) {
      var tags = row.fields[F.topicTags];
      if (Array.isArray(tags)) tags.forEach(function (t) {
        var name = (t && t.name) ? t.name : (typeof t === 'string' ? t : '');
        if (name && topics.indexOf(name) === -1) topics.push(name);
      });
    });

    var recentSummary = String(recent[F.summary] || '').replace(/\s+/g, ' ').trim().slice(0, 400);

    var parts = [];
    if (topics.length) parts.push("Topics they've discussed: " + topics.slice(0, 8).join(', '));
    if (recentSummary) parts.push('Most recent conversation: ' + recentSummary);

    return res.status(200).json({
      found: true,
      name: name || undefined,
      lastSeen: recent[F.lastMessageAt] || undefined,
      count: rows.length,
      summary: parts.join('. ') || undefined
    });
  } catch (e) {
    console.error('[visitor-history] error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }
};
