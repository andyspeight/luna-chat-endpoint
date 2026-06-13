// api/discover-scan.js
// Proactive discovery crawler — GLOBAL.
//
// Generic "things to do / what's on" data belongs in the shared knowledge base
// (base appPKx77relfeiqmq) that powers Luna and the widgets for every client,
// NOT per client. This job reads the central Discovery Sources table, safely
// scrapes each page, and also queries Ticketmaster for each source's
// destination, then writes everything as Pending rows in the Suggested
// Knowledge staging table. Nothing goes live until an admin approves it in the
// global review screen (api/global-brain), which promotes it into the live
// Knowledge table with a Search Index.
//
// Safety / cost posture:
//   - Cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 returns what WOULD
//     be staged without writing. SSRF-hardened fetch via lib/safe-scrape.
//   - Extraction-only prompting + dedup via lib/discover. Hard caps per run.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY.
// Optional: DISCOVER_MODEL, TICKETMASTER_API_KEY, TELEGRAM_BOT_TOKEN/CHAT_ID.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const scrape = require('../lib/safe-scrape');
const discover = require('../lib/discover');
const ticketmaster = require('../lib/ticketmaster');
const gk = require('../lib/global-knowledge');

const MODEL = process.env.DISCOVER_MODEL || 'claude-haiku-4-5-20251001';

const MAX_SOURCES = 20;        // URL pages scanned per run
const MAX_NEW_TOTAL = 60;      // total suggestions staged per run
const MAX_PER_SOURCE = 6;

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
  return (data.records || []).map(function (rec) {
    var f = rec.fields || {};
    return { id: rec.id, name: f['Name'] || '', url: f['URL'] || '', destination: f['Destination'] || '', categoryHint: valueOf(f['Category Hint']) || 'Things To Do' };
  }).filter(function (s) { return s.url; });
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

    // 2) Ticketmaster events per unique source destination (gated on key)
    if (process.env.TICKETMASTER_API_KEY) {
      var seenDest = {};
      for (var di = 0; di < sources.length && staged.length < MAX_NEW_TOTAL; di++) {
        var dest = sources[di].destination;
        if (!dest || seenDest[dest.toLowerCase()]) continue;
        seenDest[dest.toLowerCase()] = 1;
        var evDraft = await ticketmaster.fetchEventsDraft(dest, { max: 5 });
        if (!evDraft) continue;
        var processedEv = discover.processCandidates(JSON.stringify([evDraft]), { existingQuestions: existing.concat(staged), sourceUrl: 'https://www.ticketmaster.com' });
        if (!dryRun && processedEv.length) await stageCandidates(processedEv, { category: 'Events', destination: dest, origin: 'Ticketmaster' });
        processedEv.forEach(function (c) { staged.push(c.question); });
        if (processedEv.length) report.push({ source: 'ticketmaster', destination: dest, staged: processedEv.length });
      }
    }

    if (!dryRun && staged.length > 0) {
      await tgSend('Luna discovery: ' + staged.length + ' new suggestion(s) staged for review. Approve in the global review screen.');
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, sources: sources.length, totalStaged: staged.length, report: report, checkedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[discover-scan] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
