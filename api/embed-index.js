// api/embed-index.js
// Builds + refreshes the semantic-search index. Embeds every Knowledge,
// Destinations and Transport row (voyage-3.5-lite) and upserts the vectors into
// the Supabase pgvector store. Incremental: a content hash means only changed or
// new rows are re-embedded each run, so steady-state cost is ~zero. Prunes
// vectors whose source row has gone. Cron-secured + dryRun, like the other jobs.
//
// This job NEVER touches the live chat path or the Airtable knowledge — it only
// writes to the separate vector store. Safe to run anytime.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 reports what
// it WOULD embed and writes nothing. ?full=1 re-embeds everything (ignore hashes).
//
// Env: CRON_SECRET, AIRTABLE_KEY, VOYAGE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
//   Optional: EMBED_MODEL, EMBED_DIM, EMBED_MAX (max rows embedded/run, default 400),
//   EMBED_BATCH (texts per Voyage call, default 96).

'use strict';

const embeddings = require('../lib/embeddings');
const vectorstore = require('../lib/vectorstore');
const kbdoc = require('../lib/kb-doc');

const LB_BASE = 'appPKx77relfeiqmq';
const TABLES = [
  { id: 'tblgdLszaPmquxQ7O', name: 'Knowledge' },
  { id: 'tblirr0vJuQcTLuH2', name: 'Destinations' },
  { id: 'tbl8CRDV48QGjDx2a', name: 'Transport' }
];
const EMBED_MAX = parseInt(process.env.EMBED_MAX || '400', 10);
const BATCH = parseInt(process.env.EMBED_BATCH || '96', 10);

async function atFetch(path) {
  var r = await fetch('https://api.airtable.com/v0/' + LB_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

async function loadAll(tableId) {
  var items = [], offset = null, pages = 0;
  do {
    var path = '/' + tableId + '?pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) { items.push(r); });
    offset = data.offset || null; pages++;
  } while (offset && pages < 80);
  return items;
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Server not configured (AIRTABLE_KEY)' });
  if (!embeddings.configured()) return res.status(200).json({ ok: true, skipped: 'no VOYAGE_API_KEY' });
  if (!vectorstore.ready()) return res.status(200).json({ ok: true, skipped: 'no SUPABASE_URL / SUPABASE_SERVICE_KEY' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var full = req.query && (req.query.full === '1' || req.query.full === 'true');

  try {
    // 1) Build docs for every row across the three tables.
    var docs = [];
    for (var t = 0; t < TABLES.length; t++) {
      var rows = await loadAll(TABLES[t].id);
      rows.forEach(function (rec) {
        var d = kbdoc.buildEmbedDoc(TABLES[t].name, rec);
        if (d) { d.content_hash = kbdoc.contentHash(d.embedText); docs.push(d); }
      });
    }
    var currentIds = {}; docs.forEach(function (d) { currentIds[d.id] = 1; });

    // 2) Diff against what's already stored (by content hash).
    var stored = await vectorstore.loadHashes();
    var changed = docs.filter(function (d) { return full || stored[d.id] !== d.content_hash; });
    var stale = Object.keys(stored).filter(function (id) { return !currentIds[id]; });

    var counts = { scanned: docs.length, alreadyCurrent: docs.length - changed.length, changed: changed.length, stale: stale.length, embedded: 0, upserted: 0, pruned: 0 };

    if (dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, counts: counts, sample: changed.slice(0, 8).map(function (d) { return { table: d.table_name, name: d.name }; }) });
    }

    // 3) Embed + upsert changed rows (oldest-table-first order), capped per run so
    //    wall-time stays under the cron limit; the rest catch up next run.
    var toDo = changed.slice(0, EMBED_MAX);
    for (var i = 0; i < toDo.length; i += BATCH) {
      var slice = toDo.slice(i, i + BATCH);
      var er = await embeddings.embed(slice.map(function (d) { return d.embedText; }), { inputType: 'document', timeoutMs: 25000 });
      if (!er.ok) { return res.status(502).json({ ok: false, error: 'embed_failed:' + er.error, detail: er.detail || '', counts: counts }); }
      var upRows = [];
      slice.forEach(function (d, j) {
        var vec = er.vectors[j];
        if (!vec) return;
        upRows.push({ id: d.id, table_name: d.table_name, name: d.name, question: d.question, content: d.content, source: d.source, content_hash: d.content_hash, embedding: vec });
      });
      counts.embedded += upRows.length;
      var ur = await vectorstore.upsert(upRows);
      if (!ur.ok) { return res.status(502).json({ ok: false, error: 'upsert_failed:' + ur.error, detail: ur.detail || '', counts: counts }); }
      counts.upserted += ur.count;
    }

    // 4) Prune vectors whose source row is gone.
    if (stale.length) { var pr = await vectorstore.deleteIds(stale); counts.pruned = pr.count || 0; }

    counts.remaining = Math.max(0, changed.length - toDo.length);
    return res.status(200).json({ ok: true, dryRun: false, model: embeddings.MODEL, dim: embeddings.DIM, counts: counts });
  } catch (e) {
    console.error('[embed-index] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
