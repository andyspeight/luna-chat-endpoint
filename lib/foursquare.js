// lib/foursquare.js
// Trusted structured source connector: Foursquare Places.
//
// Pulls structured "things to do" (attractions, landmarks, arts) for a
// destination and turns it into a single draft, deterministically (no LLM), so
// the data is never distorted. The draft lands as Pending in Suggested
// Knowledge for human approval. Mirrors the Ticketmaster connector pattern.
//
// Auth: create a free developer account at foursquare.com/developers to get an
// API key. Set FOURSQUARE_API_KEY in env; absent => connector is a no-op.
//
// Host adaptivity (no code change needed if you migrate keys):
//   - default host api.foursquare.com uses the v3 API: GET /v3/places/search,
//     header `Authorization: <key>`.
//   - set FOURSQUARE_HOST=places-api.foursquare.com to use the newer Places API:
//     GET /places/search, header `Authorization: Bearer <key>` plus
//     `X-Places-Api-Version` (FOURSQUARE_API_VERSION, default below).
//
// Location strategy (so we cover ANY destination, not just a coordinate map):
//   1. PRIMARY: Foursquare's text `near` param ("<Name>, <Country>"), which
//      Foursquare geocodes server-side. No lat/lng needed, so it works for every
//      row in the Destinations table.
//   2. FALLBACK (only if the host rejects `near` with HTTP 400, i.e. it is
//      unsupported or ungeocodable): resolve a coordinate ourselves and search
//      by `ll`. We try the built-in CENTROIDS cache first (zero-cost, covers the
//      busiest countries), then a geocoder (lib default: OpenStreetMap
//      Nominatim, free + keyless). Auth/rate errors are surfaced as-is, never
//      retried, since they would only recur on the coordinate path.

'use strict';

// Default to the current Foursquare Places host (new accounts get keys for it).
// Override with FOURSQUARE_HOST=api.foursquare.com for a legacy v3 key.
var DEFAULT_HOST = process.env.FOURSQUARE_HOST || 'places-api.foursquare.com';
var API_VERSION = process.env.FOURSQUARE_API_VERSION || '2025-06-17';
// Bias results toward things to do: Arts & Entertainment + Landmarks & Outdoors.
var DEFAULT_CATEGORIES = process.env.FOURSQUARE_CATEGORIES || '16000,10000';

// Representative coordinates per destination (city centroid). Now only a
// zero-cost FALLBACK cache for the `ll` path; the primary search uses text
// `near` (see buildNearString) so destinations absent here are still covered.
var CENTROIDS = {
  'greece': { lat: 37.9838, lng: 23.7275 },        // Athens
  'spain': { lat: 41.3874, lng: 2.1686 },          // Barcelona
  'portugal': { lat: 38.7223, lng: -9.1393 },      // Lisbon
  'italy': { lat: 41.9028, lng: 12.4964 },         // Rome
  'cyprus': { lat: 34.7720, lng: 32.4297 },        // Paphos
  'malta': { lat: 35.8989, lng: 14.5146 },         // Valletta
  'france': { lat: 48.8566, lng: 2.3522 },         // Paris
  'turkey': { lat: 41.0082, lng: 28.9784 },        // Istanbul
  'turkiye': { lat: 41.0082, lng: 28.9784 },
  'croatia': { lat: 42.6507, lng: 18.0944 },       // Dubrovnik
  'united arab emirates': { lat: 25.2048, lng: 55.2708 }, // Dubai
  'uae': { lat: 25.2048, lng: 55.2708 },
  'united states': { lat: 40.7128, lng: -74.0060 }, // New York
  'usa': { lat: 40.7128, lng: -74.0060 },
  'netherlands': { lat: 52.3676, lng: 4.9041 },    // Amsterdam
  'iceland': { lat: 64.1466, lng: -21.9426 }       // Reykjavik
};

function coordsFor(destination) {
  if (!destination) return null;
  return CENTROIDS[String(destination).trim().toLowerCase()] || null;
}

// Build the Foursquare `near` value: a geocodable "Locality, Country" string.
// When the name already IS the country (country-type Destinations rows) we
// avoid the silly "Greece, Greece" and pass just the name.
function buildNearString(name, country) {
  var n = String(name == null ? '' : name).trim();
  var c = String(country == null ? '' : country).trim();
  if (!n) return c;
  if (!c || n.toLowerCase() === c.toLowerCase()) return n;
  return n + ', ' + c;
}

function isNewApi(host) { return /places-api/.test(host || ''); }

// Build a place-search URL. Pass EITHER opts.near (text, primary) OR
// opts.lat/opts.lng (coordinate fallback). radius only applies to the ll path;
// with `near` Foursquare bounds results to the named locality for us.
function buildSearchUrl(host, opts) {
  var p = new URLSearchParams();
  if (opts.near) {
    p.set('near', opts.near);
  } else {
    p.set('ll', opts.lat + ',' + opts.lng);
    if (opts.radius) p.set('radius', String(opts.radius));
  }
  p.set('limit', String(opts.limit || 10));
  p.set('sort', opts.sort || 'POPULARITY');
  if (opts.categories) p.set('categories', opts.categories);
  var path = isNewApi(host) ? '/places/search' : '/v3/places/search';
  return 'https://' + host + path + '?' + p.toString();
}

function authHeaders(host, key) {
  if (isNewApi(host)) {
    return { 'Authorization': 'Bearer ' + key, 'X-Places-Api-Version': API_VERSION, 'Accept': 'application/json' };
  }
  return { 'Authorization': key, 'Accept': 'application/json' };
}

// Parse the search response into a clean, minimal list. Both API shapes return
// results[] with a name, so we read defensively. We keep ALL category names so
// the attraction filter below can see every category a place belongs to.
function parsePlaces(json) {
  var results = (json && json.results) || [];
  return results.map(function (r) {
    var cats = Array.isArray(r.categories) ? r.categories.map(function (c) { return c && c.name; }).filter(Boolean) : [];
    return { name: (r.name || '').trim(), category: cats[0] || '', categories: cats };
  }).filter(function (r) { return r.name; });
}

// Category names that are clearly NOT a visitor "thing to do". Popularity sort
// surfaces local commerce and services (supermarkets, malls, hardware shops,
// banks, hotels, professional services); we drop those so the draft is
// attractions, not errands. Deliberately conservative: we do NOT drop
// restaurants/cafes/bakeries/bars, since famous food and drink spots (Pasteis de
// Belem, La Boqueria) are genuine attractions and the human reviewer can still
// bin a weak one.
//   - commerce/errands: supermarket, mall, hardware, retail "* store", etc.
//   - accommodation + hotel-internal POIs: hotel, resort, hostel, lobby, pool
//     (so "Lobby" / "Pool at <resort>" never read as things to do).
//   - professional/B2B services: the source of SEO-spam listings ("seo <city>",
//     "mobile app developer <city>") that have a services category, not a venue.
var NOISE_RE = /supermarket|grocery|convenience|shopping mall|^mall$|department store| store$|sporting goods|clothing|shoe shop|retail|boutique|hardware|building material|furniture|electronics|mobile phone|car dealer|auto|gas station|petrol|fuel|bank|^atm$|pharmacy|drugstore|medical|dentist|doctor|hospital|clinic|veterinar|office|coworking|residential|apartment|gym|fitness|salon|barber|laundry|dry clean|warehouse|wholesale|parking|storage|post office|police|school|university|hotel|motel|hostel|resort|guest ?house|bed (and|&) breakfast|lobby|professional|marketing|advertis|software|web design|information technology|it service|developer|programmer|consult|real estate|insurance|accounting|financ|telecom/i;

function isNoise(place) {
  var cats = (place.categories && place.categories.length) ? place.categories : [place.category || ''];
  var real = cats.filter(Boolean);
  // No category at all => low-confidence junk (e.g. SEO-spam listings that carry
  // a name but no real venue category). Drop, since these are auto-published.
  if (!real.length) return true;
  // Otherwise noise only if EVERY real category is noise, so a place that is
  // also a genuine landmark/attraction survives.
  return real.every(function (c) { return NOISE_RE.test(c); });
}

// Keep only attraction-like places.
function filterAttractions(places) {
  return (places || []).filter(function (p) { return !isNoise(p); });
}

// Turn a place list into a single draft for a destination, or null.
function placesToDraft(places, destination, opts) {
  opts = opts || {};
  var top = (places || []).slice(0, opts.max || 8);
  if (!top.length) return null;
  var seen = {}, names = [];
  top.forEach(function (pl) { var k = pl.name.toLowerCase(); if (!seen[k]) { seen[k] = 1; names.push(pl.name); } });
  var answer = ('Popular things to do in ' + destination + ' include: ' + names.slice(0, 5).join('; ') + '. Source: Foursquare.').slice(0, 600);
  return {
    question: 'What are the top things to do in ' + destination + '?',
    answer: answer,
    confidence: 'medium',
    type: 'Things To Do',
    sourceUrl: 'https://foursquare.com'
  };
}

// Default geocoder for the fallback path: OpenStreetMap Nominatim (free, no key,
// fixed trusted host). Override the endpoint with FOURSQUARE_GEOCODER if needed.
var GEOCODER_URL = process.env.FOURSQUARE_GEOCODER || 'https://nominatim.openstreetmap.org/search';

// Resolve a place string to a coordinate. ONLY used as a fallback when the text
// `near` search is unsupported by the host. Never throws; returns null on any
// failure. Nominatim's policy expects a descriptive User-Agent, so we send one.
async function geocode(query, opts) {
  opts = opts || {};
  if (!query) return null;
  try {
    var url = GEOCODER_URL + '?format=json&limit=1&q=' + encodeURIComponent(query);
    var r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': opts.userAgent || 'LunaTravelKnowledge/1.0 (destination discovery)' },
      signal: AbortSignal.timeout(opts.timeoutMs || 6000)
    });
    if (!r.ok) return null;
    var json = await r.json();
    var hit = Array.isArray(json) ? json[0] : null;
    if (!hit || hit.lat == null || hit.lon == null) return null;
    var lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat: lat, lng: lng };
  } catch (e) {
    return null;
  }
}

// Run a single Foursquare search (by `near` or by `ll`) and shape the result.
// Never throws. Returns { ok, httpStatus?, count?, rawCount?, draft?, error? }.
async function doSearch(host, key, search, destination, opts) {
  opts = opts || {};
  try {
    var url = buildSearchUrl(host, search);
    var r = await fetch(url, { headers: authHeaders(host, key), signal: AbortSignal.timeout(opts.timeoutMs || 8000) });
    if (!r.ok) return { ok: false, httpStatus: r.status, error: 'http_' + r.status };
    var json = await r.json();
    var all = parsePlaces(json);
    var places = filterAttractions(all);
    return { ok: true, httpStatus: 200, count: places.length, rawCount: all.length, draft: placesToDraft(places, destination, { max: opts.max || 8 }) };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed' };
  }
}

// Fetch places for a destination with full diagnostics. Never throws. Tries the
// text `near` search first (covers any destination); only falls back to a
// coordinate `ll` search when the host rejects `near` (HTTP 400).
// Returns { ok, httpStatus?, count?, draft?, via?, near?, error? }.
async function fetchPlaces(destination, opts) {
  opts = opts || {};
  var key = opts.apikey || process.env.FOURSQUARE_API_KEY;
  if (!key) return { ok: false, error: 'no_key' };
  if (!destination && !opts.country) return { ok: false, error: 'no_destination' };

  var host = opts.host || DEFAULT_HOST;
  var categories = opts.categories != null ? opts.categories : DEFAULT_CATEGORIES;
  var limit = opts.limit || 50;
  var near = opts.near || buildNearString(destination, opts.country);

  // 1) PRIMARY: text `near` search.
  if (near && opts.mode !== 'll') {
    var nearRes = await doSearch(host, key, {
      near: near, limit: limit, categories: categories, sort: opts.sort, timeoutMs: opts.timeoutMs
    }, destination, opts);
    if (nearRes.ok) { nearRes.via = 'near'; nearRes.near = near; return nearRes; }
    // Only a 400 means "near unsupported/ungeocodable" -> worth a coord retry.
    // Auth (401/403) and rate (429) errors would just recur, so surface them.
    if (nearRes.httpStatus !== 400) { nearRes.via = 'near'; nearRes.near = near; return nearRes; }
  }

  // 2) FALLBACK: resolve a coordinate, then search by `ll`.
  var coords = opts.coords || coordsFor(opts.country) || coordsFor(destination);
  if (!coords) coords = await geocode(near || destination, { timeoutMs: opts.geocodeTimeoutMs });
  if (!coords) return { ok: false, error: 'no_coords', via: 'll', near: near };
  var llRes = await doSearch(host, key, {
    lat: coords.lat, lng: coords.lng, radius: opts.radius || 20000,
    limit: limit, categories: categories, sort: opts.sort, timeoutMs: opts.timeoutMs
  }, destination, opts);
  llRes.via = 'll';
  return llRes;
}

async function fetchPlacesDraft(destination, opts) {
  var res = await fetchPlaces(destination, opts);
  return res.ok ? res.draft : null;
}

module.exports = {
  CENTROIDS: CENTROIDS,
  coordsFor: coordsFor,
  buildNearString: buildNearString,
  buildSearchUrl: buildSearchUrl,
  authHeaders: authHeaders,
  parsePlaces: parsePlaces,
  isNoise: isNoise,
  filterAttractions: filterAttractions,
  placesToDraft: placesToDraft,
  geocode: geocode,
  doSearch: doSearch,
  fetchPlaces: fetchPlaces,
  fetchPlacesDraft: fetchPlacesDraft
};
