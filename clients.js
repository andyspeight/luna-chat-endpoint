// Luna Client Management API
// Handles listing and creating clients via Airtable
// Airtable key stored securely as AIRTABLE_KEY env var

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'travelgenix2026';
const VERCEL_HOST = 'luna-chat-endpoint.vercel.app';

const FID = {
  name: 'fldT257oW3qssqUcZ',
  slug: 'fldSmneYA5MWTBnD1',
  ably: 'fldX9j7FbmoZ6LyD3',
  pass: 'fldzGhMat02ytWzxA',
  email: 'fld2ZN2JpYkSNppeZ',
  status: 'fldROhVFn237yDuKP',
  embed: 'fldI0jyNiwovCvanu',
  dashUrl: 'fld3VNDyNyQTXv6wR',
  created: 'fldyeeciN1NvzkEYB'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const adminPass = req.headers['x-admin-pass'] || '';
  if (adminPass !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    return res.status(500).json({ error: 'Airtable key not configured on server' });
  }

  const atHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };
  const atUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE;

  // GET = list clients
  if (req.method === 'GET') {
    try {
      const atRes = await fetch(atUrl + '?sort%5B0%5D%5Bfield%5D=' + FID.name + '&sort%5B0%5D%5Bdirection%5D=asc', {
        headers: atHeaders
      });
      if (!atRes.ok) throw new Error('Airtable error: ' + atRes.status);
      const data = await atRes.json();

      const clients = (data.records || []).map(function(r) {
        var f = r.fields || {};
        return {
          id: r.id,
          name: f[FID.name] || '',
          slug: f[FID.slug] || '',
          email: f[FID.email] || '',
          status: (f[FID.status] && f[FID.status].name) || f[FID.status] || 'Active',
          dashUrl: f[FID.dashUrl] || '',
          embed: f[FID.embed] || ''
        };
      });

      return res.status(200).json({ clients: clients });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST = create client
  if (req.method === 'POST') {
    const { name, slug, email, password, ablyKey } = req.body || {};

    if (!name || !slug || !email) {
      return res.status(400).json({ error: 'Missing required fields: name, slug, email' });
    }

    const ably = ablyKey || '';
    const pass = password || slug.replace(/-/g, '') + Math.floor(Math.random() * 9000 + 1000);
    const dashUrl = 'https://' + VERCEL_HOST + '/dashboard.html?client=' + encodeURIComponent(name) + '&ably=' + encodeURIComponent(ably) + '&pass=' + encodeURIComponent(pass);
    const embed = '<script src="https://' + VERCEL_HOST + '/widget-core.js" data-clientName="' + name.replace(/"/g, '&quot;') + '"' + (ably ? ' data-ablyKey="' + ably + '"' : '') + ' async></script>';

    try {
      const atRes = await fetch(atUrl, {
        method: 'POST',
        headers: atHeaders,
        body: JSON.stringify({
          records: [{ fields: {
            [FID.name]: name,
            [FID.slug]: slug,
            [FID.ably]: ably,
            [FID.pass]: pass,
            [FID.email]: email,
            [FID.status]: 'Active',
            [FID.embed]: embed,
            [FID.dashUrl]: dashUrl,
            [FID.created]: new Date().toISOString()
          }}],
          typecast: true
        })
      });

      if (!atRes.ok) {
        const errData = await atRes.json();
        throw new Error(errData.error?.message || 'Airtable create failed');
      }

      return res.status(200).json({
        success: true,
        client: { name, slug, email, dashUrl, embed, password: pass }
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
