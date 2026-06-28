// api/backfill-search-index.js
// Keeps the Destinations and Transport tables findable.
//
// Both tables have a "Search Index" field that the widget searches as a single
// blob. A row whose index is empty (e.g. one added by hand) is invisible to Luna
// even though its facts are present. This job rebuilds that index deterministically
// from each row's OWN fields (no LLM, so it can never distort a fact), for any row
// where it is missing. It also reports field-level GAPS (rows missing key facts)
// so the owner can see coverage holes at a glance.
//
// Runs daily as a safety net, and is called inline by the admin add-destination /
// add-transport actions so a new row is searchable immediately.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=.
//   ?dryRun=1  report what WOULD change, write nothing.
//   ?all=1     rebuild every row's index, not just the empty ones.
//   ?gaps=1    include the field-gap report (also always included in dryRun).
//
// Env: CRON_SECRET, AIRTABLE_KEY.

'use strict';

const gk = require('../lib/global-knowledge');

// Key fields whose absence is a meaningful coverage gap, per table. Used only for
// the read-only gap report; never written here.
const DEST_KEY_FIELDS = ['Currency', 'Time Zone', 'Dialling Code', 'Emergency Number', 'Plug Type', 'Voltage', 'UK Visa Required', 'Tap Water Safe'];
const TRANSPORT_KEY_FIELDS = ['Code', 'Country', 'City', 'Info 1'];

async function atFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + gk.GLOBAL_BASE + path, {
    method: opts.method || 'GET', headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

async function loadAll(table, cap) {
  cap = cap || 5000;
  var items = [], offset = null, pages = 0;
  do {
    var path = '/' + table + '?pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) { items.push(r); });
    offset = data.offset || null; pages++;
  } while (offset && items.length < cap && pages < 60);
  return items;
}

// PATCH up to 10 records at a time (Airtable's batch limit).
async function patchBatched(table, updates, dryRun) {
  if (dryRun || !updates.length) return updates.length;
  for (var i = 0; i < updates.length; i += 10) {
    var slice = updates.slice(i, i + 10);
    await atFetch('/' + table, { method: 'PATCH', body: { records: slice, typecast: true } });
  }
  return updates.length;
}

// Build the per-table plan: which rows need their index (re)built, and the gap
// report. Returns { table, scanned, toFill, samplesFilled, gaps }.
async function planTable(table, buildIndex, keyFields, opts) {
  opts = opts || {};
  var rows = await loadAll(table);
  var updates = [], filledSamples = [];
  var gapCounts = {}; keyFields.forEach(function (k) { gapCounts[k] = 0; });
  var rowsWithAnyGap = 0;

  rows.forEach(function (rec) {
    var f = rec.fields || {};
    // Index (re)build.
    var current = f['Search Index'];
    if (opts.all || isBlank(current)) {
      var built = buildIndex(f);
      if (built && built !== current) {
        updates.push({ id: rec.id, fields: { 'Search Index': built } });
        if (filledSamples.length < 8) filledSamples.push(f['Name'] || rec.id);
      }
    }
    // Gap tally (read-only).
    var hadGap = false;
    keyFields.forEach(function (k) { if (isBlank(f[k])) { gapCounts[k]++; hadGap = true; } });
    if (hadGap) rowsWithAnyGap++;
  });

  return {
    table: table,
    scanned: rows.length,
    toFill: updates.length,
    samplesFilled: filledSamples,
    rowsWithAnyGap: rowsWithAnyGap,
    gaps: gapCounts,
    _updates: updates
  };
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Server not configured (AIRTABLE_KEY)' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var all = req.query && (req.query.all === '1' || req.query.all === 'true');

  try {
    var dest = await planTable(gk.DESTINATIONS_TABLE, gk.buildDestinationSearchIndex, DEST_KEY_FIELDS, { all: all });
    var trans = await planTable(gk.TRANSPORT_TABLE, gk.buildTransportSearchIndex, TRANSPORT_KEY_FIELDS, { all: all });

    var destFilled = await patchBatched(gk.DESTINATIONS_TABLE, dest._updates, dryRun);
    var transFilled = await patchBatched(gk.TRANSPORT_TABLE, trans._updates, dryRun);

    function strip(p) { var c = Object.assign({}, p); delete c._updates; return c; }

    return res.status(200).json({
      ok: true,
      dryRun: !!dryRun,
      mode: all ? 'rebuild-all' : 'fill-empty',
      destinations: Object.assign(strip(dest), { filled: destFilled }),
      transport: Object.assign(strip(trans), { filled: transFilled }),
      totalFilled: destFilled + transFilled
    });
  } catch (e) {
    console.error('[backfill-search-index] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
