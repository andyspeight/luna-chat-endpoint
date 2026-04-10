// Luna Widget Config API
// Returns widget appearance settings for a client
// Called by the widget on load to get theme, welcome, hints etc.

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var clientName = (req.query.client || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Missing client parameter' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(200).json({});

  try {
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(200).json({});
    }

    var f = sData.records[0].fields || {};
    var config = {};

    if (f.WidgetTheme) config.theme = f.WidgetTheme;
    if (f.WidgetWelcome) config.welcome = f.WidgetWelcome;
    if (f.WidgetBotName) config.name = f.WidgetBotName;
    if (f.WidgetSize) config.size = f.WidgetSize;
    if (f.WidgetHints) {
      config.hints = f.WidgetHints.split('\n').filter(function(l) { return l.trim(); });
    }
    if (f.ClientName) config.clientName = f.ClientName;

    return res.status(200).json(config);
  } catch (e) {
    console.warn('Widget config fetch error:', e.message);
    return res.status(200).json({});
  }
};
