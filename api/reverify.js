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
const gk = require('../lib/global-knowledge');

const REVERIFICATION_TABLE = 'tblCimk9x32l3LRMK';
const MODEL = process.env.REVERIFY_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_LIMIT = 15;

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
    + '&fields%5B%5D=Question&fields%5B%5D=Consumer Answer&fields%5B%5D=Source&fields%5B%5D=Last Verified&fields%5B%5D=Category'
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
      lastVerified: f['Last Verified'] || null
    });
  });
  return out;
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
    var queued = await loadQueuedIds();
    var records = await loadStaleSourced(limit, queued);
    var counts = { checked: 0, confirmed: 0, changed: 0, unverifiable: 0, source_unreachable: 0 };
    var rows = [], report = [];

    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      var v = await runCheck(anthropic, rec);
      counts.checked++;
      counts[v.verdict] = (counts[v.verdict] || 0) + 1;
      rows.push({ fields: {
        'Question': rec.question,
        'Knowledge Record ID': rec.id,
        'Verdict': v.verdict,
        'Current Answer': rec.answer,
        'Suggested Answer': v.suggestedAnswer || '',
        'Evidence': v.evidence || '',
        'Source URL': rec.sourceUrl,
        'Status': 'Pending',
        'Checked At': nowIso,
        'Category': rec.category
      } });
      report.push({ question: rec.question, verdict: v.verdict, lastVerified: rec.lastVerified });
    }

    if (!dryRun && rows.length) await queueRows(rows);
    if (!dryRun && (counts.changed > 0 || counts.confirmed > 0)) {
      await tgSend('Luna re-verification: checked ' + counts.checked + ' (confirmed ' + counts.confirmed + ', changed ' + counts.changed + ', unverifiable ' + counts.unverifiable + '). Review in the re-verification queue.');
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, counts: counts, report: report, checkedAt: nowIso });
  } catch (e) {
    console.error('[reverify] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
