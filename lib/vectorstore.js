// lib/vectorstore.js
// Thin client for the Supabase pgvector store (project "Luna Agents"), via the
// PostgREST REST API so there is no extra npm dependency. Server-only: uses the
// service-role key (table RLS blocks anon). Every call is fail-safe (never
// throws) so a store outage can never break the chat path — callers fall back to
// keyword search.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Absent => ready() is false (no-op).

'use strict';

var TABLE = 'kb_embeddings';

function cfg(opts) {
  opts = opts || {};
  return { url: opts.url || process.env.SUPABASE_URL, key: opts.key || process.env.SUPABASE_SERVICE_KEY };
}

function ready(opts) { var c = cfg(opts); return !!(c.url && c.key); }

function headers(c, extra) {
  return Object.assign({ 'apikey': c.key, 'Authorization': 'Bearer ' + c.key }, extra || {});
}

// Upsert embedding rows (merge on primary key id). Never throws.
async function upsert(rows, opts) {
  opts = opts || {};
  var c = cfg(opts);
  if (!c.url || !c.key) return { ok: false, error: 'not_configured', count: 0 };
  if (!rows || !rows.length) return { ok: true, count: 0 };
  try {
    var nowIso = new Date().toISOString();
    var body = rows.map(function (x) { return Object.assign({ updated_at: nowIso }, x); });
    var r = await fetch(c.url + '/rest/v1/' + TABLE, {
      method: 'POST',
      headers: headers(c, { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    });
    if (!r.ok) { var d = await r.text().catch(function () { return ''; }); return { ok: false, httpStatus: r.status, error: 'http_' + r.status, detail: d.slice(0, 300), count: 0 }; }
    return { ok: true, count: rows.length };
  } catch (e) { return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed', count: 0 }; }
}

// Map of id -> content_hash for every stored row (to skip unchanged rows when
// indexing). Paginated via Range headers. Returns {} on any failure.
async function loadHashes(opts) {
  opts = opts || {};
  var c = cfg(opts);
  if (!c.url || !c.key) return {};
  var out = {}, from = 0, page = 1000;
  try {
    for (var i = 0; i < 50; i++) {
      var r = await fetch(c.url + '/rest/v1/' + TABLE + '?select=id,content_hash', {
        headers: headers(c, { 'Range-Unit': 'items', 'Range': from + '-' + (from + page - 1) }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) break;
      var arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) break;
      arr.forEach(function (x) { out[x.id] = x.content_hash; });
      if (arr.length < page) break;
      from += page;
    }
  } catch (e) { /* return whatever we have */ }
  return out;
}

// Every stored id (for prune detection). Returns [] on failure.
async function allIds(opts) {
  var h = await loadHashes(opts);
  return Object.keys(h);
}

// Delete a set of ids (PostgREST in.(...) filter), batched. Never throws.
async function deleteIds(ids, opts) {
  opts = opts || {};
  var c = cfg(opts);
  if (!c.url || !c.key || !ids || !ids.length) return { ok: true, count: 0 };
  var done = 0;
  try {
    for (var i = 0; i < ids.length; i += 100) {
      var slice = ids.slice(i, i + 100);
      var inList = '(' + slice.map(function (id) { return '"' + String(id).replace(/[",()]/g, '') + '"'; }).join(',') + ')';
      var r = await fetch(c.url + '/rest/v1/' + TABLE + '?id=in.' + encodeURIComponent(inList), {
        method: 'DELETE', headers: headers(c, { 'Prefer': 'return=minimal' }), signal: AbortSignal.timeout(15000)
      });
      if (r.ok) done += slice.length;
    }
    return { ok: true, count: done };
  } catch (e) { return { ok: false, error: 'fetch_failed', count: done }; }
}

// Cosine-similarity search via the match_kb RPC. Returns
// { ok, results:[{id,table_name,name,question,content,source,similarity}] }.
async function match(queryEmbedding, opts) {
  opts = opts || {};
  var c = cfg(opts);
  if (!c.url || !c.key) return { ok: false, error: 'not_configured', results: [] };
  if (!queryEmbedding || !queryEmbedding.length) return { ok: false, error: 'no_embedding', results: [] };
  try {
    var r = await fetch(c.url + '/rest/v1/rpc/match_kb', {
      method: 'POST',
      headers: headers(c, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: opts.matchCount || 8,
        min_similarity: opts.minSimilarity != null ? opts.minSimilarity : 0.0
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 8000)
    });
    if (!r.ok) { var d = await r.text().catch(function () { return ''; }); return { ok: false, httpStatus: r.status, error: 'http_' + r.status, detail: d.slice(0, 300), results: [] }; }
    var json = await r.json();
    return { ok: true, results: Array.isArray(json) ? json : [] };
  } catch (e) { return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed', results: [] }; }
}

module.exports = { TABLE: TABLE, ready: ready, upsert: upsert, loadHashes: loadHashes, allIds: allIds, deleteIds: deleteIds, match: match };
