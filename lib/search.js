// lib/search.js
// Web search connector (Tavily) used to find INDEPENDENT corroborating sources
// for a fact whose own cited source is not authoritative. Tavily returns page
// content directly, so we get source text to ground-check without scraping each
// result (and without hitting the 403 walls that block our scraper).
//
// Auth: free key at tavily.com. Set TAVILY_API_KEY in env; absent => no-op.

'use strict';

var ENDPOINT = 'https://api.tavily.com/search';

function buildSearchBody(query, opts) {
  opts = opts || {};
  return {
    api_key: opts.apikey || process.env.TAVILY_API_KEY || '',
    query: String(query || '').slice(0, 380),
    max_results: opts.maxResults || 6,
    search_depth: opts.depth || 'basic',
    include_answer: false,
    include_raw_content: false
  };
}

function parseResults(json) {
  var results = (json && json.results) || [];
  return results.map(function (r) {
    return { title: (r.title || '').trim(), url: r.url || '', content: (r.content || '').trim() };
  }).filter(function (r) { return r.url && r.content; });
}

// Registrable domain (eTLD+1 approximation), so two results from the same site
// (news.bbc.co.uk and bbc.co.uk) count as ONE source, not two.
var MULTI_PART_TLDS = { 'co.uk': 1, 'org.uk': 1, 'gov.uk': 1, 'ac.uk': 1, 'com.au': 1, 'co.nz': 1, 'co.za': 1, 'com.br': 1, 'co.jp': 1 };
function registrableDomain(url) {
  var host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  var parts = host.split('.');
  if (parts.length <= 2) return host;
  var lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS[lastTwo]) return parts.slice(-3).join('.');
  return lastTwo;
}

// Run a search. Returns { ok, results, error }. Never throws.
async function search(query, opts) {
  opts = opts || {};
  var apikey = opts.apikey || process.env.TAVILY_API_KEY;
  if (!apikey) return { ok: false, error: 'no_key' };
  if (!query) return { ok: false, error: 'no_query' };
  try {
    var r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSearchBody(query, opts)),
      signal: AbortSignal.timeout(opts.timeoutMs || 8000)
    });
    if (!r.ok) return { ok: false, httpStatus: r.status, error: 'http_' + r.status };
    var json = await r.json();
    return { ok: true, results: parseResults(json) };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed' };
  }
}

module.exports = {
  ENDPOINT: ENDPOINT,
  buildSearchBody: buildSearchBody,
  parseResults: parseResults,
  registrableDomain: registrableDomain,
  search: search
};
