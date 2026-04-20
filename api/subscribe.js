// Luna Subscribe API — pushes visitor email to client's email marketing platform

const ratelimit = require('../lib/ratelimit');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 5 subscribes/minute/IP — prevents spam signups and email-platform abuse
  var rlResult = await ratelimit.checkIpAndKey(req, {
    ipKey: 'subscribe',
    ipMax: 5,
    ipWindowSecs: 60
  });
  if (!rlResult.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  var body = req.body || {};
  var clientName = (body.clientName || '').trim();
  var email = (body.email || '').trim();
  var name = (body.name || '').trim();

  if (!clientName || !email) {
    return res.status(400).json({ error: 'Missing clientName or email' });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  try {
    // Look up client's email platform settings
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    var f = sData.records[0].fields || {};
    var platform = f.EmailPlatform;
    if (typeof platform === 'object') platform = platform.name;
    var apiKey = f.EmailPlatformApiKey || '';
    var listId = f.EmailPlatformListId || '';

    if (!platform || platform === 'none' || !apiKey) {
      return res.status(200).json({ ok: true, message: 'No email platform configured — subscriber not added' });
    }

    // Split name into first/last
    var parts = name.split(' ');
    var firstName = parts[0] || '';
    var lastName = parts.slice(1).join(' ') || '';

    if (platform === 'mailchimp') {
      // Mailchimp API v3
      // API key format: key-dc (e.g. abc123-us21)
      var dc = apiKey.split('-').pop() || 'us21';
      var mcUrl = 'https://' + dc + '.api.mailchimp.com/3.0/lists/' + listId + '/members';

      var mcRes = await fetch(mcUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email_address: email,
          status: 'subscribed',
          merge_fields: {
            FNAME: firstName,
            LNAME: lastName
          }
        })
      });

      if (mcRes.status === 200 || mcRes.status === 201) {
        return res.status(200).json({ ok: true, platform: 'mailchimp' });
      }
      // 400 = already subscribed, which is fine
      var mcData = await mcRes.json().catch(function() { return {}; });
      if (mcData.title === 'Member Exists') {
        return res.status(200).json({ ok: true, platform: 'mailchimp', message: 'Already subscribed' });
      }
      console.warn('Mailchimp error:', mcRes.status, mcData);
      return res.status(200).json({ ok: true, message: 'Mailchimp returned ' + mcRes.status });

    } else if (platform === 'mailerlite') {
      // Mailerlite API v2
      var mlUrl = 'https://connect.mailerlite.com/api/subscribers';
      var mlBody = {
        email: email,
        fields: { name: firstName, last_name: lastName }
      };
      if (listId) mlBody.groups = [listId];

      var mlRes = await fetch(mlUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mlBody)
      });

      if (mlRes.status === 200 || mlRes.status === 201) {
        return res.status(200).json({ ok: true, platform: 'mailerlite' });
      }
      var mlData = await mlRes.json().catch(function() { return {}; });
      console.warn('Mailerlite error:', mlRes.status, mlData);
      return res.status(200).json({ ok: true, message: 'Mailerlite returned ' + mlRes.status });
    }

    return res.status(200).json({ ok: true, message: 'Unknown platform: ' + platform });
  } catch (e) {
    console.warn('Subscribe error:', e.message);
    return res.status(500).json({ error: 'Subscribe failed' });
  }
};
