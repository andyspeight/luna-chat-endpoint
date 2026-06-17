// api/discover-scan.js
// Proactive discovery crawler — GLOBAL.
//
// Generic "things to do / what's on" data belongs in the shared knowledge base
// (base appPKx77relfeiqmq) that powers Luna and the widgets for every client,
// NOT per client. Three phases run each invocation:
//
//   1. Curated URL scrape: reads the central Discovery Sources table and safely
//      scrapes each enabled page, extracting things-to-do via the LLM. Because a
//      model does the extraction, these stay HUMAN-GATED: they land Pending in
//      Suggested Knowledge for review in api/global-brain.
//   2. Global connectors: rotates through the WHOLE Destinations table (~230),
//      querying Ticketmaster (events) + Foursquare (things to do) for a batch of
//      the oldest-scanned destinations each run (driven by the "Last Discovered"
//      dateTime field, oldest/blank first). These drafts are built by code
//      straight from a trusted API with NO LLM, so they are TRUSTED-SOURCE-GATED
//      and auto-published into live Knowledge: create when absent, refresh the
//      connector's own row each rotation (keeps events current), skip when a
//      human/other-source row already owns that question (never clobber). A
//      connector-owned events row whose events have dried up is removed.
//   3. Backlog sweep: promotes any pre-existing Pending suggestions whose Origin
//      is a trusted connector (Foursquare/Ticketmaster) into live Knowledge too,
//      so the policy applies retroactively and clears the review queue.
//
// Pacing: the cron runs every 3h and processes DISCOVER_BATCH destinations/run
// (default 25 -> 200/day), so a full sweep of ~230 takes ~1.2 days and then each
// destination refreshes on a rolling basis. The per-run cost is bounded by
// frequency x batch regardless of table size (~6k Foursquare + ~6k Ticketmaster
// calls/month at the defaults, inside the free tiers), so adding more
// destinations just lengthens the refresh cycle, it does not raise the bill.
//
// Zero-hallucination posture is preserved: only deterministic, code-built drafts
// auto-publish; anything a model touched (the curated scrape) still needs a human.
//
// Safety / cost posture:
//   - Cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports what WOULD
//     happen and writes NOTHING (no publish, no stamp, no staging). SSRF-hardened
//     fetch via lib/safe-scrape.
//   - Connector fetches run with bounded concurrency; writes are batched; hard
//     per-run caps keep wall-time under the 60s cron.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY.
// Optional: DISCOVER_MODEL, DISCOVER_BATCH, DISCOVER_CONCURRENCY, DISCOVER_SWEEP,
//   TICKETMASTER_API_KEY, FOURSQUARE_API_KEY, TELEGRAM_BOT_TOKEN/CHAT_ID.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const scrape = require('../lib/safe-scrape');
const discover = require('../lib/discover');
const ticketmaster = require('../lib/ticketmaster');
const foursquare = require('../lib/foursquare');
const gk = require('../lib/global-knowledge');

const MODEL = process.env.DISCOVER_MODEL || 'claude-haiku-4-5-20251001';

const MAX_SOURCES = 20;        // URL pages scanned per run (curated phase)
const MAX_NEW_TOTAL = 60;      // total scrape suggestions staged per run
const MAX_PER_SOURCE = 6;
// Connector phase: how many global destinations to rotate through per run, and
// how many connector fetches to run at once (keeps wall-time under the 60s cron).
const BATCH = parseInt(process.env.DISCOVER_BATCH || '25', 10);
const CONCURRENCY = parseInt(process.env.DISCOVER_CONCURRENCY || '6', 10);
// Backlog sweep: how many pre-existing Pending connector suggestions to promote
// per run. The sweep chips through the backlog over several runs.
const SWEEP = parseInt(process.env.DISCOVER_SWEEP || '50', 10);
// The cron now runs every 3h to accelerate connector coverage, but the curated
// scrape + its LLM extraction only need to run ~daily, so skip a source scraped
// within this many hours. Keeps us from re-hitting the same sites 8x/day.
const SCRAPE_MIN_HOURS = parseInt(process.env.DISCOVER_SCRAPE_MIN_HOURS || '20', 10);

const TM_SOURCE = 'https://www.ticketmaster.com';
const FSQ_SOURCE = 'https://foursquare.com';

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

// Central, enabled discovery sources (curated URL-scrape phase only).
async function loadSources() {
  var data = await atFetch('/' + gk.DISCOVERY_SOURCES_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Enabled}=TRUE()")
    + '&maxRecords=' + MAX_SOURCES);
  return (data.records || []).map(function (rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      name: f['Name'] || '',
      url: f['URL'] || '',
      destination: f['Destination'] || '',
      categoryHint: valueOf(f['Category Hint']) || 'Things To Do',
      skipScrape: !!f['Skip Scrape'],
      lastScanned: f['Last Scanned'] || null
    };
  });
}

// Index of live Knowledge keyed by lower-cased question -> { id, source }. Used
// by the connector phase to decide create/refresh/skip, and its question list
// feeds the scrape-phase dedup. Paginated with a generous ceiling.
async function loadKnowledgeIndex() {
  var byQuestion = {}, questions = [], offset = null, pages = 0;
  do {
    var path = '/' + gk.KNOWLEDGE_TABLE + '?fields%5B%5D=Question&fields%5B%5D=Source&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) {
      var q = r.fields && r.fields.Question; if (!q) return;
      questions.push(q);
      var ql = String(q).toLowerCase();
      if (!byQuestion[ql]) byQuestion[ql] = { id: r.id, source: (r.fields.Source || '') };
    });
    offset = data.offset || null; pages++;
  } while (offset && pages < 40);
  return { byQuestion: byQuestion, questions: questions };
}

// All Pending suggestions, once. Their questions feed scrape dedup; the
// connector-origin ones (Foursquare/Ticketmaster) are the backlog to sweep.
async function loadPendingSuggestions() {
  var records = [], offset = null, pages = 0;
  do {
    var path = '/' + gk.SUGGESTED_TABLE + '?filterByFormula=' + encodeURIComponent("{Status}='Pending'")
      + '&fields%5B%5D=Question&fields%5B%5D=Consumer Answer&fields%5B%5D=Category&fields%5B%5D=Related To'
      + '&fields%5B%5D=Source&fields%5B%5D=Confidence&fields%5B%5D=Origin&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) { records.push(r); });
    offset = data.offset || null; pages++;
  } while (offset && pages < 20);
  return records;
}

function originToConnectorKey(origin) {
  var o = String(origin || '').toLowerCase();
  if (o.indexOf('foursquare') !== -1) return 'foursquare';
  if (o.indexOf('ticketmaster') !== -1) return 'ticketmaster';
  return '';
}

function mapDest(rec) {
  var f = rec.fields || {};
  return { id: rec.id, name: f['Name'] || '', country: f['Country'] || '', type: valueOf(f['Type']) || '' };
}

// The rotating batch of global destinations. Never-scanned rows (blank Last
// Discovered) first, then oldest-scanned, so every destination is reached before
// any repeats.
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

async function stampDiscovered(ids, nowIso) {
  for (var i = 0; i < ids.length; i += 10) {
    var recs = ids.slice(i, i + 10).map(function (id) { return { id: id, fields: { 'Last Discovered': nowIso } }; });
    await atFetch('/' + gk.DESTINATIONS_TABLE, { method: 'PATCH', body: { records: recs, typecast: true } });
  }
}

// ---- Batch writers (Knowledge auto-publish + suggestion status) -------------
async function createKnowledge(list) {
  for (var i = 0; i < list.length; i += 10) {
    var recs = list.slice(i, i + 10).map(function (f) { return { fields: f }; });
    await atFetch('/' + gk.KNOWLEDGE_TABLE, { method: 'POST', body: { records: recs, typecast: true } });
  }
}
async function updateKnowledge(list) {
  for (var i = 0; i < list.length; i += 10) {
    await atFetch('/' + gk.KNOWLEDGE_TABLE, { method: 'PATCH', body: { records: list.slice(i, i + 10), typecast: true } });
  }
}
async function deleteKnowledge(ids) {
  for (var i = 0; i < ids.length; i += 10) {
    var q = ids.slice(i, i + 10).map(function (id) { return 'records%5B%5D=' + encodeURIComponent(id); }).join('&');
    await atFetch('/' + gk.KNOWLEDGE_TABLE + '?' + q, { method: 'DELETE' });
  }
}
async function markSuggestions(marks) {
  for (var i = 0; i < marks.length; i += 10) {
    var recs = marks.slice(i, i + 10).map(function (m) {
      var f = { Status: m.status };
      if (m.knowledgeId) f['Promoted Knowledge ID'] = m.knowledgeId;
      return { id: m.id, fields: f };
    });
    await atFetch('/' + gk.SUGGESTED_TABLE, { method: 'PATCH', body: { records: recs, typecast: true } });
  }
}

// Plan a deterministic connector draft into the shared publish plan, against the
// live-Knowledge index, de-duplicating within this run via plan.claimed.
//   create    -> auto-publish a new row.
//   update    -> refresh the connector's own existing row.
//   skip      -> a human/other-source row owns this question; leave it alone.
//   duplicate -> already handled earlier this run.
function planPublish(plan, draft, opts) {
  opts = opts || {};
  var q = String((draft && draft.question) || '').trim();
  if (!q) return { action: 'skip', reason: 'no_question' };
  var ql = q.toLowerCase();
  if (plan.claimed[ql]) return { action: 'duplicate' };
  var decision = gk.decidePublish(plan.kindex[ql] || null, opts.connectorKey);
  if (decision.action === 'create' || decision.action === 'update') {
    var fields = gk.connectorDraftToKnowledgeFields(draft, { category: opts.category, relatedTo: opts.relatedTo, seasonal: opts.seasonal });
    if (decision.action === 'create') plan.creates.push(fields);
    else plan.updates.push({ id: decision.id, fields: fields });
    plan.claimed[ql] = true;
  }
  return decision;
}

async function extractFromPage(anthropic, pageText, opts) {
  var prompt = discover.buildExtractionPrompt(pageText, opts);
  var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 900, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
  var text = '';
  if (resp && resp.content) { for (var i = 0; i < resp.content.length; i++) { if (resp.content[i].type === 'text') text += resp.content[i].text; } }
  return discover.processCandidates(text, opts);
}

// Stage curated-scrape candidates as Pending suggestions (these stay human-gated).
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
      'Confidence': gk.capConfidence(c.confidence),
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
  var nowIso = new Date().toISOString();

  try {
    var sources = await loadSources();
    var kindex = await loadKnowledgeIndex();
    var pendingRecs = await loadPendingSuggestions();
    var existingQuestions = kindex.questions.concat(
      pendingRecs.map(function (r) { return (r.fields && r.fields.Question) || ''; }).filter(Boolean));

    var report = [];
    // Shared publish plan for the connector phase + backlog sweep.
    var plan = { kindex: kindex.byQuestion, claimed: {}, creates: [], updates: [], deletes: [] };
    var counts = { create: 0, update: 0, skip: 0, duplicate: 0, removed: 0 };

    // ---- 1) Curated URL scrape -> Pending (human-gated) ----
    var scrapeStaged = [];
    var scrapeMinMs = SCRAPE_MIN_HOURS * 3600 * 1000;
    for (var si = 0; si < sources.length && scrapeStaged.length < MAX_NEW_TOTAL; si++) {
      var src = sources[si];
      if (!src.url || src.skipScrape) continue;
      // The cron runs every 3h for the connectors; only re-scrape a source (and
      // re-run its LLM extraction) once it is at least SCRAPE_MIN_HOURS stale.
      if (src.lastScanned && (Date.now() - Date.parse(src.lastScanned)) < scrapeMinMs) {
        report.push({ source: src.name, skipped: 'scanned_within_' + SCRAPE_MIN_HOURS + 'h' }); continue;
      }
      var scraped = await scrape.scrapeUrl(src.url, { timeoutMs: 12000, maxHops: 3 });
      if (!scraped.ok) { report.push({ source: src.name, url: src.url, error: scraped.error }); continue; }
      var found;
      try {
        found = await extractFromPage(anthropic, scraped.content, {
          sourceUrl: scraped.url, destination: src.destination, existingQuestions: existingQuestions.concat(scrapeStaged)
        });
      } catch (e) { report.push({ source: src.name, url: src.url, error: 'extract_failed: ' + e.message }); continue; }
      found = found.slice(0, MAX_PER_SOURCE);
      if (!dryRun && found.length) await stageCandidates(found, { category: src.categoryHint, destination: src.destination, origin: 'Discovery Crawl' });
      if (!dryRun && found.length) { try { await atFetch('/' + gk.DISCOVERY_SOURCES_TABLE + '/' + src.id, { method: 'PATCH', body: { fields: { 'Last Scanned': nowIso } } }); } catch (e) {} }
      found.forEach(function (c) { scrapeStaged.push(c.question); });
      report.push({ source: src.name, url: scraped.url, staged: found.length, titles: found.map(function (c) { return c.question; }) });
    }

    // ---- 2) Global connectors -> live Knowledge (trusted-source auto-publish) ----
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

        // Ticketmaster events (Seasonal; refreshed each rotation).
        if (item.tm) {
          if (!item.tm.ok) { report.push({ source: 'ticketmaster', destination: d.name, error: item.tm.error, httpStatus: item.tm.httpStatus }); }
          else if (item.tm.draft) {
            var r1 = planPublish(plan, item.tm.draft, { connectorKey: 'ticketmaster', category: 'Events', relatedTo: d.name, seasonal: true });
            counts[r1.action] = (counts[r1.action] || 0) + 1;
            report.push({ source: 'ticketmaster', destination: d.name, events: item.tm.count, action: r1.action });
          } else {
            // OK but zero upcoming events: remove a stale connector-owned events row.
            var eqk = ('What events are coming up in ' + d.name + '?').toLowerCase();
            var exTm = plan.kindex[eqk];
            if (exTm && exTm.id && String(exTm.source || '').toLowerCase().indexOf('ticketmaster') !== -1 && !plan.claimed[eqk]) {
              plan.deletes.push(exTm.id); plan.claimed[eqk] = true; counts.removed++;
              report.push({ source: 'ticketmaster', destination: d.name, events: 0, action: 'removed_stale' });
            } else { report.push({ source: 'ticketmaster', destination: d.name, events: 0, action: 'none' }); }
          }
        }

        // Foursquare things to do (evergreen).
        if (item.fsq) {
          if (!item.fsq.ok) { report.push({ source: 'foursquare', destination: d.name, error: item.fsq.error, httpStatus: item.fsq.httpStatus, via: item.fsq.via, near: item.fsq.near }); }
          else if (item.fsq.draft) {
            var r2 = planPublish(plan, item.fsq.draft, { connectorKey: 'foursquare', category: 'Things To Do', relatedTo: d.name });
            counts[r2.action] = (counts[r2.action] || 0) + 1;
            report.push({ source: 'foursquare', destination: d.name, places: item.fsq.count, action: r2.action, via: item.fsq.via, near: item.fsq.near });
          } else { report.push({ source: 'foursquare', destination: d.name, places: item.fsq.count, action: 'none', via: item.fsq.via, near: item.fsq.near }); }
        }
      }
    }

    // ---- 3) Backlog sweep: promote pre-existing connector-origin Pending rows ----
    var backlog = pendingRecs.filter(function (r) { return originToConnectorKey(r.fields && r.fields.Origin); }).slice(0, SWEEP);
    var sweepMarks = [];
    var sweepCounts = { approved: 0, dismissed: 0 };
    backlog.forEach(function (rec) {
      var f = rec.fields || {};
      var key = originToConnectorKey(f.Origin);
      var draft = { question: f.Question || '', answer: f['Consumer Answer'] || '', confidence: valueOf(f.Confidence), sourceUrl: f.Source || (key === 'ticketmaster' ? TM_SOURCE : FSQ_SOURCE) };
      var cat = valueOf(f.Category) || (key === 'ticketmaster' ? 'Events' : 'Things To Do');
      var r = planPublish(plan, draft, { connectorKey: key, category: cat, relatedTo: f['Related To'] || '', seasonal: key === 'ticketmaster' ? true : undefined });
      if (r.action === 'skip') { sweepMarks.push({ id: rec.id, status: 'Dismissed' }); sweepCounts.dismissed++; }
      else { sweepMarks.push({ id: rec.id, status: 'Approved', knowledgeId: r.id || '' }); sweepCounts.approved++; }
    });

    // ---- Execute all writes (skipped entirely on dry runs) ----
    if (!dryRun) {
      if (plan.creates.length) await createKnowledge(plan.creates);
      if (plan.updates.length) await updateKnowledge(plan.updates);
      if (plan.deletes.length) await deleteKnowledge(plan.deletes);
      if (batch.length) {
        try { await stampDiscovered(batch.map(function (b) { return b.id; }), nowIso); }
        catch (e) { report.push({ source: 'rotation', error: 'stamp_failed: ' + e.message }); }
      }
      if (sweepMarks.length) await markSuggestions(sweepMarks);
    }

    var published = counts.create, refreshed = counts.update, skipped = counts.skip + counts.duplicate;
    if (!dryRun && (published || refreshed || scrapeStaged.length || sweepCounts.approved)) {
      await tgSend('Luna discovery: published ' + published + ', refreshed ' + refreshed + ' to live Knowledge; '
        + sweepCounts.approved + ' backlog promoted; ' + scrapeStaged.length + ' scrape(s) staged for review.');
    }

    return res.status(200).json({
      ok: true, dryRun: !!dryRun,
      sources: sources.length, destinationsScanned: batch.length,
      published: published, refreshed: refreshed, skipped: skipped, removedStale: counts.removed,
      scrapeStaged: scrapeStaged.length,
      backlogSwept: sweepMarks.length, backlogApproved: sweepCounts.approved, backlogDismissed: sweepCounts.dismissed,
      backlogRemaining: Math.max(0, pendingRecs.filter(function (r) { return originToConnectorKey(r.fields && r.fields.Origin); }).length - backlog.length),
      report: report, checkedAt: nowIso
    });
  } catch (e) {
    console.error('[discover-scan] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
