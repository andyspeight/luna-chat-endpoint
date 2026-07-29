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

// Is this account one the signed-in user holds in their OWN right?
//
// "Acting as" means working inside an account that is not yours. That is the
// only question that matters, and ownership answers it directly:
// AuthClientId identifies the account's owner in the auth platform, and Client
// Control now sets it on every client it provisions.
//
// This replaces a guess based on the account's ContactEmail domain — a staff
// domain meant "ours", anything else meant "a client's". It broke the moment a
// client was provisioned with a colleague as the named contact: Snow Dragon Ski
// Holidays came through with luke.livsey@agendas.group, was read as one of ours,
// and vanished from the Act as list. Who is listed as the contact says nothing
// about who owns the account.
function isOwnedBy(record, ownRecords) {
  return ownRecords.some(function (o) { return o.id === record.id; });
}

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

    // Two DIFFERENT things, kept apart on purpose:
    //
    //   own  — the accounts this user holds in their own right. An agency with
    //          several websites has more than one. This is what the SWITCH
    //          control is for, and it is all a client ever sees.
    //   all  — every Luna account. Staff only. This is what ACT AS is for:
    //          opening a client's account to support them.
    //
    // Conflating the two was wrong. Switch is not a support tool.
    let own = [];

    if (currentAuthClientId) {
      const byAuth = await fetchClients(
        atKey,
        "{AuthClientId}='" + escFormula(currentAuthClientId) + "'",
        10
      );
      own = own.concat(byAuth);
    }

    // Legacy fallback for accounts not yet carrying an AuthClientId.
    if (own.length === 0) {
      const byEmail = await fetchClients(
        atKey,
        "LOWER({ContactEmail})='" + escFormula(email) + "'",
        10
      );
      own = own.concat(byEmail);
    }
    own = dedupeRecords(own);

    // STAFF ONLY. A client must never be shown another tenant's account.
    const staff = isCrossTenantUser(role, email);
    let all = [];
    if (staff) {
      all = await fetchClients(atKey, "TRUE()", 50);
    }

    // Entitlement is the union — what this user may open by any route.
    const candidates = dedupeRecords(own.concat(all));

    if (candidates.length === 0) {
      // LOG THE MISS. This path used to return silently, so when a real client
      // was locked out ("No Luna Chat client linked to your account") there was
      // nothing in the logs to say which identity had failed to match — the only
      // way to diagnose it was to ask the client what they typed. These two
      // values are exactly what has to be put on their record to let them in.
      console.warn('[auth-session] NO CLIENT MATCHED — user', email,
        'authClientId=' + (currentAuthClientId || '(none)'),
        'staff=' + staff,
        '| fix: set AuthClientId to that value, or ContactEmail to that address,'
        + ' on their Clients record');
      return res.status(404).json({
        error: 'No Luna Chat client linked to your account. Contact your account manager.'
      });
    }

    const brief = function (rec) {
      return {
        id: rec.id,
        name: (rec.fields && rec.fields.ClientName) || rec.id,
        // Lets the picker label client accounts, so opening one is a conscious act.
        // Somebody else's account, so opening it is "acting as" them.
        isClient: !isOwnedBy(rec, own)
      };
    };
    const summary = candidates.map(brief);
    const ownSummary = own.map(brief);
    // Only the accounts that are actually somebody else's are worth "acting as".
    const clientSummary = all.filter(function (rec) { return !isOwnedBy(rec, own); }).map(brief);

    let chosen = null;
    if (requestedClientId) {
      chosen = candidates.find(function (r) { return r.id === requestedClientId; });
      if (!chosen) {
        return res.status(403).json({ error: 'Requested client not linked to your account' });
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    }

    // ACTING AS — staff working inside a client's account. Staff only, by
    // definition: a client is never entitled to an account other than their own,
    // and their own is not a "client account" from their point of view.
    const actingAs = !!(staff && chosen && !isOwnedBy(chosen, own));

    console.log('[auth-session] user', email, 'role=' + role,
      'currentAuthClientId=' + (currentAuthClientId || '-'),
      'staff=' + staff,
      'own=' + own.length,
      'candidates=' + candidates.length,
      'chosen=' + (chosen ? chosen.id : '(picker)'),
      actingAs ? 'ACTING-AS' : '');

    return res.status(200).json({
      success: true,
      candidates: summary,
      // Your own accounts — drives Switch (an agency with several websites).
      accounts: ownSummary,
      // Client accounts — drives Act as. Empty for everyone except staff.
      clientAccounts: clientSummary,
      config: chosen ? buildConfig(chosen) : null,
      isStaff: staff,
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
