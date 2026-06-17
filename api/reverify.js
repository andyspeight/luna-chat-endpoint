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
const DEFAULT_LIMIT = 15;
const DEFAULT_UNSOURCED_LIMIT = parseInt(process.env.REVERIFY_UNSOURCED_LIMIT || '6', 10);
// Cap web-search corroborations per run so the cron stays within its time limit
// (each is a search plus up to 3 model checks). Trusted-source records do not
// consume this; they auto-apply on a single grounded check.
const CORRO_CAP = parseInt(process.env.REVERIFY_CORRO_CAP || '8', 10);
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
async function loadStaleSourced(limit, queued) {
  var data = await atFetch('/' + gk.KNOWLEDGE_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Source}!=''")
    + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Verified') + '&sort%5B0%5D%5Bdirection%5D=asc'
    + '&fields%5B%5D=Question&fields%5B%5D=Consumer Answer&fields%5B%5D=Source&fields%5B%5D=Last Verified&fields%5B%5D=Category&fields%5B%5D=Related To'
    + '&maxRecords=200');
  var out = [];
  (data.records || []).forEach(function (rec) {
    if (out.length >= limit) return;
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

async function runCheck(anthropic, record) {
  var scraped = await scrape.scrapeUrl(record.sourceUrl, { timeoutMs: 12000, maxHops: 3 });
  if (!scraped.ok) return { verdict: 'source_unreachable', evidence: '', changedDetail: '', suggestedAnswer: '', scrapeError: scraped.error };
  var prompt = reverify.buildVerificationPrompt(record, scraped.content, { sourceUrl: record.sourceUrl });
  var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
  var text = '';
  if (resp && resp.content) { for (var i = 0; i < resp.content.length; i++) { if (resp.content[i].type === 'text') text += resp.content[i].text; } }
  return reverify.parseVerdict(text);
}

// Seek independent corroboration for a fact whose own source is not
// authoritative. Searches the web, checks up to 3 INDEPENDENT domains (excluding
// the record's own source) with the same grounded checker, and counts how many
// confirm. Returns { confirmedCount, domains }. No-op without TAVILY_API_KEY.
async function corroborate(anthropic, rec) {
  var out = { confirmedCount: 0, domains: [] };
  if (!process.env.TAVILY_API_KEY) return out;
  var sr = await search.search(rec.question, { maxResults: 6 });
  if (!sr.ok || !sr.results || !sr.results.length) return out;

  var ownDomain = search.registrableDomain(rec.sourceUrl);
  var seen = {}, independent = [];
  sr.results.forEach(function (r) {
    var d = search.registrableDomain(r.url);
    if (!d || d === ownDomain || seen[d]) return;
    seen[d] = 1; independent.push({ r: r, domain: d });
  });
  independent = independent.slice(0, 3);

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
    var records = await loadStaleSourced(limit, queued);
    var counts = { checked: 0, confirmed: 0, changed: 0, unverifiable: 0, source_unreachable: 0, autoApplied: 0, pending: 0, unsourcedChecked: 0 };
    var rows = [], report = [];
    var corroDone = 0; // bounds web-search corroborations per run (CORRO_CAP)

    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var v = await runCheck(anthropic, rec);
      counts.checked++;
      counts[v.verdict] = (counts[v.verdict] || 0) + 1;

      // Trust gate: only a trusted source (government, authority, or an
      // official-site domain) lets a verdict apply without human review.
      var tr = trusted.isTrusted(rec.sourceUrl, extraTrusted);
      var status = 'Pending';
      var action = 'pending';
      var evidence = v.evidence || '';

      if (AUTOAPPLY && tr.trusted && (v.verdict === 'confirmed' || v.verdict === 'changed')) {
        // Path 1: one authoritative source is enough.
        action = 'auto-' + v.verdict + ' (' + tr.reason + ')';
        status = 'Applied';
        if (!dryRun) {
          if (v.verdict === 'confirmed') {
            await applyToKnowledge(rec.id, { 'Last Verified': today });
          } else {
            var searchIndex = gk.buildSearchIndex({ question: rec.question, consumerAnswer: v.suggestedAnswer, category: rec.category, relatedTo: rec.relatedTo });
            await applyToKnowledge(rec.id, { 'Consumer Answer': v.suggestedAnswer, 'Search Index': searchIndex, 'Last Verified': today });
          }
        }
        counts.autoApplied++;
      } else if (AUTOAPPLY && corroDone < CORRO_CAP && (v.verdict === 'confirmed' || v.verdict === 'unverifiable' || v.verdict === 'source_unreachable')) {
        // Path 2: we could not confirm from the cited source (non-authoritative,
        // unreachable, or it did not cover the claim), so seek two INDEPENDENT
        // sources that agree. A 'changed' verdict is never routed here, since the
        // source contradicting the answer is a real signal to review, not confirm.
        corroDone++;
        var corro = await corroborate(anthropic, rec);
        if (corro.confirmedCount >= 2) {
          action = 'auto-corroborated (' + corro.domains.join(', ') + ')';
          status = 'Applied';
          evidence = 'Corroborated by ' + corro.confirmedCount + ' independent sources: ' + corro.domains.join(', ');
          if (!dryRun) await applyToKnowledge(rec.id, { 'Last Verified': today });
          counts.autoApplied++;
        } else {
          action = 'pending (corroboration ' + corro.confirmedCount + '/2)';
          counts.pending++;
        }
      } else {
        counts.pending++;
      }

      // Always write an audit/queue row: Applied keeps a before/after record;
      // Pending is the human review item.
      rows.push({ fields: {
        'Question': rec.question,
        'Knowledge Record ID': rec.id,
        'Verdict': v.verdict,
        'Current Answer': rec.answer,
        'Suggested Answer': v.suggestedAnswer || '',
        'Evidence': evidence,
        'Source URL': rec.sourceUrl,
        'Status': status,
        'Checked At': nowIso,
        'Category': rec.category
      } });
      report.push({ question: rec.question, verdict: v.verdict, trusted: tr.trusted, action: action });
    }

    // Unsourced records: no cited source to ground-check, so the only honest way
    // to verify them is independent corroboration (needs Tavily). Same per-run
    // corroboration cap, so this naturally takes over once the sourced backlog
    // is light.
    if (AUTOAPPLY && process.env.TAVILY_API_KEY && corroDone < CORRO_CAP) {
      var uLimit = Math.min(parseInt((req.query && req.query.unsourcedLimit) || DEFAULT_UNSOURCED_LIMIT, 10) || DEFAULT_UNSOURCED_LIMIT, 20);
      var unsourced = await loadStaleUnsourced(uLimit, queued);
      for (var u = 0; u < unsourced.length && corroDone < CORRO_CAP; u++) {
        var urec = unsourced[u];
        corroDone++;
        counts.unsourcedChecked++;
        var ucorro = await corroborate(anthropic, urec);
        var ustatus = 'Pending', uverdict = 'unverifiable', uevidence = '';
        var uaction = 'pending (no source, corroboration ' + ucorro.confirmedCount + '/2)';
        if (ucorro.confirmedCount >= 2) {
          ustatus = 'Applied'; uverdict = 'confirmed';
          uaction = 'auto-corroborated, no prior source (' + ucorro.domains.join(', ') + ')';
          uevidence = 'Corroborated by ' + ucorro.confirmedCount + ' independent sources: ' + ucorro.domains.join(', ');
          if (!dryRun) await applyToKnowledge(urec.id, { 'Last Verified': today });
          counts.autoApplied++;
        } else {
          counts.pending++;
        }
        rows.push({ fields: {
          'Question': urec.question,
          'Knowledge Record ID': urec.id,
          'Verdict': uverdict,
          'Current Answer': urec.answer,
          'Suggested Answer': '',
          'Evidence': uevidence,
          'Source URL': '',
          'Status': ustatus,
          'Checked At': nowIso,
          'Category': urec.category
        } });
        report.push({ question: urec.question, verdict: uverdict, sourced: false, action: uaction });
      }
    }

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
