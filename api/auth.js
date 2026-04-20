// Luna Dashboard Auth API
// Client logs in with name + password, gets their config back

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

// CORS allowlist — only our own Vercel deploy can call the authenticated routes.
// Add custom client domains here if/when they start using them.
const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var body = req.body || {};
  var clientName = (body.clientName || '').trim();
  var password = (body.password || '').trim();

  if (!clientName || !password) {
    return res.status(400).json({ error: 'Please enter your company name and password' });
  }

  try {
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(401).json({ error: 'Company not found. Please check the name and try again.' });
    }

    var record = sData.records[0];
    var fields = record.fields || {};

    if (fields.DashboardPassword !== password) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    // Return config (never send the password back)
    return res.status(200).json({
      success: true,
      config: {
        clientName: fields.ClientName || '',
        clientSlug: fields.ClientSlug || '',
        ablyKey: fields.AblyKey || '',
        email: fields.ContactEmail || ''
      }
    });

  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
