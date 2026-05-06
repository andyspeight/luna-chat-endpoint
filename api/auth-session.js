// Luna Chat session-based auth.
//
// Replaces the company+password flow with central session via cookie.
// Validates the tg_session cookie by calling id.travelify.io/api/auth/me,
// then looks up the Luna Chat client by the user's email and returns
// the same config shape as /api/auth (clientName, ablyKey, etc).
//
// Multiple clients may match (e.g. an admin viewing several companies' chats).
// The front-end shows a picker; on selection it posts back with clientId.

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
const ID_HOST = 'https://id.travelify.io';

const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io'
];

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function escFormula(s) {
  return String(s || '').replace(/'/g, "\\'");
}

function buildConfig(record) {
  const f = record.fields || {};
  return {
    clientId: record.id,
    clientName: f.ClientName || '',
    clientSlug: f.ClientSlug || '',
    ablyKey: f.AblyKey || '',
    email: f.ContactEmail || ''
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  try {
    // 1. Validate the central session by forwarding the cookie to id.travelify.io.
    const cookie = req.headers.cookie || '';
    if (!cookie.match(/(?:^|;\s*)tg_session=/)) {
      return res.status(401).json({ error: 'Not signed in' });
    }
    const meRes = await fetch(ID_HOST + '/api/auth/me', {
      method: 'GET',
      headers: { cookie: cookie }
    });
    if (meRes.status === 401) return res.status(401).json({ error: 'Session expired' });
    if (!meRes.ok) return res.status(502).json({ error: 'Auth check failed' });
    const meData = await meRes.json();
    if (!meData || !meData.ok || !meData.user || !meData.user.email) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const email = String(meData.user.email).trim().toLowerCase();
    const body = req.body || {};
    const requestedClientId = body.clientId ? String(body.clientId) : null;

    // 2. Find every Luna Chat client whose ContactEmail matches the user's email.
    const formula = encodeURIComponent("LOWER({ContactEmail})='" + escFormula(email) + "'");
    const url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + formula + '&maxRecords=10';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
    if (!r.ok) return res.status(502).json({ error: 'Client lookup failed' });
    const data = await r.json();
    const records = (data && data.records) || [];

    if (records.length === 0) {
      return res.status(404).json({
        error: 'No Luna Chat client linked to your account. Contact your account manager.'
      });
    }

    // Build candidate summary (always returned, useful for header / switcher)
    const candidates = records.map(function (rec) {
      return {
        id: rec.id,
        name: (rec.fields && rec.fields.ClientName) || rec.id
      };
    });

    // 3. Pick the right one
    let chosen = null;
    if (requestedClientId) {
      chosen = records.find(function (r) { return r.id === requestedClientId; });
      if (!chosen) {
        return res.status(403).json({ error: 'Requested client not linked to your account' });
      }
    } else if (records.length === 1) {
      chosen = records[0];
    }

    return res.status(200).json({
      success: true,
      candidates: candidates,
      config: chosen ? buildConfig(chosen) : null,
      account: {
        email: meData.user.email,
        fullName: meData.user.fullName || ''
      }
    });
  } catch (e) {
    console.error('auth-session error:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
