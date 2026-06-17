// api/discover-scan.js
// Proactive discovery crawler — GLOBAL.
//
// Generic "things to do / what's on" data belongs in the shared knowledge base
// (base appPKx77relfeiqmq) that powers Luna and the widgets for every client,
// NOT per client. Two phases write Pending rows into the Suggested Knowledge
// staging table; nothing goes live until an admin approves it in the global
// review screen (api/global-brain), which promotes it into the live Knowledge
// table with a Search Index.
//
//   1. Curated URL scrape: reads the central Discovery Sources table and safely
//      scrapes each enabled page, extracting things-to-do via the LLM.
//   2. Global connectors: rotates through the WHOLE Destinations table (~230),
//      querying Ticketmaster (events) + Foursquare (things to do) for a batch of
//      the oldest-scanned destinations each run. Rotation is driven by the
//      "Last Discovered" dateTime field (oldest/blank first); each processed
//      destination is stamped so the next run picks up where this one left off.
//      At the default batch of 20/day a full sweep takes ~12 days and costs
//      ~600 Foursquare + ~600 Ticketmaster calls/month, well inside free tiers.
//
// Safety / cost posture:
//   - Cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 returns what WOULD
//     be staged without writing (and does not stamp Last Discovered). SSRF-
//     hardened fetch via lib/safe-scrape.
//   - Extraction-only prompting + dedup via lib/discover. Hard caps per run.
//   - Connector fetches run with bounded concurrency to stay under the 60s cron.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY.
// Optional: DISCOVER_MODEL, TICKETMASTER_API_KEY, TELEGRAM_BOT_TOKEN/CHAT_ID.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const scrape = require('../lib/safe-scrape');
const discover = require('../lib/discover');
const ticketmaster = require('../lib/ticketmaster');
const foursquare = require('../lib/foursquare');
const gk = require('../lib/global-knowledge');

const MODEL = process.env.DISCOVER_MODEL || 'claude-haiku-4-5-20251001';

const MAX_SOURCES = 20;        // URL pages scanned per run (curated phase)
const MAX_NEW_TOTAL = 60;      // total suggestions staged per run
const MAX_PER_SOURCE = 6;
// Connector phase: how many global destinations to rotate through per run, and
// how many connector fetches to run at once (keeps wall-time under the 60s cron).
const BATCH = parseInt(process.env.DISCOVER_BATCH || '20', 10);
const CONCURRENCY = parseInt(process.env.DISCOVER_CONCURRENCY || '6', 10);

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

function valueOf(field) { return (field && typeof field === 'object' && field.name) ? field.name : (field || ''); }

// Central, enabled discovery sources.
async function loadSources() {
  var data = await atFetch('/' + gk.DISCOVERY_SOURCES_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Enabled}=TRUE()")
    + '&maxRecords=' + MAX_SOURCES);
  // Keep every enabled row (even url-less ones) so its Destination still feeds
  // the API connectors; the scrape phase decides per row whether to fetch.
  return (data.records || []).map(function (rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      name: f['Name'] || '',
      url: f['URL'] || '',
      destination: f['Destination'] || '',
      categoryHint: valueOf(f['Category Hint']) || 'Things To Do',
      skipScrape: !!f['Skip Scrape']
    };
  });
}

// Existing questions to dedup against: live global Knowledge + pending suggestions.
async function loadExistingQuestions() {
  var qs = [];
  var k = await atFetch('/' + gk.KNOWLEDGE_TABLE + '?fields%5B%5D=Question&maxRecords=1000');
  (k.records || []).forEach(function (r) { if (r.fields && r.fields.Question) qs.push(r.fields.Question); });
  var s = await atFetch('/' + gk.SUGGESTED_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Status}='Pending'") + '&fields%5B%5D=Question&maxRecords=500');
  (s.records || []).forEach(function (r) { if (r.fields && r.fields.Question) qs.push(r.fields.Question); });
  return qs;
}

function mapDest(rec) {
  var f = rec.fields || {};
  return { id: rec.id, name: f['Name'] || '', country: f['Country'] || '', type: valueOf(f['Type']) || '' };
}

// The rotating batch of global destinations to run the connectors over this run.
// Never-scanned rows (blank Last Discovered) come first, then the oldest-scanned,
// so every destination is reached before any is repeated.
async function loadDestinationBatch(limit) {
  var fields = '&fields%5B%5D=Name&fields%5B%5D=Country&fields%5B%5D=Type';
  var out = [];
  var blanks = await atFetch('/' + gk.DESTINATIONS_TABLE
    + '?filterByFormula=' + encodeURIComponent('{Last Discovered}=BLANK()')
    + fields + '&maxRecords=' + limit);
  (blanks.records || []).forEach(function (r) { out.push(mapDest(r)); });
  if (out.length < limit) {
    var rest = await atFetch('/' + gk.DESTINATIONS_TABLE
      + '?filterByFormula=' + encodeURIComponent('NOT({Last Discovered}=BLANK())')
      + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Discovered') + '&sort%5B0%5D%5Bdirection%5D=asc'
      + fields + '&maxRecords=' + (limit - out.length));
    (rest.records || []).forEach(function (r) { out.push(mapDest(r)); });
  }
  return out;
}

// Stamp Last Discovered=now on processed destinations so they rotate to the back
// of the queue. Batched 10 per Airtable PATCH. Only called outside dry runs.
async function stampDiscovered(ids, nowIso) {
  for (var i = 0; i < ids.length; i += 10) {
    var recs = ids.slice(i, i + 10).map(function (id) { return { id: id, fields: { 'Last Discovered': nowIso } }; });
    await atFetch('/' + gk.DESTINATIONS_TABLE, { method: 'PATCH', body: { records: recs, typecast: true } });
  }
}

// Run an async fn over items with bounded concurrency. Per-item errors are
// captured (one failure never aborts the batch) and returned in place. Mirrors
// the helper in api/reverify.js so connector fetches stay under the 60s cron.
async function mapLimit(items, limit, fn) {
  var out = new Array(items.length);
  var idx = 0;
  async function worker() {
    while (idx < items.length) {
      var i = idx++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { __error: (e && e.message) || 'error' }; }
    }
  }
  var workers = [];
  var n = Math.min(limit, items.length);
  for (var w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function capConfidence(c) { return c === 'high' ? 'High' : (c === 'low' ? 'Low' : 'Medium'); }

// Convert dedup'd candidates into Suggested Knowledge rows and create them.
async function stageCandidates(candidates, opts) {
  opts = opts || {};
  var nowIso = new Date().toISOString();
  var records = candidates.map(function (c) {
    return { fields: {
      'Question': c.question,
      'Consumer Answer': c.answer,
      'Category': opts.category || 'Things To Do',
      'Related To': opts.destination || '',
      'Source': c.sourceUrl || opts.sourceUrl || '',
      'Confidence': capConfidence(c.confidence),
      'Status': 'Pending',
      'Origin': opts.origin || 'Discovery Crawl',
      'Suggested At': nowIso,
      'Notes': opts.notes || ''
    } };
  });
  for (var i = 0; i < records.length; i += 10) {
    await atFetch('/' + gk.SUGGESTED_TABLE, { method: 'POST', body: { records: records.slice(i, i + 10), typecast: true } });
  }
}

async function extractFromPage(anthropic, pageText, opts) {
  var prompt = discover.buildExtractionPrompt(pageText, opts);
  var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 900, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
  var text = '';
  if (resp && resp.content) { for (var i = 0; i < resp.content.length; i++) { if (resp.content[i].type === 'text') text += resp.content[i].text; } }
  return discover.processCandidates(text, opts);
}

async function tgSend(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000)
    });
  } catch (e) { /* best effort */ }
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.AIRTABLE_KEY || !process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    var sources = await loadSources();
    var existing = await loadExistingQuestions();
    var staged = [];        // questions staged this run (for cross-source dedup)
    var report = [];

    // 1) URL sources -> extract things to do
    for (var si = 0; si < sources.length && staged.length < MAX_NEW_TOTAL; si++) {
      var src = sources[si];
      // Skip rows with no URL or flagged Skip Scrape (e.g. bot-blocked sites).
      // Their Destination is still used by the connectors below.
      if (!src.url || src.skipScrape) continue;
      var scraped = await scrape.scrapeUrl(src.url, { timeoutMs: 12000, maxHops: 3 });
      if (!scraped.ok) { report.push({ source: src.name, url: src.url, error: scraped.error }); continue; }
      var found;
      try {
        found = await extractFromPage(anthropic, scraped.content, {
          sourceUrl: scraped.url, destination: src.destination, existingQuestions: existing.concat(staged)
        });
      } catch (e) { report.push({ source: src.name, url: src.url, error: 'extract_failed: ' + e.message }); continue; }
      found = found.slice(0, MAX_PER_SOURCE);
      if (!dryRun && found.length) await stageCandidates(found, { category: src.categoryHint, destination: src.destination, origin: 'Discovery Crawl' });
      if (!dryRun && found.length) { try { await atFetch('/' + gk.DISCOVERY_SOURCES_TABLE + '/' + src.id, { method: 'PATCH', body: { fields: { 'Last Scanned': new Date().toISOString() } } }); } catch (e) {} }
      found.forEach(function (c) { staged.push(c.question); });
      report.push({ source: src.name, url: scraped.url, staged: found.length, titles: found.map(function (c) { return c.question; }) });
    }

    // 2) Global connectors: rotate through the Destinations table (oldest-first
    //    by Last Discovered), querying Ticketmaster + Foursquare for each. Fetch
    //    concurrently to fit the 60s cron, then process sequentially so the dedup
    //    accumulator stays deterministic. Drafts are built deterministically in
    //    the libs (no LLM here), so this phase makes no model calls.
    var tmKey = process.env.TICKETMASTER_API_KEY;
    var fsqKey = process.env.FOURSQUARE_API_KEY;
    if (!tmKey) report.push({ source: 'ticketmaster', error: 'no_key (TICKETMASTER_API_KEY not set on this deployment)' });
    if (!fsqKey) report.push({ source: 'foursquare', error: 'no_key (FOURSQUARE_API_KEY not set on this deployment)' });

    var batch = (tmKey || fsqKey) ? await loadDestinationBatch(BATCH) : [];
    if (batch.length) {
      var fetched = await mapLimit(batch, CONCURRENCY, async function (d) {
        var r = { dest: d };
        if (tmKey) r.tm = await ticketmaster.fetchEvents(d.name, { max: 5, country: d.country });
        if (fsqKey) r.fsq = await foursquare.fetchPlaces(d.name, { max: 8, country: d.country });
        return r;
      });

      for (var bi = 0; bi < fetched.length; bi++) {
        var item = fetched[bi];
        if (!item || item.__error || !item.dest) continue;
        var d = item.dest;
        // Ticketmaster events
        if (item.tm) {
          if (!item.tm.ok) { report.push({ source: 'ticketmaster', destination: d.name, error: item.tm.error, httpStatus: item.tm.httpStatus }); }
          else if (!item.tm.draft) { report.push({ source: 'ticketmaster', destination: d.name, events: item.tm.count, staged: 0 }); }
          else {
            var pe = (staged.length < MAX_NEW_TOTAL)
              ? discover.processCandidates(JSON.stringify([item.tm.draft]), { existingQuestions: existing.concat(staged), destination: d.name, sourceUrl: 'https://www.ticketmaster.com' })
              : [];
            if (!dryRun && pe.length) await stageCandidates(pe, { category: 'Events', destination: d.name, origin: 'Ticketmaster' });
            pe.forEach(function (c) { staged.push(c.question); });
            report.push({ source: 'ticketmaster', destination: d.name, events: item.tm.count, staged: pe.length });
          }
        }
        // Foursquare things to do
        if (item.fsq) {
          if (!item.fsq.ok) { report.push({ source: 'foursquare', destination: d.name, error: item.fsq.error, httpStatus: item.fsq.httpStatus, via: item.fsq.via, near: item.fsq.near }); }
          else if (!item.fsq.draft) { report.push({ source: 'foursquare', destination: d.name, places: item.fsq.count, staged: 0, via: item.fsq.via, near: item.fsq.near }); }
          else {
            var pf = (staged.length < MAX_NEW_TOTAL)
              ? discover.processCandidates(JSON.stringify([item.fsq.draft]), { existingQuestions: existing.concat(staged), destination: d.name, sourceUrl: 'https://foursquare.com' })
              : [];
            if (!dryRun && pf.length) await stageCandidates(pf, { category: 'Things To Do', destination: d.name, origin: 'Foursquare' });
            pf.forEach(function (c) { staged.push(c.question); });
            report.push({ source: 'foursquare', destination: d.name, places: item.fsq.count, staged: pf.length, via: item.fsq.via, near: item.fsq.near });
          }
        }
      }

      // Rotate: stamp every visited destination so the next run advances through
      // the table (even ones that errored or yielded nothing, so none can block).
      if (!dryRun) {
        try { await stampDiscovered(batch.map(function (b) { return b.id; }), new Date().toISOString()); }
        catch (e) { report.push({ source: 'rotation', error: 'stamp_failed: ' + e.message }); }
      }
    }

    if (!dryRun && staged.length > 0) {
      await tgSend('Luna discovery: ' + staged.length + ' new suggestion(s) staged for review. Approve in the global review screen.');
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, sources: sources.length, destinationsScanned: batch.length, totalStaged: staged.length, report: report, checkedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[discover-scan] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
