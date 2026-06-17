// api/reverify-structured.js
// Anti-staleness re-verification for the STRUCTURED fields of the Destinations
// and Transport tables (currency, emergency number, plug type, driving side,
// visa, IATA code, etc.) — the columns the Q&A re-verifier (api/reverify) does
// not cover.
//
// These tables are columns, not Q&A, and carry no cited Source, so we re-verify
// a curated catalogue of CRISP, corroborate-able facts (lib/reverify FIELD_
// CATALOG) by turning each field value into a question and grounding it in
// INDEPENDENT web sources via the same fail-safe checker. Per row, per run:
//   - all checked facts hold (>= min confirmations, none contradicted) -> reset
//     that row's Last Verified (it is still accurate). One authoritative source
//     (gov/official/LUNA_TRUSTED_DOMAINS) is enough; otherwise two are needed.
//   - a fact is contradicted by a source -> queue a "changed" flag in the
//     Knowledge Reverification table (Target Table/Field set) with the current
//     value, the source-grounded suggestion and the evidence, for a human to
//     apply. We NEVER auto-overwrite a curated structured field.
//   - nothing corroborated -> leave it, retry a later run.
//
// It NEVER invents a value (any malformed/uncertain model reply parses to
// "unverifiable"). Bounded + paced (default 6 oldest rows/run) so cost/time stay
// predictable and Tavily free-tier usage stays low; it chips through oldest-first.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports what
// it WOULD reset/flag and writes nothing. Env: CRON_SECRET, AIRTABLE_KEY,
// ANTHROPIC_API_KEY, TAVILY_API_KEY. Optional: REVERIFY_MODEL,
// REVERIFY_STRUCT_LIMIT, REVERIFY_STRUCT_FIELDS, REVERIFY_STRUCT_MIN_CONFIRM,
// REVERIFY_STRUCT_TABLES, LUNA_TRUSTED_DOMAINS.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const reverify = require('../lib/reverify');
const search = require('../lib/search');
const trusted = require('../lib/trusted-sources');
const gk = require('../lib/global-knowledge');

const MODEL = process.env.REVERIFY_MODEL || 'claude-haiku-4-5-20251001';
const STRUCT_LIMIT = parseInt(process.env.REVERIFY_STRUCT_LIMIT || '6', 10);        // rows/run across tables
const STRUCT_FIELDS = parseInt(process.env.REVERIFY_STRUCT_FIELDS || '6', 10);      // checked fields/row
const MIN_CONFIRM = parseInt(process.env.REVERIFY_STRUCT_MIN_CONFIRM || '2', 10);   // confirms to reset (1 if authoritative)
const ROW_CONCURRENCY = parseInt(process.env.REVERIFY_STRUCT_CONCURRENCY || '4', 10);
const TABLES = (process.env.REVERIFY_STRUCT_TABLES || 'Destinations,Transport').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

function tableId(name) { return name === 'Transport' ? gk.TRANSPORT_TABLE : gk.DESTINATIONS_TABLE; }

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

// Run async fn over items with bounded concurrency; per-item errors captured.
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

// (rowId|field) pairs already Pending in the queue for structured tables, so we
// never raise a duplicate flag for the same field.
async function loadQueuedStruct() {
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

// Oldest-verified rows of a table with the catalogue field values attached.
async function loadStaleRows(table, limit) {
  var fields = ['Name', 'Country', 'Last Verified'].concat(reverify.catalogFields(table));
  var q = fields.map(function (f) { return 'fields%5B%5D=' + encodeURIComponent(f); }).join('&');
  var data = await atFetch('/' + tableId(table)
    + '?' + q
    + '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent('Last Verified') + '&sort%5B0%5D%5Bdirection%5D=asc'
    + '&maxRecords=' + limit);
  return (data.records || []).map(function (rec) {
    var f = rec.fields || {};
    var values = {};
    reverify.catalogFields(table).forEach(function (fld) { values[fld] = f[fld]; });
    return { id: rec.id, table: table, name: f['Name'] || '', country: f['Country'] || '', lastVerified: f['Last Verified'] || null, values: values };
  });
}

function buildQuery(table, row) {
  var loc = row.name + (row.country && row.country.toLowerCase() !== row.name.toLowerCase() ? ', ' + row.country : '');
  if (table === 'Transport') return (loc + ' IATA code city country location').slice(0, 360);
  return (loc + ' travel facts currency electricity plug voltage emergency number driving side dialling code time zone visa').slice(0, 360);
}

// One web search + a grounded check of each (queued-skipped) catalogue field for
// a row against the combined independent-source text. Never throws.
async function checkRow(anthropic, row, queued, extraTrusted) {
  var recs = [];
  reverify.catalogFields(row.table).forEach(function (field) {
    if (recs.length >= STRUCT_FIELDS) return;
    if (queued[row.id + '|' + field]) return;            // already flagged
    var rec = reverify.buildFieldRecord(row.table, field, row.name, row.values[field]);
    if (rec) recs.push(rec);
  });
  if (!recs.length) return { row: row, checks: [], note: 'no_checkable_fields' };

  var sr = await search.search(buildQuery(row.table, row), { maxResults: 6, timeoutMs: 7000 });
  if (!sr.ok || !sr.results || !sr.results.length) {
    return { row: row, checks: [], note: sr.ok ? 'no_results' : ('search_' + (sr.error || 'fail') + (sr.httpStatus ? ('_' + sr.httpStatus) : '')) };
  }

  // Top independent domains -> concatenated source text + authoritative signal.
  var seen = {}, domains = [], text = '';
  sr.results.forEach(function (r) {
    var d = search.registrableDomain(r.url);
    if (!d || seen[d]) return;
    seen[d] = 1; domains.push({ domain: d, url: r.url });
    if (text.length < 9000) text += '\n[' + d + ']\n' + (r.rawContent || r.content || '');
  });
  var authoritative = domains.some(function (x) { return trusted.isTrusted(x.url, extraTrusted).trusted; });
  var primaryUrl = (domains[0] && domains[0].url) || '';

  // Grounded check per field, sequentially (keeps in-flight model calls low while
  // rows run concurrently). Reuses the same fail-safe checker + verdict parser.
  var checks = [];
  for (var i = 0; i < recs.length; i++) {
    var rec = recs[i];
    var prompt = reverify.buildVerificationPrompt({ question: rec.question, answer: rec.answer, sourceUrl: primaryUrl }, text, { sourceUrl: primaryUrl });
    var resp = await anthropic.messages.create({ model: MODEL, max_tokens: 500, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] });
    var t = '';
    if (resp && resp.content) { for (var j = 0; j < resp.content.length; j++) { if (resp.content[j].type === 'text') t += resp.content[j].text; } }
    var v = reverify.parseVerdict(t);
    checks.push({ field: rec.field, current: rec.answer, verdict: v.verdict, suggestion: v.suggestedAnswer, evidence: v.evidence });
  }
  return { row: row, checks: checks, domains: domains.map(function (d) { return d.domain; }), authoritative: authoritative, sourceUrl: primaryUrl };
}

async function applyResets(byTable, today) {
  for (var table in byTable) {
    if (!byTable.hasOwnProperty(table)) continue;
    var ids = byTable[table];
    for (var i = 0; i < ids.length; i += 10) {
      var recs = ids.slice(i, i + 10).map(function (id) { return { id: id, fields: { 'Last Verified': today } }; });
      await atFetch('/' + tableId(table), { method: 'PATCH', body: { records: recs, typecast: true } });
    }
  }
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
  if (!process.env.TAVILY_API_KEY) return res.status(200).json({ ok: true, skipped: 'no TAVILY_API_KEY (structured re-verify needs web corroboration)' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  var nowIso = new Date().toISOString();
  var today = nowIso.split('T')[0];

  try {
    var extraTrusted = trusted.parseDomainList(process.env.LUNA_TRUSTED_DOMAINS || '');
    var queued = await loadQueuedStruct();

    // Pull the oldest-verified rows from each configured table, then take the
    // genuinely-oldest STRUCT_LIMIT across all of them.
    var pool = [];
    for (var ti = 0; ti < TABLES.length; ti++) {
      if (!reverify.catalogFields(TABLES[ti]).length) continue;
      var rows = await loadStaleRows(TABLES[ti], STRUCT_LIMIT);
      pool = pool.concat(rows);
    }
    pool.sort(function (a, b) { return (Date.parse(a.lastVerified) || 0) - (Date.parse(b.lastVerified) || 0); });
    var batch = pool.slice(0, STRUCT_LIMIT);

    var results = await mapLimit(batch, ROW_CONCURRENCY, function (row) { return checkRow(anthropic, row, queued, extraTrusted); });

    var counts = { rows: batch.length, fieldsChecked: 0, confirmed: 0, changed: 0, unverifiable: 0, rowsReset: 0, fieldsFlagged: 0, rowsNoSource: 0 };
    var resetsByTable = {};
    var queueAcc = [];
    var report = [];

    results.forEach(function (r) {
      if (!r || r.__error || !r.row) { if (r && r.__error) report.push({ error: r.__error }); return; }
      var row = r.row;
      var checks = r.checks || [];
      counts.fieldsChecked += checks.length;
      if (!checks.length) { counts.rowsNoSource++; report.push({ table: row.table, name: row.name, note: r.note || 'no_checks' }); return; }

      var confirmed = 0, changed = [];
      checks.forEach(function (c) {
        counts[c.verdict] = (counts[c.verdict] || 0) + 1;
        if (c.verdict === 'confirmed') confirmed++;
        else if (c.verdict === 'changed') changed.push(c);
      });

      if (changed.length) {
        changed.forEach(function (c) {
          queueAcc.push({ fields: {
            'Question': c.field + ' for ' + row.name,
            'Knowledge Record ID': row.id,
            'Target Table': row.table,
            'Target Field': c.field,
            'Verdict': 'changed',
            'Current Answer': c.current,
            'Suggested Answer': c.suggestion,
            'Evidence': c.evidence,
            'Source URL': r.sourceUrl || '',
            'Status': 'Pending',
            'Checked At': nowIso,
            'Category': row.table
          } });
        });
        counts.fieldsFlagged += changed.length;
        report.push({ table: row.table, name: row.name, action: 'flagged', fields: changed.map(function (c) { return c.field; }), confirmed: confirmed });
      } else {
        var effMin = r.authoritative ? 1 : MIN_CONFIRM;
        if (confirmed >= effMin) {
          (resetsByTable[row.table] = resetsByTable[row.table] || []).push(row.id);
          counts.rowsReset++;
          report.push({ table: row.table, name: row.name, action: 'reverified', confirmed: confirmed, authoritative: !!r.authoritative });
        } else {
          report.push({ table: row.table, name: row.name, action: 'inconclusive', confirmed: confirmed, domains: r.domains });
        }
      }
    });

    if (!dryRun) {
      if (Object.keys(resetsByTable).length) await applyResets(resetsByTable, today);
      if (queueAcc.length) await queueRows(queueAcc);
      if (counts.rowsReset > 0 || counts.fieldsFlagged > 0) {
        await tgSend('Luna structured re-verify: confirmed ' + counts.rowsReset + ' row(s); flagged ' + counts.fieldsFlagged + ' field(s) for review.');
      }
    }

    return res.status(200).json({ ok: true, dryRun: !!dryRun, tables: TABLES, counts: counts, report: report, checkedAt: nowIso });
  } catch (e) {
    console.error('[reverify-structured] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
