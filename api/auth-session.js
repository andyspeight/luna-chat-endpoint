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
//
// SECURITY (2 Jun 2026): this endpoint NO LONGER returns the raw Ably key to
// the browser. The dashboard now obtains a short-lived, capability-scoped Ably
// token from /api/ably-token (mode "agent") using this same session. The root
// key stays server-side. config.clientId is what the dashboard uses to request
// that token and to build its client-scoped channel names.

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
const ID_HOST = 'https://id.travelify.io';

const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io'
];

// SECURITY: cross-tenant listing is TRAVELGENIX STAFF ONLY. The auth platform's
// `role` is a role within the user's OWN organisation — a client who owns their
// agency account also has role 'owner'. Gating on role alone showed (and granted)
// every client every other tenant. Shared with lib/luna-auth.js so the list the
// user is shown can never drift from what they are actually entitled to.
const { isCrossTenantUser } = require('../lib/luna-auth');

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
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildConfig(record) {
  const f = record.fields || {};
  return {
    clientId: record.id,
    clientName: f.ClientName || '',
    clientSlug: f.ClientSlug || '',
    // ablyKey intentionally REMOVED — dashboard fetches a scoped token instead.
    email: f.ContactEmail || ''
  };
}

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

    // `own` = the account(s) this user holds in their OWN right. Tracked
    // separately from the staff-only cross-tenant list so the dashboard can tell
    // "my account" apart from "a client account I am supporting", and show the
    // ACTING AS banner accordingly.
    let own = [];
    let candidates = [];

    if (currentAuthClientId) {
      const byAuth = await fetchClients(
        atKey,
        "{AuthClientId}='" + escFormula(currentAuthClientId) + "'",
        10
      );
      own = own.concat(byAuth);
    }

    if (own.length === 0) {
      const byEmail = await fetchClients(
        atKey,
        "LOWER({ContactEmail})='" + escFormula(email) + "'",
        10
      );
      own = own.concat(byEmail);
    }

    candidates = candidates.concat(own);

    // STAFF ONLY. A client must never be shown another tenant's account.
    const staff = isCrossTenantUser(role, email);
    if (staff) {
      const allClients = await fetchClients(atKey, "TRUE()", 50);
      candidates = candidates.concat(allClients);
    }

    candidates = dedupeRecords(candidates);

    if (candidates.length === 0) {
      return res.status(404).json({
        error: 'No Luna Chat client linked to your account. Contact your account manager.'
      });
    }

    // The user's HOME account — the one they hold in their own right. For staff
    // this is the Travelgenix record; for a client it is their own agency. Any
    // other chosen client means they are ACTING AS that client, and the dashboard
    // says so loudly. The incident that prompted this was invisible precisely
    // because nothing on screen told you whose account you were looking at.
    const homeClientId = own.length ? own[0].id : null;

    const summary = candidates.map(function (rec) {
      return {
        id: rec.id,
        name: (rec.fields && rec.fields.ClientName) || rec.id,
        own: own.some(function (o) { return o.id === rec.id; })
      };
    });

    let chosen = null;
    if (requestedClientId) {
      chosen = candidates.find(function (r) { return r.id === requestedClientId; });
      if (!chosen) {
        return res.status(403).json({ error: 'Requested client not linked to your account' });
      }
    } else if (own.length === 1) {
      // Always land in your OWN account. Staff previously got dropped into a
      // picker listing every tenant; now supporting a client is a deliberate act.
      chosen = own[0];
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    }

    const actingAs = !!(chosen && homeClientId && chosen.id !== homeClientId);

    console.log('[auth-session] user', email, 'role=' + role,
      'currentAuthClientId=' + (currentAuthClientId || '-'),
      'staff=' + staff,
      'own=' + own.length,
      'candidates=' + candidates.length,
      'home=' + (homeClientId || '-'),
      'chosen=' + (chosen ? chosen.id : '(picker)'),
      actingAs ? 'ACTING-AS' : '');

    return res.status(200).json({
      success: true,
      candidates: summary,
      config: chosen ? buildConfig(chosen) : null,
      isStaff: staff,
      homeClientId: homeClientId,
      actingAs: actingAs,
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
