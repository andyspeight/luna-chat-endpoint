// api/fcdo.js
// Widget-facing FCDO travel-advice card endpoint.
//
// GET /api/fcdo?country=Turkey
//   -> { ok: true, card: { country, statusLines, hasWarning, lastUpdated, url, source } }
//   -> { ok: false, reason } when GOV.UK has no page or a transient error occurs
//      (the widget then simply shows nothing extra; Luna's own FCDO signpost stays).
//
// The card text is sourced VERBATIM from FCDO via lib/fcdo.js. The chat model is
// never in this path, so there is no way for Luna to invent or soften a safety
// assessment. This is the deliberate, owner-approved way to surface the official
// status alongside Luna's existing signpost.
//
// Cron warm: GET /api/fcdo?warm=1&secret=<CRON_SECRET>
//   Pre-fetches advice for the countries in LUNA_FCDO_WARM_COUNTRIES (comma list)
//   or ?countries=France,Spain, so visitor lookups are always a warm cache hit.
//
// Env: UPSTASH_REDIS_REST_URL/TOKEN (cache + rate limit, optional),
//      CRON_SECRET (warm auth), LUNA_FCDO_WARM_COUNTRIES (optional warm list).

'use strict';

const fcdo = require('../lib/fcdo');

const ALLOWED_ORIGINS = [
  'https://traveldemo.site',
  'https://www.traveldemo.site',
  'https://travelgenix.io',
  'https://www.travelgenix.io'
];

function setCors(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1 || origin.endsWith('.site.travelify.io')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Light per-IP rate limit via direct Upstash INCR (same shape as highlights-card).
async function upstash(commandParts) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    var full = url.replace(/\/+$/, '') + '/' + commandParts.map(encodeURIComponent).join('/');
    var r = await fetch(full, { headers: { 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    var data = await r.json();
    return data && typeof data.result !== 'undefined' ? data.result : null;
  } catch (e) { return null; }
}

async function rateLimited(req) {
  try {
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    var key = 'fcdo:rl:' + ip;
    var count = await upstash(['INCR', key]);
    if (count === 1) await upstash(['EXPIRE', key, '3600']);
    return typeof count === 'number' && count > 60; // 60 lookups/hour/IP
  } catch (e) { return false; } // never block on limiter failure
}

function sanitiseCountry(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^\p{L}\p{N}&'.\- ]/gu, '').trim().slice(0, 60);
}

// Trim the payload to exactly what the widget renders, so we never leak more
// than the official status, the date, and the link.
function toCard(advice) {
  return {
    country: advice.country,
    hasWarning: advice.hasWarning,
    statusLines: advice.statusLines,
    lastUpdated: advice.lastUpdated,
    reviewedAt: advice.reviewedAt,
    url: advice.url,
    source: advice.source
  };
}

async function handleWarm(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  var authed = secret && (auth === 'Bearer ' + secret || qSecret === secret);
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  var listRaw = (req.query.countries || process.env.LUNA_FCDO_WARM_COUNTRIES || '').trim();
  var countries = listRaw ? listRaw.split(',').map(function (c) { return c.trim(); }).filter(Boolean).slice(0, 60) : [];
  if (!countries.length) return res.status(200).json({ ok: true, warmed: 0, note: 'no countries configured' });

  var results = [];
  for (var i = 0; i < countries.length; i++) {
    var a = await fcdo.getAdvice(countries[i], { forceFresh: true });
    results.push({ country: countries[i], ok: !a.error && !a.notFound, level: a.level != null ? a.level : null });
  }
  return res.status(200).json({ ok: true, warmed: results.filter(function (r) { return r.ok; }).length, results: results });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Cron warm path (auth'd, no CORS concern as it is server-to-server).
  if (req.query && (req.query.warm === '1' || req.query.warm === 'true')) {
    return handleWarm(req, res);
  }

  var country = sanitiseCountry(req.query && req.query.country);
  if (!country) return res.status(400).json({ ok: false, reason: 'missing_country' });

  if (await rateLimited(req)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  try {
    var advice = await fcdo.getAdvice(country);
    if (advice.notFound) return res.status(200).json({ ok: false, reason: 'no_advice_page', country: country });
    if (advice.error) return res.status(200).json({ ok: false, reason: advice.error });
    return res.status(200).json({ ok: true, card: toCard(advice), _meta: { fromCache: !!advice.fromCache } });
  } catch (e) {
    console.error('[fcdo] failed:', e.message);
    return res.status(200).json({ ok: false, reason: 'error' });
  }
};

// Exposed for unit testing only; does not affect the Vercel handler contract.
module.exports.sanitiseCountry = sanitiseCountry;
module.exports.toCard = toCard;
