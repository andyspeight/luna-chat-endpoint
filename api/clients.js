// Luna Client Management API
// Handles listing and creating clients via Airtable

const crypto = require('crypto');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'travelgenix2026';
const VERCEL_HOST = 'luna-chat-endpoint.vercel.app';

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
    // Cryptographically secure password generation — 4 random bytes → 8 hex chars
    var generatedSuffix = crypto.randomBytes(4).toString('hex');
    var pass = (body.password || slug.replace(/-/g, '') + generatedSuffix).trim();

    if (!name || !slug || !email) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, email' });
    }

    var dashUrl = 'https://' + VERCEL_HOST + '/dashboard.html?client=' + encodeURIComponent(name) + '&ably=' + encodeURIComponent(ably) + '&pass=' + encodeURIComponent(pass);
    var embed = '<script src="https://' + VERCEL_HOST + '/widget-core.js" data-clientName="' + name.replace(/"/g, '&quot;') + '"' + (ably ? ' data-ablyKey="' + ably + '"' : '') + ' async><\/script>';

    try {
      var atRes = await fetch(atUrl, {
        method: 'POST',
        headers: atHeaders,
        body: JSON.stringify({
          records: [{ fields: {
            ClientName: name,
            ClientSlug: slug,
            AblyKey: ably,
            DashboardPassword: pass,
            ContactEmail: email,
            Status: 'Active',
            WidgetEmbed: embed,
            DashboardURL: dashUrl,
            DeepLinkSiteID: siteId,
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
        client: { name: name, slug: slug, email: email, dashUrl: dashUrl, embed: embed, password: pass }
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
