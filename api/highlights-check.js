// api/highlights-check.js
// Travelgenix Luna Chat — lightweight "should this page auto-takeover?" check.
//
// Called by the widget on every page load. Returns:
//   { hasOverride: true }   → widget should auto-open in expanded mode
//   { hasOverride: false }  → widget should sit quietly in the corner as normal
//
// This is intentionally tiny so it can run on every page without dragging the
// page load. It does NOT generate any card content — it only answers the
// question "is this page configured for takeover?".
//
// Resolution:
//   1. Redis cache (60s TTL — short, because Andy may add/remove overrides
//      and expect a near-immediate effect on the demo site)
//   2. Airtable lookup (Active=TRUE AND Page Path matches, maxRecords=1)
//
// Hard fails are silent: if Airtable or Redis are down, returns
// { hasOverride: false } so the widget falls back to manual triggers.

'use strict';

const AT_BASE = 'app6Ot3eOb3DangkB';
const OVERRIDES_TABLE_ID = 'tblh4qgTW3yuDaTbu';
const CACHE_KEY_PREFIX = 'highlights-check:v1:';
const CACHE_TTL_SECONDS = 60;

// CORS allowlist — same as highlights-card endpoint
const CORS_ALLOWED = [
  'https://www.traveldemo.site',
  'https://traveldemo.site',
  'https://www.travelgenix.io',
  'https://travelgenix.io'
];

function setCors(req, res) {
  var origin = req.headers.origin || '';
  if (CORS_ALLOWED.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── Upstash Redis REST (same pattern as highlights-card.js) ────────────
async function upstashCall(commandParts) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    var fullUrl = url.replace(/\/+$/, '') + '/' +
                  commandParts.map(encodeURIComponent).join('/');
    var res = await fetch(fullUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data && typeof data.result !== 'undefined' ? data.result : null;
  } catch (err) {
    return null;
  }
}

async function cacheGet(path) {
  return upstashCall(['GET', CACHE_KEY_PREFIX + path]);
}

async function cacheSet(path, value) {
  try {
    await upstashCall(['SET', CACHE_KEY_PREFIX + path, value, 'EX', String(CACHE_TTL_SECONDS)]);
  } catch (err) { /* silent */ }
}

// ─── Airtable lookup — Active=TRUE AND Page Path matches ────────────────
async function lookupHasOverride(path) {
  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return false;

  try {
    var p = path.toLowerCase();
    var formula = "AND({Active}=TRUE(), LOWER({Page Path})='" + p.replace(/'/g, "\\'") + "')";
    var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + OVERRIDES_TABLE_ID +
              '?filterByFormula=' + encodeURIComponent(formula) +
              '&maxRecords=1' +
              '&fields%5B%5D=Page%20Path'; // only fetch the primary field — minimal payload

    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + atKey },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return false;
    var data = await res.json();
    return !!(data && data.records && data.records.length);
  } catch (err) {
    console.warn('[highlights-check] Airtable lookup failed:', err.message);
    return false;
  }
}

// ─── Main handler ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read & validate path param
  var rawPath = (req.query && req.query.path) || '';
  if (typeof rawPath !== 'string') rawPath = String(rawPath || '');
  rawPath = rawPath.trim();

  // Basic safety: reject if it doesn't start with "/" or is too long.
  // Strip anything after a ? or # (we want pathname only).
  if (!rawPath || rawPath[0] !== '/' || rawPath.length > 300) {
    return res.status(200).json({ hasOverride: false, reason: 'invalid-path' });
  }
  rawPath = rawPath.split('?')[0].split('#')[0];

  // Cache lookup
  try {
    var cached = await cacheGet(rawPath);
    if (cached === '1') {
      res.setHeader('X-Highlights-Check-Cache', 'hit');
      return res.status(200).json({ hasOverride: true });
    }
    if (cached === '0') {
      res.setHeader('X-Highlights-Check-Cache', 'hit');
      return res.status(200).json({ hasOverride: false });
    }
  } catch (e) { /* cache miss treated as not-cached */ }

  // Airtable lookup
  var hasOverride = await lookupHasOverride(rawPath);

  // Write cache (don't await — fire and forget on Vercel is fine for SET ops)
  cacheSet(rawPath, hasOverride ? '1' : '0').catch(function(){});

  res.setHeader('X-Highlights-Check-Cache', 'miss');
  return res.status(200).json({ hasOverride: !!hasOverride });
};
