// api/reverify.js
// Anti-staleness re-verification cron for the global knowledge base.
//
// Picks the oldest-verified Knowledge answers that cite a Source URL, fetches
// that source with the hardened scraper, and asks the model (as a grounded
// CHECKER, source-only, see lib/reverify) whether the answer still holds. Every
// verdict is written to the Knowledge Reverification queue as Pending. NOTHING
// in the live Knowledge table changes here; a human accepts/applies from the
// queue. This is how we keep the foundational data fresh without ever letting
// the model invent an "update".
//
// Bounded per run (default 15) so cost/time stay predictable; runs daily and
// chips through the backlog oldest-first, then keeps it maintained.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports what
// it would queue without writing. ?limit overrides the per-run cap.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY. Optional: REVERIFY_MODEL.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const scrape = require('../lib/safe-scrape');
const reverify = require('../lib/reverify');
const trusted = require('../lib/trusted-sources');
const search = require('../lib/search');
const gk = require('../lib/global-knowledge');

const REVERIFICATION_TABLE = 'tblCimk9x32l3LRMK';
const MODEL = process.env.REVERIFY_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_LIMIT = parseInt(process.env.REVERIFY_LIMIT || '8', 10);
const DEFAULT_UNSOURCED_LIMIT = parseInt(process.env.REVERIFY_UNSOURCED_LIMIT || '4', 10);
// Cap web-search corroborations per run (each is a search plus up to 3 model
// checks). Trusted-source records do not consume this; they auto-apply on a
// single grounded check.
const CORRO_CAP = parseInt(process.env.REVERIFY_CORRO_CAP || '5', 10);
// How many records' network steps run at once. Keeps total wall-time well under
// the function's 60s limit while staying gentle on the upstream APIs.
const CONCURRENCY = parseInt(process.env.REVERIFY_CONCURRENCY || '5', 10);

// Re-verification value by category: time-sensitive facts (visas, fees, health)
// benefit most and have clean authoritative sources; opinion/recommendation
// content cannot be source-confirmed and barely goes stale, so it is processed
// last. Unknown categories sit in the middle.
var CATEGORY_RANK = {
  'Entry & Visas': 5, 'Money & Costs': 5, 'Health & Safety': 5,
  'Airline Guide': 4, 'Airport Guide': 4,
  'Getting There': 3, 'Getting Around': 3, 'Cruise Guide': 3,
  'Culture & Practical': 2,
  'Climate & When to Go': 1, 'Destination Recommendations': 1
};
function catRank(c) { return (c && CATEGORY_RANK[c] != null) ? CATEGORY_RANK[c] : 2; }
// Auto-apply verdicts backed by a trusted source (government, authority, or an
// official-site domain in LUNA_TRUSTED_DOMAINS). Set REVERIFY_AUTOAPPLY=false to
// route everything to human review instead.
const AUTOAPPLY = process.env.REVERIFY_AUTOAPPLY !== 'false';

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

function valueOf(f) { return (f && typeof f === 'object' && f.name) ? f.name : (f || ''); }

// Knowledge Record IDs already sitting Pending in the queue, so we don't re-check them.
async function loadQueuedIds() {
  var ids = {};
  var data = await atFetch('/' + REVERIFICATION_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Status}='Pending'")
    + '&fields%5B%5D=Knowledge Record ID&maxRecords=1000');
  (data.records || []).forEach(function (r) { var id = r.fields && r.fields['Knowledge Record ID']; if (id) ids[id] = 1; });
  return ids;
}

// Oldest-verified Knowledge answers that cite a Source, not already queued.
// Returns up to `pool` candidates; the handler then prioritises the highest-
// yield ones (authoritative source) before taking the per-run limit.
async function loadStaleSourced(pool, queued) {
  var data = await atFetch('/' + gk.KNOWLEDGE_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Source}!=''")
    + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Verified') + '&sort%5B0%5D%5Bdirection%5D=asc'
    + '&fields%5B%5D=Question&fields%5B%5D=Consumer Answer&fields%5B%5D=Source&fields%5B%5D=Last Verified&fields%5B%5D=Category&fields%5B%5D=Related To'
    + '&maxRecords=200');
  var out = [];
  (data.records || []).forEach(function (rec) {
    if (out.length >= pool) return;
    if (queued[rec.id]) return;
    var f = rec.fields || {};
    if (!f.Source) return;
    out.push({
      id: rec.id,
      question: f.Question || '',
      answer: f['Consumer Answer'] || '',
      sourceUrl: f.Source,
      category: valueOf(f.Category) || '',
      relatedTo: f['Related To'] || '',
      lastVerified: f['Last Verified'] || null
    });
  });
  return out;
}

// Oldest-verified Knowledge answers that have NO Source, not already queued.
// These can only be grounded via corroboration (search for independent sources).
async function loadStaleUnsourced(limit, queued) {
  var data = await atFetch('/' + gk.KNOWLEDGE_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Source}=''")
    + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Verified') + '&sort%5B0%5D%5Bdirection%5D=asc'
    + '&fields%5B%5D=Question&fields%5B%5D=Consumer Answer&fields%5B%5D=Last Verified&fields%5B%5D=Category&fields%5B%5D=Related To'
    + '&maxRecords=200');
  var out = [];
  (data.records || []).forEach(function (rec) {
    if (out.length >= limit) return;
    if (queued[rec.id]) return;
    var f = rec.fields || {};
    if (f.Source) return;
    out.push({
      id: rec.id,
      question: f.Question || '',
      answer: f['Consumer Answer'] || '',
      sourceUrl: '',
      category: valueOf(f.Category) || '',
      relatedTo: f['Related To'] || '',
      lastVerified: f['Last Verified'] || null
    });
  });
  return out;
}

// Apply a field update to a live Knowledge record (only ever called for
// trusted-source verdicts).
async function applyToKnowledge(recordId, fields) {
  await atFetch('/' + gk.KNOWLEDGE_TABLE + '/' + recordId, {
    method: 'PATCH', body: { fields: fields, typecast: true }
  });
}

// Run async fn over items with bounded concurrency. Errors are captured per
// item (so one failure never aborts the batch) and returned in place.
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

async function runCheck(anthropic, record) {
  var scraped = await scrape.scrapeUrl(record.sourceUrl, { timeoutMs: 6000, maxHops: 2 });
  if (!scraped.ok) return { verdict: 'source_unreachable', evidence: '', changedDetail: '', suggestedAnswer: '', scrapeError: scraped.error };
  var prompt = reverify.buildVerificationPrompt(record, scraped.content, { sourceUrl: record.sourceUrl });
  var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
  var text = '';
  if (resp && resp.content) { for (var i = 0; i < resp.content.length; i++) { if (resp.content[i].type === 'text') text += resp.content[i].text; } }
  // Keep the scraped source alongside the verdict so the apply step can confirm
  // the model's evidence quote actually appears in it before overwriting a live
  // answer (anti-fabrication guard — see evidenceInSource).
  return Object.assign(reverify.parseVerdict(text), { sourceText: scraped.content });
}

// True when the model's evidence quote genuinely appears in the fetched source.
// Mirrors the guard fill-gaps.js already uses. A leading slice tolerates minor
// trailing edits, but the substance must be present verbatim. Fail-closed: an
// empty/too-short quote returns false so we never auto-apply on thin evidence.
function reverifyNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function evidenceInSource(evidence, sourceText) {
  var e = reverifyNorm(evidence);
  if (e.length < 8) return false;
  var hay = reverifyNorm(sourceText);
  var needle = e.slice(0, Math.min(60, e.length));
  return hay.indexOf(needle) !== -1;
}

// Seek independent corroboration for a fact whose own source is not
// authoritative. Searches the web, checks up to 3 INDEPENDENT domains (excluding
// the record's own source) with the same grounded checker, and counts how many
// confirm. Returns { confirmedCount, domains }. No-op without TAVILY_API_KEY.
async function corroborate(anthropic, rec) {
  var out = { confirmedCount: 0, domains: [], checked: 0, searchStatus: 'no_key' };
  if (!process.env.TAVILY_API_KEY) return out;
  var sr = await search.search(rec.question, { maxResults: 6, timeoutMs: 6000 });
  out.searchStatus = sr.ok ? ('results:' + ((sr.results && sr.results.length) || 0)) : ('search_' + (sr.error || 'fail') + (sr.httpStatus ? ('_' + sr.httpStatus) : ''));
  if (!sr.ok || !sr.results || !sr.results.length) return out;

  var ownDomain = search.registrableDomain(rec.sourceUrl);
  var seen = {}, independent = [];
  sr.results.forEach(function (r) {
    var d = search.registrableDomain(r.url);
    if (!d || d === ownDomain || seen[d]) return;
    seen[d] = 1; independent.push({ r: r, domain: d });
  });
  independent = independent.slice(0, 3);
  out.checked = independent.length;

  for (var i = 0; i < independent.length; i++) {
    var item = independent[i];
    var sourceText = item.r.rawContent || item.r.content;
    var prompt = reverify.buildVerificationPrompt(rec, sourceText, { sourceUrl: item.r.url });
    var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 500, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
    var text = '';
    if (resp && resp.content) { for (var j = 0; j < resp.content.length; j++) { if (resp.content[j].type === 'text') text += resp.content[j].text; } }
    if (reverify.parseVerdict(text).verdict === 'confirmed') { out.confirmedCount++; out.domains.push(item.domain); }
  }
  return out;
}

async function queueRows(rows) {
  for (var i = 0; i < rows.length; i += 10) {
    await atFetch('/' + REVERIFICATION_TABLE, { method: 'POST', body: { records: rows.slice(i, i + 10), typecast: true } });
  }
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
  var limit = Math.min(parseInt((req.query && req.query.limit) || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 40);
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var nowIso = new Date().toISOString();

  try {
    var extraTrusted = trusted.parseDomainList(process.env.LUNA_TRUSTED_DOMAINS || '');
    var today = nowIso.split('T')[0];
    var queued = await loadQueuedIds();
    // Pull a pool of the oldest sourced records, then prioritise those whose
    // cited source is authoritative: they auto-apply on a single grounded check
    // (Path 1), so the verifiable backlog clears first and real refreshes surface
    // immediately rather than budget being spent on un-sourceable advice.
    var pool = await loadStaleSourced(Math.max(limit * 5, 50), queued);
    pool.forEach(function (r) { r.__trusted = trusted.isTrusted(r.sourceUrl, extraTrusted).trusted ? 1 : 0; });
    // Verifiable, time-sensitive categories first; authoritative source breaks ties.
    pool.sort(function (a, b) { return (catRank(b.category) + b.__trusted) - (catRank(a.category) + a.__trusted); });
    var sourced = pool.slice(0, limit);
    var counts = { checked: 0, confirmed: 0, changed: 0, unverifiable: 0, source_unreachable: 0, autoApplied: 0, pending: 0, unsourcedChecked: 0 };
    var report = [];

    // Phase 1 - primary grounded checks (scrape + one model call), concurrent.
    var primaries = await mapLimit(sourced, CONCURRENCY, async function (rec) {
      var v = await runCheck(anthropic, rec);
      return { rec: rec, v: v, tr: trusted.isTrusted(rec.sourceUrl, extraTrusted), status: 'Pending', action: 'pending', evidence: (v && v.evidence) || '' };
    });

    // Phase 2 - apply single-trusted-source verdicts; collect the rest for corroboration.
    var needCorro = [];
    primaries.forEach(function (p) {
      if (!p || !p.v) { counts.pending++; return; }
      counts.checked++;
      counts[p.v.verdict] = (counts[p.v.verdict] || 0) + 1;
      // A "changed" verdict OVERWRITES the live answer, so it must clear a higher
      // bar than "confirmed" (which only stamps freshness): the model's evidence
      // quote has to actually appear in the scraped source. If it does not, the
      // correction may be fabricated or misattributed (a cookie wall, the wrong
      // section), so we do NOT auto-apply it — it drops to human review instead.
      var changedButUnsupported = p.v.verdict === 'changed' && !evidenceInSource(p.v.evidence, p.v.sourceText);
      if (AUTOAPPLY && p.tr.trusted && (p.v.verdict === 'confirmed' || p.v.verdict === 'changed') && !changedButUnsupported) {
        p.status = 'Applied';
        p.action = 'auto-' + p.v.verdict + ' (' + p.tr.reason + ')';
        p.apply = (p.v.verdict === 'confirmed')
          ? { 'Last Verified': today }
          : { 'Consumer Answer': p.v.suggestedAnswer, 'Search Index': gk.buildSearchIndex({ question: p.rec.question, consumerAnswer: p.v.suggestedAnswer, category: p.rec.category, relatedTo: p.rec.relatedTo }), 'Last Verified': today };
        counts.autoApplied++;
      } else if (changedButUnsupported) {
        // Left Pending for a human: a claimed change we could not ground in the source.
        p.status = 'Pending';
        p.action = 'changed, held for review (evidence not found in source)';
        counts.pending++;
      } else if (AUTOAPPLY && (p.v.verdict === 'confirmed' || p.v.verdict === 'unverifiable' || p.v.verdict === 'source_unreachable')) {
        needCorro.push(p);
      } else {
        counts.pending++;
      }
    });

    // Cap corroboration; anything over the cap stays Pending this run.
    var sourcedCorro = needCorro.slice(0, CORRO_CAP);
    needCorro.slice(CORRO_CAP).forEach(function (p) { p.action = 'pending (corroboration cap reached)'; counts.pending++; });

    // Fill remaining corroboration budget with unsourced records.
    var budgetLeft = CORRO_CAP - sourcedCorro.length;
    var unsourced = [];
    if (AUTOAPPLY && process.env.TAVILY_API_KEY && budgetLeft > 0) {
      var uLimit = Math.min(parseInt((req.query && req.query.unsourcedLimit) || DEFAULT_UNSOURCED_LIMIT, 10) || DEFAULT_UNSOURCED_LIMIT, budgetLeft);
      unsourced = await loadStaleUnsourced(uLimit, queued);
    }

    // Phase 3 - corroboration searches, concurrent.
    var corroItems = sourcedCorro.map(function (p) { return { p: p, rec: p.rec, sourced: true }; })
      .concat(unsourced.map(function (urec) { return { urec: urec, rec: urec, sourced: false }; }));
    await mapLimit(corroItems, CONCURRENCY, async function (item) { item.corro = await corroborate(anthropic, item.rec); });

    corroItems.forEach(function (item) {
      var corro = item.corro || { confirmedCount: 0, domains: [] };
      var ok2 = corro.confirmedCount >= 2;
      var note = 'Corroborated by ' + corro.confirmedCount + ' independent sources: ' + corro.domains.join(', ');
      if (item.sourced) {
        var p = item.p;
        if (ok2) { p.status = 'Applied'; p.action = 'auto-corroborated (' + corro.domains.join(', ') + ')'; p.evidence = note; p.apply = { 'Last Verified': today }; counts.autoApplied++; }
        else { p.action = 'pending (corroboration ' + corro.confirmedCount + '/2; ' + corro.searchStatus + ', checked ' + corro.checked + ')'; counts.pending++; }
      } else {
        var urec = item.urec; counts.unsourcedChecked++;
        urec.__verdict = ok2 ? 'confirmed' : 'unverifiable';
        if (ok2) { urec.__status = 'Applied'; urec.__action = 'auto-corroborated, no prior source (' + corro.domains.join(', ') + ')'; urec.__evidence = note; urec.__apply = { 'Last Verified': today }; counts.autoApplied++; }
        else { urec.__status = 'Pending'; urec.__action = 'pending (no source, corroboration ' + corro.confirmedCount + '/2; ' + corro.searchStatus + ', checked ' + corro.checked + ')'; counts.pending++; }
      }
    });

    // Phase 4 - apply Knowledge updates concurrently (unless dry run).
    if (!dryRun) {
      var applies = [];
      primaries.forEach(function (p) { if (p && p.apply) applies.push({ id: p.rec.id, fields: p.apply }); });
      unsourced.forEach(function (urec) { if (urec.__apply) applies.push({ id: urec.id, fields: urec.__apply }); });
      await mapLimit(applies, CONCURRENCY, async function (a) { await applyToKnowledge(a.id, a.fields); });
    }

    // Build audit/queue rows + report.
    var rows = [];
    primaries.forEach(function (p) {
      if (!p || !p.v) return;
      rows.push({ fields: {
        'Question': p.rec.question, 'Knowledge Record ID': p.rec.id, 'Verdict': p.v.verdict,
        'Current Answer': p.rec.answer, 'Suggested Answer': p.v.suggestedAnswer || '', 'Evidence': p.evidence || '',
        'Source URL': p.rec.sourceUrl, 'Status': p.status, 'Checked At': nowIso, 'Category': p.rec.category
      } });
      report.push({ question: p.rec.question, verdict: p.v.verdict, trusted: p.tr.trusted, action: p.action });
    });
    unsourced.forEach(function (urec) {
      rows.push({ fields: {
        'Question': urec.question, 'Knowledge Record ID': urec.id, 'Verdict': urec.__verdict || 'unverifiable',
        'Current Answer': urec.answer, 'Suggested Answer': '', 'Evidence': urec.__evidence || '',
        'Source URL': '', 'Status': urec.__status || 'Pending', 'Checked At': nowIso, 'Category': urec.category
      } });
      report.push({ question: urec.question, verdict: urec.__verdict || 'unverifiable', sourced: false, action: urec.__action || 'pending' });
    });

    if (!dryRun && rows.length) await queueRows(rows);
    if (!dryRun && (counts.autoApplied > 0 || counts.pending > 0)) {
      await tgSend('Luna re-verification: checked ' + counts.checked + '. Auto-applied ' + counts.autoApplied + ' from trusted sources; ' + counts.pending + ' need review.');
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, autoApply: AUTOAPPLY, counts: counts, report: report, checkedAt: nowIso });
  } catch (e) {
    console.error('[reverify] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exposed for unit testing only (does not change the handler contract).
module.exports.evidenceInSource = evidenceInSource;
