// lib/amadeus.js
// Trusted structured source connector: Amadeus Tours & Activities.
//
// Like the Ticketmaster connector, this pulls STRUCTURED, trusted "things to do"
// for a destination (sightseeing, tours, experiences) and turns it into a single
// draft, deterministically (no LLM), so the data is never distorted. The draft
// still lands as Pending in Suggested Knowledge for human approval.
//
// Auth: OAuth2 client credentials. Create a free self-service app at
// developers.amadeus.com to get an API Key + Secret. Set AMADEUS_API_KEY and
// AMADEUS_API_SECRET in env; absent => connector is a no-op. AMADEUS_HOSTNAME
// defaults to the free test host; set it to api.amadeus.com for production data.
//
// The Activities API is geo-based (lat/lng + radius), so we resolve a
// destination name to a representative city centroid via CENTROIDS below.

'use strict';

var DEFAULT_HOST = process.env.AMADEUS_HOSTNAME || 'test.api.amadeus.com';

// Representative coordinates per destination (city centroid). Extensible.
// Country -> a major, tourist-relevant city so "things to do in Greece" returns
// real activities (Athens) rather than failing on a country-level query.
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

// OAuth2 token request body (form-encoded client credentials).
function buildTokenBody(key, secret) {
  return 'grant_type=client_credentials&client_id=' + encodeURIComponent(key) + '&client_secret=' + encodeURIComponent(secret);
}

function buildActivitiesUrl(host, opts) {
  var p = new URLSearchParams();
  p.set('latitude', String(opts.lat));
  p.set('longitude', String(opts.lng));
  if (opts.radius) p.set('radius', String(opts.radius));
  return 'https://' + host + '/v1/shopping/activities?' + p.toString();
}

// Parse the Activities response into a clean, minimal list.
function parseActivities(json) {
  var data = (json && json.data) || [];
  return data.map(function (a) {
    return {
      name: (a.name || '').trim(),
      rating: a.rating || null,
      description: (a.shortDescription || '').trim()
    };
  }).filter(function (a) { return a.name; });
}

// Turn an activity list into a single draft for a destination, or null.
function activitiesToDraft(activities, destination, opts) {
  opts = opts || {};
  var top = (activities || []).slice(0, opts.max || 6);
  if (!top.length) return null;
  // De-dupe names and keep it tidy; many Amadeus activities repeat names.
  var seen = {}, names = [];
  top.forEach(function (a) { var k = a.name.toLowerCase(); if (!seen[k]) { seen[k] = 1; names.push(a.name); } });
  var answer = ('Popular things to do in ' + destination + ' include: ' + names.slice(0, 5).join('; ') + '. Source: Amadeus.').slice(0, 600);
  return {
    question: 'What are the top things to do in ' + destination + '?',
    answer: answer,
    confidence: 'medium',
    type: 'Things To Do',
    sourceUrl: 'https://www.amadeus.com'
  };
}

// ── token cache (module-level; tokens last ~30 min) ──
var _token = { value: null, expiresAt: 0 };

async function getToken(opts) {
  opts = opts || {};
  var key = opts.apikey || process.env.AMADEUS_API_KEY;
  var secret = opts.apisecret || process.env.AMADEUS_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'no_key' };
  if (_token.value && Date.now() < _token.expiresAt - 30000) return { ok: true, token: _token.value };
  try {
    var host = opts.host || DEFAULT_HOST;
    var r = await fetch('https://' + host + '/v1/security/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenBody(key, secret),
      signal: AbortSignal.timeout(opts.timeoutMs || 6000)
    });
    if (!r.ok) return { ok: false, httpStatus: r.status, error: 'token_http_' + r.status };
    var j = await r.json();
    if (!j.access_token) return { ok: false, error: 'no_access_token' };
    _token = { value: j.access_token, expiresAt: Date.now() + ((j.expires_in || 1799) * 1000) };
    return { ok: true, token: j.access_token };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'token_failed' };
  }
}

// Fetch activities for a destination with full diagnostics. Never throws.
// Returns { ok, httpStatus?, count?, draft?, error? }.
async function fetchActivities(destination, opts) {
  opts = opts || {};
  var coords = opts.coords || coordsFor(destination);
  if (!coords) return { ok: false, error: 'no_coords' };
  var tok = await getToken(opts);
  if (!tok.ok) return { ok: false, error: tok.error, httpStatus: tok.httpStatus };
  try {
    var host = opts.host || DEFAULT_HOST;
    var url = buildActivitiesUrl(host, { lat: coords.lat, lng: coords.lng, radius: opts.radius || 20 });
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + tok.token, 'Accept': 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs || 8000) });
    if (!r.ok) return { ok: false, httpStatus: r.status, error: 'http_' + r.status };
    var json = await r.json();
    var activities = parseActivities(json);
    return { ok: true, httpStatus: 200, count: activities.length, draft: activitiesToDraft(activities, destination, { max: opts.max || 6 }) };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : 'fetch_failed' };
  }
}

async function fetchActivitiesDraft(destination, opts) {
  var res = await fetchActivities(destination, opts);
  return res.ok ? res.draft : null;
}

module.exports = {
  CENTROIDS: CENTROIDS,
  coordsFor: coordsFor,
  buildTokenBody: buildTokenBody,
  buildActivitiesUrl: buildActivitiesUrl,
  parseActivities: parseActivities,
  activitiesToDraft: activitiesToDraft,
  getToken: getToken,
  fetchActivities: fetchActivities,
  fetchActivitiesDraft: fetchActivitiesDraft
};
