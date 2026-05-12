// Luna Chat session-based auth.
//
// Validates the tg_session cookie by calling id.travelify.io/api/auth/me,
// then maps the authenticated user to a Luna Chat client record.
//
// Lookup priority:
//   1. AuthClientId match — Luna Chat client whose AuthClientId equals the
//      user's currently-scoped auth-platform client (meData.client.recordId).
//      This is the proper modern path: the auth platform knows which client
//      the user is in, and each Luna Chat client carries the matching
//      auth-platform record id.
//   2. Owner/admin override — if the user has role owner or admin, they
//      can access ANY Luna Chat client. The dashboard picker lets them
//      choose which.
//   3. Legacy ContactEmail match — for any Luna Chat client whose record
//      doesn't yet have an AuthClientId. Lets us migrate incrementally
//      without breaking existing customers.
//
// If multiple candidates match, the picker is shown on the front end.

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
const ID_HOST = 'https://id.travelify.io';

const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io'
];

// Roles that can access ANY Luna Chat client via the picker. Mirrors the
// auth platform's role taxonomy — owners and admins are Travelgenix staff
// with cross-tenant access.
const CROSS_TENANT_ROLES = new Set(['owner', 'admin']);

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

/**
 * Fetch records from the Luna Chat Clients table with a given filter.
 * Returns the raw Airtable records array.
 */
async function fetchClients(atKey, filterFormula, maxRecords) {
  const url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
    + '?filterByFormula=' + encodeURIComponent(filterFormula)
    + '&maxRecords=' + (maxRecords || 50);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
  if (!r.ok) {
    throw new Error('Airtable lookup failed: ' + r.status);
  }
  const data = await r.json();
  return (data && data.records) || [];
}

/**
 * De-duplicate an array of Airtable records by record id, preserving order.
 */
function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  return out;
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
    const role = String((meData.user.role || '')).toLowerCase();
    const currentAuthClientId = meData.client && meData.client.recordId;
    const body = req.body || {};
    const requestedClientId = body.clientId ? String(body.clientId) : null;

    // 2. Build the candidate list using the priority order described above.
    let candidates = [];

    // 2a. Match by AuthClientId on the current scoped client (the modern path).
    if (currentAuthClientId) {
      const byAuth = await fetchClients(
        atKey,
        "{AuthClientId}='" + escFormula(currentAuthClientId) + "'",
        10
      );
      candidates = candidates.concat(byAuth);
    }

    // 2b. Cross-tenant override: owners and admins can pick from ALL Luna
    // Chat clients. We fetch up to 50 — enough for any realistic Travelgenix
    // estate. If you grow past that we'll add proper pagination.
    if (CROSS_TENANT_ROLES.has(role)) {
      const allClients = await fetchClients(atKey, "TRUE()", 50);
      candidates = candidates.concat(allClients);
    }

    // 2c. Legacy ContactEmail fallback — covers Luna Chat clients that
    // haven't been migrated to the AuthClientId model yet.
    if (candidates.length === 0) {
      const byEmail = await fetchClients(
        atKey,
        "LOWER({ContactEmail})='" + escFormula(email) + "'",
        10
      );
      candidates = candidates.concat(byEmail);
    }

    // De-duplicate (an owner whose email IS on a Luna Chat client would
    // otherwise see it listed twice).
    candidates = dedupeRecords(candidates);

    if (candidates.length === 0) {
      return res.status(404).json({
        error: 'No Luna Chat client linked to your account. Contact your account manager.'
      });
    }

    // 3. Build the summary list returned to the front-end (always returned,
    // even when only one candidate matched — the dashboard uses it for the
    // company switcher menu).
    const summary = candidates.map(function (rec) {
      return {
        id: rec.id,
        name: (rec.fields && rec.fields.ClientName) || rec.id
      };
    });

    // 4. Pick the right one to return as `config`.
    //
    // Priority:
    //   - If the front-end requested a specific clientId (user clicked it
    //     in the picker), respect that, but only if it's in the candidate
    //     list (so users can't escalate by guessing record ids).
    //   - Else if there's exactly one candidate, use it.
    //   - Else (multiple candidates, no explicit request), return null —
    //     the front-end will render the picker.
    let chosen = null;
    if (requestedClientId) {
      chosen = candidates.find(function (r) { return r.id === requestedClientId; });
      if (!chosen) {
        return res.status(403).json({ error: 'Requested client not linked to your account' });
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    }

    // Diagnostic — easy to spot in Vercel logs while we're migrating
    console.log('[auth-session] user', email, 'role=' + role,
      'currentAuthClientId=' + (currentAuthClientId || '-'),
      'candidates=' + candidates.length,
      'chosen=' + (chosen ? chosen.id : '(picker)'));

    return res.status(200).json({
      success: true,
      candidates: summary,
      config: chosen ? buildConfig(chosen) : null,
      account: {
        email: meData.user.email,
        fullName: meData.user.fullName || '',
        role: meData.user.role || ''
      }
    });
  } catch (e) {
    console.error('auth-session error:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
