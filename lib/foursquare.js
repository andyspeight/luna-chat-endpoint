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
// Like Amadeus, the API is geo-based, so we resolve a destination name to a
// representative city centroid via CENTROIDS below.

'use strict';

// Default to the current Foursquare Places host (new accounts get keys for it).
// Override with FOURSQUARE_HOST=api.foursquare.com for a legacy v3 key.
var DEFAULT_HOST = process.env.FOURSQUARE_HOST || 'places-api.foursquare.com';
var API_VERSION = process.env.FOURSQUARE_API_VERSION || '2025-06-17';
// Bias results toward things to do: Arts & Entertainment + Landmarks & Outdoors.
var DEFAULT_CATEGORIES = process.env.FOURSQUARE_CATEGORIES || '16000,10000';

// Representative coordinates per destination (city centroid). Extensible.
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

function isNewApi(host) { return /places-api/.test(host || ''); }

function buildSearchUrl(host, opts) {
  var p = new URLSearchParams();
  p.set('ll', opts.lat + ',' + opts.lng);
  if (opts.radius) p.set('radius', String(opts.radius));
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
// banks); we drop those so the draft is attractions, not errands. Deliberately
// conservative: we do NOT drop restaurants/cafes/bakeries, since famous food
// spots (Pasteis de Belem, La Boqueria) are genuine attractions and the human
// reviewer can still bin a weak one.
var NOISE_RE = /supermarket|grocery|convenience|shopping mall|^mall$|department store|hardware|building material|furniture|electronics|mobile phone|car dealer|auto|gas station|petrol|fuel|bank|^atm$|pharmacy|drugstore|medical|dentist|doctor|hospital|clinic|veterinar|office|coworking|residential|apartment|gym|fitness|salon|barber|laundry|dry clean|warehouse|wholesale|parking|storage|post office|police|school|university/i;

function isNoise(place) {
  var cats = (place.categories && place.categories.length) ? place.categories : [place.category || ''];
  // Noise only if EVERY category is noise (so a place that is also a landmark survives).
  return cats.every(function (c) { return c && NOISE_RE.test(c); }) && cats.some(Boolean);
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

// Fetch places for a destination with full diagnostics. Never throws.
// Returns { ok, httpStatus?, count?, draft?, error? }.
async function fetchPlaces(destination, opts) {
  opts = opts || {};
  var key = opts.apikey || process.env.FOURSQUARE_API_KEY;
  if (!key) return { ok: false, error: 'no_key' };
  var coords = opts.coords || coordsFor(destination);
  if (!coords) return { ok: false, error: 'no_coords' };
  try {
    var host = opts.host || DEFAULT_HOST;
    var url = buildSearchUrl(host, {
      // Pull a generous set, then filter down to attractions client-side.
      lat: coords.lat, lng: coords.lng,
      radius: opts.radius || 20000, limit: opts.limit || 50,
      categories: opts.categories != null ? opts.categories : DEFAULT_CATEGORIES,
      sort: opts.sort
    });
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

async function fetchPlacesDraft(destination, opts) {
  var res = await fetchPlaces(destination, opts);
  return res.ok ? res.draft : null;
}

module.exports = {
  CENTROIDS: CENTROIDS,
  coordsFor: coordsFor,
  buildSearchUrl: buildSearchUrl,
  authHeaders: authHeaders,
  parsePlaces: parsePlaces,
  isNoise: isNoise,
  filterAttractions: filterAttractions,
  placesToDraft: placesToDraft,
  fetchPlaces: fetchPlaces,
  fetchPlacesDraft: fetchPlacesDraft
};
