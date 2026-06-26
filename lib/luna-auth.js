// lib/luna-auth.js
//
// Shared authentication + client-entitlement helper for Luna Chat server
// routes. Single source of truth so ably-token.js and auth-session.js validate
// sessions and resolve clients identically (no drift between them).
//
// Two capabilities:
//   validateSession(cookie)            -> { ok, user, currentAuthClientId } | { ok:false }
//   resolveClient({ atKey, ... })      -> the Airtable client record the caller
//                                         is entitled to, by clientId or clientName,
//                                         honouring AuthClientId / role / email rules.
//
// The agent-token path uses BOTH (must be a signed-in, entitled agent).
// The visitor-token path uses ONLY resolveClientByName (no session needed) but
// gets a strictly lower-privilege capability set — enforced by the caller.

const ID_HOST = 'https://id.travelify.io';
const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

const CROSS_TENANT_ROLES = new Set(['owner', 'admin']);

function escFormula(s) {
  return String(s || '').replace(/['\\]/g, '');
}

async function fetchClients(atKey, filterFormula, maxRecords) {
  const url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
    + '?filterByFormula=' + encodeURIComponent(filterFormula)
    + '&maxRecords=' + (maxRecords || 50);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
  if (!r.ok) throw new Error('Airtable lookup failed: ' + r.status);
  const data = await r.json();
  return (data && data.records) || [];
}

/**
 * Validate the central tg_session cookie against id.travelify.io.
 * Returns { ok:true, user, role, currentAuthClientId } or { ok:false, status, error }.
 */
async function validateSession(cookie) {
  if (!cookie || !cookie.match(/(?:^|;\s*)tg_session=/)) {
    return { ok: false, status: 401, error: 'Not signed in' };
  }
  let meRes;
  try {
    meRes = await fetch(ID_HOST + '/api/auth/me', { method: 'GET', headers: { cookie: cookie } });
  } catch (e) {
    return { ok: false, status: 502, error: 'Auth check failed' };
  }
  if (meRes.status === 401) return { ok: false, status: 401, error: 'Session expired' };
  if (!meRes.ok) return { ok: false, status: 502, error: 'Auth check failed' };
  const meData = await meRes.json().catch(function () { return null; });
  if (!meData || !meData.ok || !meData.user || !meData.user.email) {
    return { ok: false, status: 401, error: 'Invalid session' };
  }
  return {
    ok: true,
    user: meData.user,
    role: String(meData.user.role || '').toLowerCase(),
    currentAuthClientId: meData.client && meData.client.recordId
  };
}

/**
 * Resolve the Luna Chat client record an AUTHENTICATED agent is entitled to,
 * for a specific clientId. Mirrors auth-session.js entitlement rules so an
 * agent can only ever get a token for a client they may access.
 * Returns the Airtable record, or null if not entitled.
 */
async function resolveEntitledClient(atKey, session, clientId) {
  if (!clientId) return null;

  // Owners/admins may access any client.
  if (CROSS_TENANT_ROLES.has(session.role)) {
    const recs = await fetchClients(atKey, "RECORD_ID()='" + escFormula(clientId) + "'", 1);
    return recs[0] || null;
  }

  // Otherwise the client must match the user's scoped AuthClientId...
  if (session.currentAuthClientId) {
    const recs = await fetchClients(
      atKey,
      "AND(RECORD_ID()='" + escFormula(clientId) + "',{AuthClientId}='" + escFormula(session.currentAuthClientId) + "')",
      1
    );
    if (recs[0]) return recs[0];
  }

  // ...or the legacy ContactEmail match (un-migrated clients).
  const email = String(session.user.email).trim().toLowerCase();
  const byEmail = await fetchClients(
    atKey,
    "AND(RECORD_ID()='" + escFormula(clientId) + "',LOWER({ContactEmail})='" + escFormula(email) + "')",
    1
  );
  return byEmail[0] || null;
}

/**
 * Resolve a client record by ClientName (used by the UNAUTHENTICATED visitor
 * token path). Verifies the client exists; returns the record or null.
 * No entitlement check — the visitor capability is strictly limited by the
 * caller regardless.
 */
async function resolveClientByName(atKey, clientName) {
  const recs = await fetchClients(
    atKey,
    "LOWER({ClientName})='" + escFormula(String(clientName).toLowerCase()) + "'",
    1
  );
  return recs[0] || null;
}

module.exports = {
  validateSession,
  resolveEntitledClient,
  resolveClientByName,
  fetchClients,
  escFormula,
  AT_BASE,
  AT_TABLE
};
