// api/fill-gaps.js
// Proactive gap filler for the Destinations / Transport structured fields.
//
// reverify-structured re-checks fields that ALREADY have a value. This fills the
// BLANK ones: for each empty catalogue field (currency, capital, dialling code,
// emergency number, plug type, voltage, tap water, visa, time zone; IATA
// code/city/country), it runs one grounded web search and asks the model to
// EXTRACT the value from the fetched source text only (lib/reverify extraction
// mode, never from memory). Each find is staged as a Pending suggestion in the
// Knowledge Reverification queue (Target Table/Field set, the extracted value as
// the Suggested Answer, the quote as Evidence) so it shows up in the review
// dashboard and the daily digest. The owner just approves; nothing is written to
// a destination/airport until they do.
//
// Zero-hallucination guards (all must hold to stage a suggestion):
//   - extraction uses ONLY fetched source text; a malformed/uncertain reply is
//     found:false (never a guess);
//   - the model must return a verbatim evidence quote, AND that quote must
//     actually appear in the fetched source text (so it can't fabricate a quote);
//   - corroboration (authoritative source, or >= 2 independent domains carrying
//     the value) is recorded on the suggestion so the reviewer sees its strength.
//   - never auto-applies. Model-extracted => human-gated, always.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports what
// it WOULD stage and writes nothing.
//
// Env: CRON_SECRET, AIRTABLE_KEY, ANTHROPIC_API_KEY, TAVILY_API_KEY.
//   Optional: REVERIFY_MODEL, FILL_LIMIT (rows/run, default 6),
//   FILL_FIELDS (blank fields/row, default 6), FILL_CONCURRENCY (default 4),
//   FILL_TABLES (default 'Destinations,Transport'), LUNA_TRUSTED_DOMAINS.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const reverify = require('../lib/reverify');
const search = require('../lib/search');
const trusted = require('../lib/trusted-sources');
const gk = require('../lib/global-knowledge');

const MODEL = process.env.REVERIFY_MODEL || 'claude-haiku-4-5-20251001';
const LIMIT = parseInt(process.env.FILL_LIMIT || '6', 10);            // rows/run across tables
const FIELDS = parseInt(process.env.FILL_FIELDS || '6', 10);         // blank fields filled/row
const ROW_CONCURRENCY = parseInt(process.env.FILL_CONCURRENCY || '4', 10);
const SCAN = parseInt(process.env.FILL_SCAN || '120', 10);           // rows scanned for gaps/run
const TABLES = (process.env.FILL_TABLES || 'Destinations,Transport').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

function tableId(name) { return name === 'Transport' ? gk.TRANSPORT_TABLE : gk.DESTINATIONS_TABLE; }

async function atFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + gk.GLOBAL_BASE + path, {
    method: opts.method || 'GET', headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

async function mapLimit(items, limit, fn) {
  var out = new Array(items.length), idx = 0;
  async function worker() {
    while (idx < items.length) {
      var i = idx++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { __error: (e && e.message) || 'error' }; }
    }
  }
  var workers = [], n = Math.min(limit, items.length);
  for (var w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

// (rowId|field) pairs already Pending, so a gap we already suggested is skipped.
async function loadQueued() {
  var queued = {};
  var data = await atFetch('/' + gk.REVERIFICATION_TABLE
    + '?filterByFormula=' + encodeURIComponent("AND({Status}='Pending',{Target Field}!='')")
    + '&fields%5B%5D=Knowledge Record ID&fields%5B%5D=Target Field&maxRecords=1000');
  (data.records || []).forEach(function (r) {
    var f = r.fields || {};
    if (f['Knowledge Record ID'] && f['Target Field']) queued[f['Knowledge Record ID'] + '|' + f['Target Field']] = 1;
  });
  return queued;
}

// Scan a table (oldest-verified first) and return rows that have at least one
// blank, not-already-queued catalogue field, with the list of those fields.
async function loadGapRows(table, queued) {
  var catFields = reverify.catalogFields(table);
  if (!catFields.length) return [];
  var fields = ['Name', 'Country', 'Last Verified'].concat(catFields);
  var q = fields.map(function (f) { return 'fields%5B%5D=' + encodeURIComponent(f); }).join('&');
  var data = await atFetch('/' + tableId(table)
    + '?' + q
    + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Verified') + '&sort%5B0%5D%5Bdirection%5D=asc'
    + '&maxRecords=' + SCAN);
  var out = [];
  (data.records || []).forEach(function (rec) {
    var f = rec.fields || {};
    var name = f['Name'] || '';
    if (!name) return;
    var blanks = catFields.filter(function (fld) {
      return isBlank(f[fld]) && !queued[rec.id + '|' + fld];
    });
    if (blanks.length) out.push({ id: rec.id, table: table, name: name, country: f['Country'] || '', blanks: blanks });
  });
  return out;
}

function buildQuery(table, row) {
  var loc = row.name + (row.country && row.country.toLowerCase() !== row.name.toLowerCase() ? ', ' + row.country : '');
  if (table === 'Transport') return (loc + ' airport IATA code city country').slice(0, 360);
  return (loc + ' travel facts currency electricity plug voltage emergency number driving side dialling code time zone visa tap water').slice(0, 360);
}

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// True if the model's evidence quote genuinely appears in the fetched source
// text (anti-fabrication guard). Uses a leading slice so minor trailing edits
// don't defeat it, but the substance must be present verbatim.
function evidenceInSource(evidence, sourceText) {
  var e = norm(evidence);
  if (e.length < 8) return false;
  var hay = norm(sourceText);
  var needle = e.slice(0, Math.min(60, e.length));
  return hay.indexOf(needle) !== -1;
}

// One search + per-blank-field grounded extraction for a row. Never throws.
async function fillRow(anthropic, row, extraTrusted) {
  var fieldsToFill = row.blanks.slice(0, FIELDS);
  var sr = await search.search(buildQuery(row.table, row), { maxResults: 6, timeoutMs: 7000 });
  if (!sr.ok || !sr.results || !sr.results.length) {
    return { row: row, fills: [], note: sr.ok ? 'no_results' : ('search_' + (sr.error || 'fail') + (sr.httpStatus ? ('_' + sr.httpStatus) : '')) };
  }

  // Independent domains -> per-domain text blocks (for corroboration) + combined.
  var seen = {}, blocks = [], combined = '';
  sr.results.forEach(function (r) {
    var d = search.registrableDomain(r.url);
    if (!d || seen[d]) return;
    seen[d] = 1;
    var body = r.rawContent || r.content || '';
    blocks.push({ domain: d, url: r.url, text: body });
    if (combined.length < 9000) combined += '\n[' + d + ']\n' + body;
  });
  var authoritative = blocks.some(function (b) { return trusted.isTrusted(b.url, extraTrusted).trusted; });
  var primaryUrl = (blocks[0] && blocks[0].url) || '';

  var fills = [];
  for (var i = 0; i < fieldsToFill.length; i++) {
    var field = fieldsToFill[i];
    var question = reverify.buildFieldQuestion(row.table, field, row.name);
    if (!question) continue;
    var prompt = reverify.buildExtractionPrompt(question, combined, { sourceUrl: primaryUrl });
    var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 400, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
    var t = '';
    if (resp && resp.content) { for (var j = 0; j < resp.content.length; j++) { if (resp.content[j].type === 'text') t += resp.content[j].text; } }
    var ex = reverify.parseExtraction(t);
    if (!ex.found) continue;
    // Anti-fabrication: the quote must really be in the fetched text.
    if (!evidenceInSource(ex.evidence, combined)) continue;
    // Corroboration signal: how many independent domains carry the value.
    var vNorm = norm(ex.value);
    var corroboration = blocks.filter(function (b) { return vNorm && norm(b.text).indexOf(vNorm) !== -1; }).length;
    fills.push({ field: field, question: question, value: ex.value, evidence: ex.evidence, corroboration: corroboration });
  }
  return { row: row, fills: fills, authoritative: authoritative, sourceUrl: primaryUrl, domains: blocks.map(function (b) { return b.domain; }) };
}

async function queueRows(rows) {
  for (var i = 0; i < rows.length; i += 10) {
    await atFetch('/' + gk.REVERIFICATION_TABLE, { method: 'POST', body: { records: rows.slice(i, i + 10), typecast: true } });
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
  if (!process.env.TAVILY_API_KEY) return res.status(200).json({ ok: true, skipped: 'no TAVILY_API_KEY (gap fill needs web corroboration)' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var nowIso = new Date().toISOString();

  try {
    var extraTrusted = trusted.parseDomainList(process.env.LUNA_TRUSTED_DOMAINS || '');
    var queued = await loadQueued();

    // Gather gap rows across tables, oldest-first, then take the first LIMIT.
    var pool = [];
    for (var ti = 0; ti < TABLES.length; ti++) {
      var rows = await loadGapRows(TABLES[ti], queued);
      pool = pool.concat(rows);
    }
    var batch = pool.slice(0, LIMIT);

    var results = await mapLimit(batch, ROW_CONCURRENCY, function (row) { return fillRow(anthropic, row, extraTrusted); });

    var counts = { rowsScanned: pool.length, rowsProcessed: batch.length, fieldsAttempted: 0, suggested: 0, rowsNoSource: 0 };
    var queueAcc = [];
    var report = [];

    results.forEach(function (r) {
      if (!r || r.__error || !r.row) { if (r && r.__error) report.push({ error: r.__error }); return; }
      var row = r.row;
      counts.fieldsAttempted += Math.min(row.blanks.length, FIELDS);
      var fills = r.fills || [];
      if (!fills.length) {
        if (r.note) counts.rowsNoSource++;
        report.push({ table: row.table, name: row.name, note: r.note || 'nothing_extractable', blanks: row.blanks });
        return;
      }
      fills.forEach(function (fl) {
        var note = fl.corroboration >= 2 ? ('Corroborated by ' + fl.corroboration + ' independent sources.')
          : (r.authoritative ? 'From an authoritative source.' : 'Single source - please check.');
        queueAcc.push({ fields: {
          'Question': fl.field + ' for ' + row.name,
          'Knowledge Record ID': row.id,
          'Target Table': row.table,
          'Target Field': fl.field,
          'Verdict': 'changed',
          'Current Answer': '(currently blank)',
          'Suggested Answer': fl.value,
          'Evidence': note + ' Source quote: "' + fl.evidence + '"',
          'Source URL': r.sourceUrl || '',
          'Status': 'Pending',
          'Checked At': nowIso,
          'Category': row.table
        } });
      });
      counts.suggested += fills.length;
      report.push({ table: row.table, name: row.name, suggested: fills.map(function (fl) { return { field: fl.field, value: fl.value, corroboration: fl.corroboration }; }) });
    });

    if (!dryRun && queueAcc.length) {
      await queueRows(queueAcc);
      await tgSend('Luna gap fill: staged ' + counts.suggested + ' fact suggestion(s) for review across ' + batch.length + ' row(s).');
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, tables: TABLES, counts: counts, report: report, checkedAt: nowIso });
  } catch (e) {
    console.error('[fill-gaps] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
