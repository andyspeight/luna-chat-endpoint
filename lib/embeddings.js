// lib/embeddings.js
// Embeddings client for semantic search. Provider: Voyage AI (Anthropic's
// recommended embeddings partner). Model voyage-3.5-lite, 1024 dimensions.
//
// Pure transport wrapper: never throws, returns { ok, vectors|vector, error }.
// The same model + dimension MUST be used for indexing and querying, so both
// paths import these constants. Env VOYAGE_API_KEY required; absent => no-op.

'use strict';

var MODEL = process.env.EMBED_MODEL || 'voyage-3.5-lite';
var DIM = parseInt(process.env.EMBED_DIM || '1024', 10);
var ENDPOINT = process.env.VOYAGE_ENDPOINT || 'https://api.voyageai.com/v1/embeddings';

function configured() { return !!process.env.VOYAGE_API_KEY; }

// Embed an array of texts. input_type: 'document' (indexing) or 'query' (search)
// — Voyage uses this to optimise retrieval. Never throws.
async function embed(texts, opts) {
  opts = opts || {};
  var key = opts.apiKey || process.env.VOYAGE_API_KEY;
  if (!key) return { ok: false, error: 'no_key', vectors: [] };
  var input = Array.isArray(texts) ? texts : [texts];
  input = input.map(function (t) { return String(t == null ? '' : t).slice(0, 24000); });
  if (!input.length) return { ok: true, vectors: [] };
  try {
    var r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: input,
        model: opts.model || MODEL,
        input_type: opts.inputType || 'document',
        output_dimension: opts.dim || DIM,
        truncation: true
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    });
    if (!r.ok) {
      var detail = await r.text().catch(function () { return ''; });
      return { ok: false, httpStatus: r.status, error: 'http_' + r.status, detail: detail.slice(0, 300), vectors: [] };
    }
    var json = await r.json();
    var data = (json && json.data) || [];
    // Voyage returns data with an explicit index; map defensively so order holds.
    var vectors = new Array(input.length);
    data.forEach(function (d) { if (d && typeof d.index === 'number') vectors[d.index] = d.embedding; });
    return { ok: true, vectors: vectors, model: opts.model || MODEL, dim: opts.dim || DIM };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed', vectors: [] };
  }
}

// Embed a single query string -> vector, or null on any failure.
async function embedQuery(text, opts) {
  var res = await embed([text], Object.assign({ inputType: 'query' }, opts || {}));
  return (res.ok && res.vectors && res.vectors[0]) ? res.vectors[0] : null;
}

module.exports = { MODEL: MODEL, DIM: DIM, configured: configured, embed: embed, embedQuery: embedQuery };
