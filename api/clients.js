// Luna Client Management API
// Handles listing and creating clients via Airtable

const crypto = require('crypto');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

// TWO credentials open this endpoint, because it has two genuinely different
// callers, and they should not share a secret:
//
//   ADMIN_PASSWORD       a human typing it into /onboard.html
//   LUNA_PROVISION_PASS  Client Control, machine to machine, holding the same
//                        value in its own LUNA_CHAT_ADMIN_PASS variable
//
// They used to be the same value, which meant the secret stored in a SECOND
// Vercel project (tg-widgets) also unlocked /api/global-brain — the shared
// knowledge base that feeds every client. Provisioning a client and editing
// global knowledge are not the same privilege, so they no longer share a key:
// global-brain accepts ADMIN_PASSWORD only.
//
// Set LUNA_PROVISION_PASS to a NEW random value and put the same value in
// tg-widgets' LUNA_CHAT_ADMIN_PASS. Until that is done, Client Control keeps
// working on ADMIN_PASSWORD and nothing breaks — the split just isn't earning
// anything yet, which is why the handler logs a reminder.
//
// No hardcoded fallback. With neither configured, admin auth fails closed
// (see the handler) rather than accepting a checked-in default.
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const PROVISION_PASS = process.env.LUNA_PROVISION_PASS || '';
// The dashboard MUST be served from a travelify.io host: the central login cookie
// (tg_session) is scoped to travelify.io, so on *.vercel.app the dashboard cannot
// even sign in. Minting .vercel.app links handed every new client an unusable URL.
const DASHBOARD_HOST = 'chat.travelify.io';

// Every search type a client can offer. New clients get all of them — see the
// note where this is used. Kept as one list so the default cannot drift.
const DEFAULT_SEARCH_TYPES = ['Packages', 'Flights', 'Accommodation', 'DynamicPackaging'];

// CORS allowlist — only our own Vercel deploy can call the authenticated routes.
// Add custom client domains here if/when they start using them.
const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pass');
}

// Timing-safe string comparison — prevents timing attacks on password comparison.
// Returns false immediately for wrong-length inputs (safe: length is not secret).
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Fail closed when neither secret is configured — never accept a request
  // against an empty/absent secret. safeCompare already rejects '' on the
  // length check, but being explicit keeps the 503 distinct from a 401 so a
  // missing env var is diagnosable rather than looking like a wrong password.
  if (!ADMIN_PASS && !PROVISION_PASS) {
    console.error('[clients] neither ADMIN_PASSWORD nor LUNA_PROVISION_PASS configured'
      + ' — refusing admin request');
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  var supplied = req.headers['x-admin-pass'] || '';
  // Both compared every time, never short-circuited, so which secret was sent
  // is not observable through response timing.
  var viaAdmin = !!ADMIN_PASS && safeCompare(supplied, ADMIN_PASS);
  var viaProvision = !!PROVISION_PASS && safeCompare(supplied, PROVISION_PASS);
  if (!viaAdmin && !viaProvision) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!PROVISION_PASS) {
    console.warn('[clients] LUNA_PROVISION_PASS is not set, so Client Control is still'
      + ' using ADMIN_PASSWORD — the same secret that opens /api/global-brain.'
      + ' Set it to a new value here and in tg-widgets LUNA_CHAT_ADMIN_PASS.');
  }

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    return res.status(500).json({ error: 'Airtable key not configured on server' });
  }

  var atHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };
  var atUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE;

  if (req.method === 'GET') {
    try {
      var atRes = await fetch(atUrl + '?sort%5B0%5D%5Bfield%5D=ClientName&sort%5B0%5D%5Bdirection%5D=asc', {
        headers: atHeaders
      });
      if (!atRes.ok) throw new Error('Airtable error: ' + atRes.status);
      var data = await atRes.json();

      var clients = (data.records || []).map(function(r) {
        var f = r.fields || {};
        return {
          id: r.id,
          name: f.ClientName || '',
          slug: f.ClientSlug || '',
          email: f.ContactEmail || '',
          status: typeof f.Status === 'object' ? (f.Status && f.Status.name || 'Active') : (f.Status || 'Active'),
          dashUrl: f.DashboardURL || '',
          embed: f.WidgetEmbed || ''
        };
      });

      return res.status(200).json({ clients: clients });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    // PROVISIONING — called by Client Control when Luna Chat is switched on or
    // off for a client, and whenever their details change.
    //
    // Client Control is where client access is granted, so it has to be able to
    // do this without a human copying anything across. Every problem we have had
    // this week came from that copy step: a client live in Client Control with no
    // Luna record at all, a client with no App ID so Luna invented 404 search
    // links, and a client locked out of their dashboard because AuthClientId was
    // never filled in.
    //
    // UPSERT, keyed on externalId — the client's id in Client Control, which
    // never changes. Not on the name:
    //   - flipping the toggle twice must update one record, not create a second.
    //     Two records with the same ClientName would make client lookups
    //     non-deterministic, since they take the first match.
    //   - a rename must move the existing client, not orphan them and start a
    //     blank one.
    var body = req.body || {};
    var externalId = (body.externalId || '').trim();
    var name = (body.name || '').trim();
    var email = (body.email || '').trim();
    var slug = (body.slug || '').trim();
    var ably = (body.ablyKey || '').trim();
    // Client Control calls it the App ID; Luna stores it as DeepLinkSiteID. They
    // are the same number.
    var siteId = String(body.appId || body.siteId || '').trim();
    // The auth-platform client record id. WITHOUT THIS the client cannot sign in
    // except by an exact ContactEmail match, which is how Jamie Wake Travel ended
    // up staring at "No Luna Chat client linked to your account".
    var authClientId = (body.authClientId || '').trim();
    var active = body.active === undefined ? true : !!body.active;

    if (!name || !email) {
      return res.status(400).json({ error: 'Missing required fields: name, email' });
    }
    // Derive a slug rather than demanding one — Client Control has no concept of it.
    if (!slug) {
      slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    var dashUrl = 'https://' + DASHBOARD_HOST + '/dashboard.html?client=' + encodeURIComponent(name);
    var embed = '<script src="https://' + DASHBOARD_HOST + '/widget-core.js" data-clientName="' + name.replace(/"/g, '&quot;') + '"' + (ably ? ' data-ablyKey="' + ably + '"' : '') + ' async><\/script>';

    try {
      // Find an existing record for this Client Control client.
      var existing = null;
      if (externalId) {
        var findUrl = atUrl + '?maxRecords=1&filterByFormula='
          + encodeURIComponent("{ExternalClientId}='" + externalId.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
        var findRes = await fetch(findUrl, { headers: atHeaders });
        if (!findRes.ok) throw new Error('Airtable lookup failed: ' + findRes.status);
        var findData = await findRes.json();
        existing = (findData.records || [])[0] || null;
      }

      var fields = {
        ClientName: name,
        ClientSlug: slug,
        ContactEmail: email,
        Status: active ? 'Active' : 'Inactive',
        WidgetEmbed: embed,
        DashboardURL: dashUrl
      };
      if (externalId) fields.ExternalClientId = externalId;
      // Only overwrite these when Client Control actually sent them, so a partial
      // update cannot blank out a value someone set by hand in the dashboard.
      if (siteId) fields.DeepLinkSiteID = siteId;
      if (authClientId) fields.AuthClientId = authClientId;
      if (ably) fields.AblyKey = ably;

      var result, action;
      if (existing) {
        // A rename from Client Control must not break the widget already embedded
        // on the client's website — it still identifies itself by the OLD name.
        // Carry the old name over automatically so their chat keeps working until
        // the site is re-embedded.
        var prevName = (existing.fields || {}).ClientName || '';
        if (prevName && prevName !== name) {
          fields.LegacyClientName = prevName;
        }
        var upRes = await fetch(atUrl, {
          method: 'PATCH',
          headers: atHeaders,
          body: JSON.stringify({ records: [{ id: existing.id, fields: fields }], typecast: true })
        });
        if (!upRes.ok) {
          var upErr = await upRes.json().catch(function () { return {}; });
          throw new Error((upErr.error && upErr.error.message) || 'Airtable update failed');
        }
        result = await upRes.json();
        action = 'updated';
      } else {
        // Enable every search type on a NEW client only. Never reset them on an
        // update — the client may have deliberately narrowed them in Settings.
        //
        // This was never set at provisioning, so every new client started with
        // none, holiday search silently did nothing, and with no search rules in
        // her prompt Luna invented search URLs on the client's own domain that
        // all 404'd (see #67).
        fields.SearchTypes = DEFAULT_SEARCH_TYPES;
        fields.AblyKey = ably;
        fields.CreatedAt = new Date().toISOString();
        var crRes = await fetch(atUrl, {
          method: 'POST',
          headers: atHeaders,
          body: JSON.stringify({ records: [{ fields: fields }], typecast: true })
        });
        if (!crRes.ok) {
          var crErr = await crRes.json().catch(function () { return {}; });
          throw new Error((crErr.error && crErr.error.message) || 'Airtable create failed');
        }
        result = await crRes.json();
        action = 'created';
      }

      var rec = (result.records || [])[0] || {};
      console.log('[clients] ' + action + ' "' + name + '"'
        + ' externalId=' + (externalId || '(none)')
        + ' appId=' + (siteId || '(none)')
        + ' authClientId=' + (authClientId || '(none)')
        + ' active=' + active
        + (fields.LegacyClientName ? ' renamedFrom="' + fields.LegacyClientName + '"' : ''));

      return res.status(200).json({
        success: true,
        action: action,
        client: {
          id: rec.id || (existing && existing.id) || null,
          externalId: externalId || null,
          name: name,
          slug: slug,
          email: email,
          active: active,
          dashUrl: dashUrl,
          embed: embed
        }
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
