// Luna Client Profile API
// Read and write business profile data

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Slug, X-Client-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var slug = req.headers['x-client-slug'] || req.query.slug || '';
  var clientName = req.headers['x-client-name'] || req.query.name || '';
  var pass = req.headers['x-client-pass'] || req.query.pass || '';

  if ((!slug && !clientName) || !pass) return res.status(400).json({ error: 'Missing client credentials' });

  var atHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };

  // Find client by slug or name and verify password
  try {
    var filterField = slug ? 'ClientSlug' : 'ClientName';
    var filterValue = slug || clientName;
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("{" + filterField + "}='" + filterValue.replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: atHeaders });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    var record = sData.records[0];
    var fields = record.fields || {};

    // Verify password
    if (fields.DashboardPassword !== pass) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // GET = read profile
    if (req.method === 'GET') {
      return res.status(200).json({
        profile: {
          clientName: fields.ClientName || '',
          email: fields.ContactEmail || '',
          address: fields.BusinessAddress || '',
          phone: fields.BusinessPhone || '',
          website: fields.BusinessWebsite || '',
          hours: fields.OpeningHours || '',
          specialisms: fields.Specialisms || '',
          destinations: fields.Destinations || '',
          bonding: fields.BondingInfo || '',
          description: fields.BusinessDescription || '',
          customQA: fields.CustomQA || ''
        }
      });
    }

    // POST = update profile
    if (req.method === 'POST') {
      var body = req.body || {};
      var updateFields = {};

      // Only update fields that are provided
      if (body.address !== undefined) updateFields.BusinessAddress = body.address;
      if (body.phone !== undefined) updateFields.BusinessPhone = body.phone;
      if (body.website !== undefined) updateFields.BusinessWebsite = body.website;
      if (body.hours !== undefined) updateFields.OpeningHours = body.hours;
      if (body.specialisms !== undefined) updateFields.Specialisms = body.specialisms;
      if (body.destinations !== undefined) updateFields.Destinations = body.destinations;
      if (body.bonding !== undefined) updateFields.BondingInfo = body.bonding;
      if (body.description !== undefined) updateFields.BusinessDescription = body.description;
      if (body.customQA !== undefined) updateFields.CustomQA = body.customQA;

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      var updateUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE + '/' + record.id;
      var uRes = await fetch(updateUrl, {
        method: 'PATCH',
        headers: atHeaders,
        body: JSON.stringify({ fields: updateFields })
      });

      if (!uRes.ok) {
        var errData = await uRes.json();
        throw new Error(errData.error?.message || 'Update failed');
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
