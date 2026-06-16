// api/refresh-fcdo.js
// Authoritative-field auto-refresh: keep the FCDO Status on every global
// destination current, straight from the FCDO feed. No model is involved, so
// there is nothing to invent: the value is the official status, verbatim.
//
// It updates ONLY the FCDO Status field and deliberately does NOT touch the
// record-level Last Verified (that represents a full re-check of the whole
// record, which this is not).
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports the
// values it would write without writing.
//
// Env: CRON_SECRET, AIRTABLE_KEY. (FCDO feed needs no key.)

'use strict';

const fcdo = require('../lib/fcdo');
const gk = require('../lib/global-knowledge');

const DESTINATIONS_TABLE = 'tblirr0vJuQcTLuH2';

async function atFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + gk.GLOBAL_BASE + path, {
    method: opts.method || 'GET', headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

// Concise, official, dated status string for the field.
function fcdoStatusString(advice) {
  var phrase = (advice.hasWarning && advice.statusLines && advice.statusLines[0])
    ? advice.statusLines[0]
    : 'No FCDO warning against travel here.';
  var date = advice.lastUpdated ? new Date(advice.lastUpdated) : null;
  var dateStr = (date && !isNaN(date.getTime())) ? (' (FCDO, updated ' + date.toISOString().split('T')[0] + ')') : ' (FCDO)';
  return (phrase + dateStr).slice(0, 250);
}

// Load all destinations with their Country, paging through Airtable.
async function loadDestinations() {
  var items = [], offset = null, pages = 0;
  do {
    var path = '/' + DESTINATIONS_TABLE + '?fields%5B%5D=Name&fields%5B%5D=Country&fields%5B%5D=FCDO Status&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (rec) {
      var f = rec.fields || {};
      items.push({ id: rec.id, name: f.Name || '', country: f.Country || '', current: f['FCDO Status'] || '' });
    });
    offset = data.offset || null; pages++;
  } while (offset && pages < 20);
  return items;
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'AIRTABLE_KEY not configured' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    var dests = await loadDestinations();

    // Resolve FCDO status once per unique country.
    var byCountry = {};
    dests.forEach(function (d) { if (d.country) byCountry[d.country] = null; });
    var countries = Object.keys(byCountry);
    var resolved = 0, notFound = 0, errored = 0;
    for (var i = 0; i < countries.length; i++) {
      var advice = await fcdo.getAdvice(countries[i]);
      if (advice && !advice.error && !advice.notFound) { byCountry[countries[i]] = fcdoStatusString(advice); resolved++; }
      else if (advice && advice.notFound) { notFound++; }
      else { errored++; }
    }

    // Build updates for records whose value would change.
    var updates = [];
    dests.forEach(function (d) {
      var val = d.country ? byCountry[d.country] : null;
      if (val && val !== d.current) updates.push({ id: d.id, fields: { 'FCDO Status': val } });
    });

    if (!dryRun) {
      for (var j = 0; j < updates.length; j += 10) {
        await atFetch('/' + DESTINATIONS_TABLE, { method: 'PATCH', body: { records: updates.slice(j, j + 10), typecast: true } });
      }
    }

    return res.status(200).json({
      ok: true, dryRun: !!dryRun,
      destinations: dests.length, countries: countries.length,
      countriesResolved: resolved, countriesNotFound: notFound, countriesErrored: errored,
      recordsUpdated: dryRun ? 0 : updates.length, recordsWouldUpdate: updates.length,
      sample: updates.slice(0, 8).map(function (u) { return u.fields['FCDO Status']; }),
      checkedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[refresh-fcdo] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
