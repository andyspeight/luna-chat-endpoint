// Luna Client Management API
// Handles listing and creating clients via Airtable

const crypto = require('crypto');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
// No hardcoded fallback. If ADMIN_PASSWORD is not configured, admin auth fails
// closed (see the handler) rather than accepting a checked-in default.
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
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

  // Fail closed when the admin password is not configured — never accept a
  // request against an empty/absent secret.
  if (!ADMIN_PASS) {
    console.error('[clients] ADMIN_PASSWORD not configured — refusing admin request');
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  var adminPass = req.headers['x-admin-pass'] || '';
  if (!safeCompare(adminPass, ADMIN_PASS)) {
    return res.status(401).json({ error: 'Unauthorized' });
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
    var body = req.body || {};
    var name = (body.name || '').trim();
    var slug = (body.slug || '').trim();
    var email = (body.email || '').trim();
    var ably = (body.ablyKey || '').trim();
    var siteId = (body.siteId || '').trim();
    // No DashboardPassword is generated any more. Dashboards authenticate via the
    // central login (tg-auth-gate), not a per-client password. Minting one left a
    // dead secret on every new client that the profile API then (wrongly) required,
    // producing "Save failed: 401". See api/profile.js.

    if (!name || !slug || !email) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, email' });
    }

    var dashUrl = 'https://' + DASHBOARD_HOST + '/dashboard.html?client=' + encodeURIComponent(name);
    var embed = '<script src="https://' + DASHBOARD_HOST + '/widget-core.js" data-clientName="' + name.replace(/"/g, '&quot;') + '"' + (ably ? ' data-ablyKey="' + ably + '"' : '') + ' async><\/script>';

    try {
      var atRes = await fetch(atUrl, {
        method: 'POST',
        headers: atHeaders,
        body: JSON.stringify({
          records: [{ fields: {
            ClientName: name,
            ClientSlug: slug,
            AblyKey: ably,
            ContactEmail: email,
            Status: 'Active',
            WidgetEmbed: embed,
            DashboardURL: dashUrl,
            DeepLinkSiteID: siteId,
            // Enable every search type by default.
            //
            // This was never set at provisioning, so every new client started
            // with none — and holiday search silently did nothing until someone
            // remembered to tick the boxes in Settings. Worse, with no search
            // rules in her prompt Luna invented plausible search URLs on the
            // client's own domain, and every one was a 404 (see #67).
            //
            // There is no reason to start a travel client with search switched
            // off. They can narrow it in Settings > Holiday Search Types if they
            // only sell some of these.
            SearchTypes: DEFAULT_SEARCH_TYPES,
            CreatedAt: new Date().toISOString()
          }}],
          typecast: true
        })
      });

      if (!atRes.ok) {
        var errData = await atRes.json();
        throw new Error(errData.error?.message || 'Airtable create failed');
      }

      return res.status(200).json({
        success: true,
        client: { name: name, slug: slug, email: email, dashUrl: dashUrl, embed: embed }
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
