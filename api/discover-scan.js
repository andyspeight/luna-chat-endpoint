// api/discover-scan.js
// Proactive discovery crawler.
//
// Runs daily. For each client that has opted in (DiscoverEnabled) and listed
// source URLs (DiscoverSources: tourism boards, resort sites, event calendars),
// it safely scrapes each page, asks the model to EXTRACT new concrete things to
// do, and writes the results to the Knowledge table as DRAFT / Needs Review /
// Suggested by Luna. Nothing is served to visitors until the owner approves it
// in Luna Brain (Luna retrieval only ever reads Status = Active).
//
// Safety / cost posture:
//   - Cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 returns what WOULD
//     be written without touching Airtable. ?client=Name runs a single client.
//   - SSRF-hardened fetch via lib/safe-scrape (shared with Train-Luna).
//   - Extraction-only prompting + dedup via lib/discover. Drafts only.
//   - Hard caps per run so a bad config can never run away.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY.
// Optional: DISCOVER_MODEL (defaults to a Haiku-class model),
//   TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (summary).

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const scrape = require('../lib/safe-scrape');
const discover = require('../lib/discover');
const ticketmaster = require('../lib/ticketmaster');

const AT_BASE = 'app6Ot3eOb3DangkB';
const KNOWLEDGE_TABLE = 'tblstATJ3BSqtuTDU';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';

const MODEL = process.env.DISCOVER_MODEL || 'claude-haiku-4-5-20251001';

// Hard caps so a misconfiguration can never run away on cost or time.
const MAX_CLIENTS = 6;
const MAX_URLS_PER_CLIENT = 5;
const MAX_NEW_PER_CLIENT = 12;
const MAX_DESTINATIONS = 6;

async function atFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + AT_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

// Clients that have opted in. They may have URL sources, destinations (for the
// structured event connector), or both.
async function loadEnabledClients(onlyClient) {
  var formula = "{DiscoverEnabled}=TRUE()";
  if (onlyClient) {
    formula = "AND(" + formula + ", {ClientName}='" + onlyClient.replace(/'/g, "\\'") + "')";
  }
  var data = await atFetch('/' + CLIENTS_TABLE
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&fields%5B%5D=ClientName&fields%5B%5D=DiscoverSources&fields%5B%5D=Destinations'
    + '&maxRecords=' + MAX_CLIENTS);
  return (data.records || []).map(function (rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      name: f.ClientName || '',
      sources: String(f.DiscoverSources || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, MAX_URLS_PER_CLIENT),
      destinations: String(f.Destinations || '').split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, MAX_DESTINATIONS)
    };
  });
}

// Existing questions (Active + Draft) for a client, for dedup.
async function loadExistingQuestions(clientName) {
  var safe = clientName.replace(/'/g, "\\'");
  var formula = "AND(FIND('" + safe + "', ARRAYJOIN({Client}))>0, {Status}!='Archived')";
  var data = await atFetch('/' + KNOWLEDGE_TABLE
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&fields%5B%5D=Question&maxRecords=300');
  return (data.records || []).map(function (rec) { return (rec.fields && rec.fields.Question) || ''; }).filter(Boolean);
}

async function extractFromPage(anthropic, pageText, opts) {
  var prompt = discover.buildExtractionPrompt(pageText, opts);
  var resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }]
  });
  var text = '';
  if (resp && resp.content) {
    for (var i = 0; i < resp.content.length; i++) {
      if (resp.content[i].type === 'text') text += resp.content[i].text;
    }
  }
  return discover.processCandidates(text, opts);
}

async function createDrafts(clientRecordId, candidates) {
  var nowIso = new Date().toISOString();
  var records = candidates.map(function (c) {
    return {
      fields: {
        Question: c.question,
        Answer: c.answer,
        Client: [clientRecordId],
        Type: discover.TARGET_TYPE,
        Status: 'Draft',
        Source: 'Suggested by Luna',
        Confidence: 'Needs Review',
        CreatedAt: nowIso,
        Notes: 'Suggested by Luna discovery on ' + nowIso.split('T')[0]
          + (c.sourceUrl ? (' from ' + c.sourceUrl) : '')
          + ' (model confidence: ' + (c.confidence || 'medium') + ')'
      }
    };
  });
  for (var i = 0; i < records.length; i += 10) {
    await atFetch('/' + KNOWLEDGE_TABLE, { method: 'POST', body: { records: records.slice(i, i + 10), typecast: true } });
  }
}

async function tgSend(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) { /* best effort */ }
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.AIRTABLE_KEY || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var onlyClient = (req.query && req.query.client) ? String(req.query.client).slice(0, 100) : null;
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    var clients = await loadEnabledClients(onlyClient);
    var report = [];

    for (var ci = 0; ci < clients.length; ci++) {
      var client = clients[ci];
      var existing = await loadExistingQuestions(client.name);
      var clientNew = [];

      for (var ui = 0; ui < client.sources.length && clientNew.length < MAX_NEW_PER_CLIENT; ui++) {
        var url = client.sources[ui];
        var scraped = await scrape.scrapeUrl(url, { timeoutMs: 12000, maxHops: 3 });
        if (!scraped.ok) {
          report.push({ client: client.name, url: url, error: scraped.error });
          continue;
        }
        var found;
        try {
          found = await extractFromPage(anthropic, scraped.content, {
            sourceUrl: scraped.url,
            destination: client.name,
            existingQuestions: existing.concat(clientNew.map(function (c) { return c.question; }))
          });
        } catch (e) {
          report.push({ client: client.name, url: url, error: 'extract_failed: ' + e.message });
          continue;
        }
        found.forEach(function (c) { if (clientNew.length < MAX_NEW_PER_CLIENT) clientNew.push(c); });
        report.push({ client: client.name, url: scraped.url, candidates: found.length, titles: found.map(function (c) { return c.question; }) });
      }

      // Trusted structured source: Ticketmaster events per destination. Gated on
      // the API key, so this is a no-op until a key is configured. The draft is
      // built deterministically from the API, then run through the same dedup.
      if (process.env.TICKETMASTER_API_KEY) {
        for (var di = 0; di < client.destinations.length && clientNew.length < MAX_NEW_PER_CLIENT; di++) {
          var dest = client.destinations[di];
          var evDraft = await ticketmaster.fetchEventsDraft(dest, { max: 5 });
          if (!evDraft) continue;
          var processedEv = discover.processCandidates(JSON.stringify([evDraft]), {
            existingQuestions: existing.concat(clientNew.map(function (c) { return c.question; })),
            sourceUrl: 'https://www.ticketmaster.com'
          });
          processedEv.forEach(function (c) { if (clientNew.length < MAX_NEW_PER_CLIENT) clientNew.push(c); });
          if (processedEv.length) report.push({ client: client.name, source: 'ticketmaster', destination: dest, candidates: processedEv.length });
        }
      }

      if (!dryRun && clientNew.length) {
        await createDrafts(client.id, clientNew);
        await atFetch('/' + CLIENTS_TABLE + '/' + client.id, {
          method: 'PATCH', body: { fields: { DiscoverLastRun: new Date().toISOString() } }
        });
      }
      report.push({ client: client.name, summary: true, drafted: dryRun ? 0 : clientNew.length, wouldDraft: clientNew.length });
    }

    var totalNew = report.filter(function (r) { return r.summary; }).reduce(function (s, r) { return s + (r.wouldDraft || 0); }, 0);
    if (!dryRun && totalNew > 0) {
      await tgSend('Luna discovery: ' + totalNew + ' new draft answer(s) suggested across ' + clients.length + ' client(s). Review and approve in Luna Brain.');
    }

    return res.status(200).json({
      ok: true, dryRun: !!dryRun, clients: clients.length, totalCandidates: totalNew, report: report, checkedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error('[discover-scan] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
