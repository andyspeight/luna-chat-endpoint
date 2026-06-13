// Luna FCDO travel-advice module
//
// Fetches the UK Foreign, Commonwealth and Development Office (FCDO) travel
// advice for a country from the GOV.UK Content API and turns it into a compact,
// VERBATIM card payload: the official alert status, the date it was last
// updated, and a link to the full advice. Cached in Upstash so message-time is
// fast and we are gentle on GOV.UK.
//
// CRITICAL SAFETY POSTURE: this module is the ONLY source of FCDO status text.
// Luna (the model) must never assess safety or state whether travel is advised
// against. The status strings here are the OFFICIAL FCDO phrasings, derived
// mechanically from the GOV.UK "alert_status" codes. We never paraphrase a
// government safety judgement into something softer or harder, and we never
// invent one: if FCDO gives no alert, we say exactly that and link out.
//
// Used by: api/fcdo.js (widget-facing card + cron warm) and, downstream, the
// Luna Brain internal "elevated advice" awareness panel.

'use strict';

// GOV.UK Content API. Returns JSON; stable, public, no key required.
var CONTENT_API = 'https://www.gov.uk/api/content/foreign-travel-advice/';
// The human-facing advice page (what we link visitors to).
var ADVICE_PAGE = 'https://www.gov.uk/foreign-travel-advice/';

// Official FCDO alert_status codes -> the exact official phrasing. These are the
// only safety sentences we will ever show. Order in OUTPUT follows severity.
// Severity level is used only for the internal agency signal, never shown as a
// number to visitors.
var ALERT_STATUS = {
  avoid_all_travel_to_whole_country: {
    level: 4,
    text: 'The FCDO advises against all travel to the whole country.'
  },
  avoid_all_but_essential_travel_to_whole_country: {
    level: 3,
    text: 'The FCDO advises against all but essential travel to the whole country.'
  },
  avoid_all_travel_to_parts: {
    level: 2,
    text: 'The FCDO advises against all travel to parts of the country.'
  },
  avoid_all_but_essential_travel_to_parts: {
    level: 1,
    text: 'The FCDO advises against all but essential travel to parts of the country.'
  }
};

// Slug overrides where a plain normalisation would not match the GOV.UK path.
// Conservative on purpose; the normaliser handles the long tail, and a wrong
// slug simply yields no card (the endpoint 404-handles gracefully).
var SLUG_OVERRIDES = {
  'usa': 'usa',
  'united states': 'usa',
  'united states of america': 'usa',
  'america': 'usa',
  'uae': 'uae',
  'united arab emirates': 'uae',
  'gambia': 'the-gambia',
  'the gambia': 'the-gambia',
  'ivory coast': 'ivory-coast',
  "cote d'ivoire": 'ivory-coast',
  'czech republic': 'czech-republic',
  'czechia': 'czech-republic',
  'south korea': 'south-korea',
  'north korea': 'north-korea',
  'turkey': 'turkey',
  'turkiye': 'turkey',
  'drc': 'democratic-republic-of-the-congo',
  'democratic republic of congo': 'democratic-republic-of-the-congo',
  'congo': 'congo',
  'myanmar': 'myanmar-burma',
  'burma': 'myanmar-burma'
};

// Normalise a country display name to a GOV.UK advice slug.
function slugForCountry(name) {
  if (!name || typeof name !== 'string') return null;
  var key = name.trim().toLowerCase();
  if (SLUG_OVERRIDES[key]) return SLUG_OVERRIDES[key];
  var slug = key
    .replace(/&/g, ' and ')
    .replace(/[._']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// Map an alert_status array to official status lines + a severity level.
// FCDO can list more than one code (e.g. both "parts" variants); we de-dupe
// by text and keep the highest severity for the internal signal.
function mapAlertStatus(alertStatus) {
  var codes = Array.isArray(alertStatus) ? alertStatus : [];
  var seen = {};
  var lines = [];
  var level = 0;
  codes.forEach(function (code) {
    var entry = ALERT_STATUS[code];
    if (!entry) return; // ignore unknown codes rather than guessing their meaning
    if (!seen[entry.text]) { seen[entry.text] = 1; lines.push(entry.text); }
    if (entry.level > level) level = entry.level;
  });
  // Sort lines by descending severity so the strongest warning leads.
  lines.sort(function (a, b) {
    var sa = 0, sb = 0;
    Object.keys(ALERT_STATUS).forEach(function (k) {
      if (ALERT_STATUS[k].text === a) sa = ALERT_STATUS[k].level;
      if (ALERT_STATUS[k].text === b) sb = ALERT_STATUS[k].level;
    });
    return sb - sa;
  });
  return { lines: lines, level: level };
}

// Turn a GOV.UK Content API JSON document into the verbatim card payload.
// Pure and side-effect free, so it can be unit-tested against captured samples.
function parseAdvice(json, displayName, slug) {
  json = json || {};
  var details = json.details || {};
  var mapped = mapAlertStatus(details.alert_status);

  var noWarning = mapped.lines.length === 0;
  // The single sentence the card leads with. Either the official warning(s),
  // or, when there is no blanket warning, a neutral pointer. We NEVER say a
  // place "is safe"; absence of a warning is not an endorsement.
  var statusLines = noWarning
    ? ['The FCDO has no blanket warning against travel here. Always read the full advice before you book.']
    : mapped.lines;

  return {
    country: displayName || json.title || slug || '',
    slug: slug || null,
    hasWarning: !noWarning,
    level: mapped.level,                 // 0..4, internal severity signal only
    statusLines: statusLines,            // official FCDO phrasing, verbatim
    lastUpdated: json.public_updated_at || json.updated_at || null,
    reviewedAt: details.reviewed_at || null,
    url: slug ? (ADVICE_PAGE + slug) : ADVICE_PAGE.replace(/\/$/, ''),
    source: 'UK FCDO'
  };
}

// ── Upstash cache (same direct-REST pattern as highlights-card.js) ───────────
var CACHE_PREFIX = 'fcdo:v1:';
var CACHE_TTL = 6 * 60 * 60; // 6 hours

async function upstash(commandParts) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    var full = url.replace(/\/+$/, '') + '/' + commandParts.map(encodeURIComponent).join('/');
    var res = await fetch(full, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data && typeof data.result !== 'undefined' ? data.result : null;
  } catch (e) {
    return null;
  }
}

async function getCached(slug) {
  var raw = await upstash(['GET', CACHE_PREFIX + slug]);
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function setCached(slug, payload) {
  try {
    await upstash(['SET', CACHE_PREFIX + slug, JSON.stringify(payload), 'EX', String(CACHE_TTL)]);
  } catch (e) { /* cache is best-effort */ }
}

// Fetch (or serve cached) FCDO advice for a country. Returns the card payload,
// or { notFound: true } when GOV.UK has no advice page for that slug, or
// { error } on transient failure. Never throws into the caller's request path.
async function getAdvice(countryName, opts) {
  opts = opts || {};
  var slug = opts.slug || slugForCountry(countryName);
  if (!slug) return { error: 'no_slug' };

  if (!opts.forceFresh) {
    var cached = await getCached(slug);
    if (cached) return Object.assign({ fromCache: true }, cached);
  }

  try {
    var r = await fetch(CONTENT_API + encodeURIComponent(slug), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LunaBot/1.0 (+https://travelgenix.io)'
      },
      signal: AbortSignal.timeout(opts.timeoutMs || 6000)
    });
    if (r.status === 404) return { notFound: true, slug: slug };
    if (!r.ok) return { error: 'http_' + r.status, slug: slug };
    var json = await r.json();
    var payload = parseAdvice(json, countryName, slug);
    await setCached(slug, payload);
    return Object.assign({ fromCache: false }, payload);
  } catch (e) {
    return { error: 'fetch_failed', detail: e.message, slug: slug };
  }
}

module.exports = {
  ALERT_STATUS: ALERT_STATUS,
  SLUG_OVERRIDES: SLUG_OVERRIDES,
  slugForCountry: slugForCountry,
  mapAlertStatus: mapAlertStatus,
  parseAdvice: parseAdvice,
  getAdvice: getAdvice,
  CONTENT_API: CONTENT_API,
  ADVICE_PAGE: ADVICE_PAGE
};
