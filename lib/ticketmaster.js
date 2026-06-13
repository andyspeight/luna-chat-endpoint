// lib/ticketmaster.js
// Trusted structured source connector: Ticketmaster Discovery API.
//
// Unlike the HTML crawler, this pulls STRUCTURED, authoritative event data
// (concerts, sport, theatre, festivals) for a destination and turns it into a
// single dated "what's on" draft. Because the data is already structured and
// from a trusted source, we format the draft deterministically (no LLM), so
// there is no extraction step that could distort it. The draft still lands as
// Draft / Suggested by Luna for owner approval.
//
// Free tier: a Consumer Key from developer.ticketmaster.com, up to 5,000 calls
// per day. Set TICKETMASTER_API_KEY in env; absent => connector is a no-op.

'use strict';

var DISCOVERY = 'https://app.ticketmaster.com/discovery/v2/events.json';

// Popular travel destinations that are whole countries -> ISO alpha-2, so we can
// query Ticketmaster by countryCode. Anything not listed is treated as a city.
var COUNTRY_CODES = {
  'spain': 'ES', 'greece': 'GR', 'portugal': 'PT', 'italy': 'IT', 'france': 'FR',
  'turkey': 'TR', 'turkiye': 'TR', 'cyprus': 'CY', 'malta': 'MT', 'croatia': 'HR',
  'united states': 'US', 'usa': 'US', 'united kingdom': 'GB', 'uk': 'GB',
  'ireland': 'IE', 'germany': 'DE', 'netherlands': 'NL', 'austria': 'AT',
  'united arab emirates': 'AE', 'uae': 'AE', 'mexico': 'MX', 'canada': 'CA',
  'australia': 'AU', 'new zealand': 'NZ'
};

// Build the Discovery API URL for a destination + date window.
function buildEventsUrl(opts) {
  opts = opts || {};
  var p = new URLSearchParams();
  p.set('apikey', opts.apikey || '');
  var key = String(opts.destination || '').trim().toLowerCase();
  if (COUNTRY_CODES[key]) {
    p.set('countryCode', COUNTRY_CODES[key]);
  } else if (opts.destination) {
    p.set('city', opts.destination);
  }
  p.set('size', String(opts.size || 10));
  p.set('sort', 'date,asc');
  if (opts.startDateTime) p.set('startDateTime', opts.startDateTime);
  if (opts.endDateTime) p.set('endDateTime', opts.endDateTime);
  return DISCOVERY + '?' + p.toString();
}

// Parse the Discovery response into a clean, minimal event list.
function parseEvents(json) {
  var evs = (json && json._embedded && json._embedded.events) || [];
  return evs.map(function (e) {
    var v = e._embedded && e._embedded.venues && e._embedded.venues[0];
    return {
      name: (e.name || '').trim(),
      date: (e.dates && e.dates.start && (e.dates.start.localDate || '')) || '',
      venue: (v && v.name) || '',
      city: (v && v.city && v.city.name) || '',
      url: e.url || '',
      segment: (e.classifications && e.classifications[0] && e.classifications[0].segment && e.classifications[0].segment.name) || ''
    };
  }).filter(function (e) { return e.name && e.date; });
}

function formatDate(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Turn an event list into a single dated draft for a destination, or null when
// there is nothing to report. Deterministic, house style, source attributed.
function eventsToDraft(events, destination, opts) {
  opts = opts || {};
  var top = (events || []).slice(0, opts.max || 5);
  if (!top.length) return null;
  var list = top.map(function (e) {
    return e.name + (e.venue ? (' at ' + e.venue) : '') + ' on ' + formatDate(e.date);
  }).join('; ');
  var answer = ('Upcoming events in ' + destination + ' include: ' + list + '. Source: Ticketmaster.').slice(0, 600);
  return {
    question: 'What events are coming up in ' + destination + '?',
    answer: answer,
    confidence: 'high',
    type: 'Destination Note',
    sourceUrl: 'https://www.ticketmaster.com'
  };
}

// Fetch + build a draft for one destination. Never throws; returns null on any
// failure or when no key is configured.
async function fetchEventsDraft(destination, opts) {
  opts = opts || {};
  var apikey = opts.apikey || process.env.TICKETMASTER_API_KEY;
  if (!apikey || !destination) return null;
  try {
    var startIso = new Date().toISOString().split('.')[0] + 'Z';
    var url = buildEventsUrl({ apikey: apikey, destination: destination, size: opts.size || 10, startDateTime: startIso });
    var r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs || 6000) });
    if (!r.ok) return null;
    var json = await r.json();
    return eventsToDraft(parseEvents(json), destination, { max: opts.max || 5 });
  } catch (e) {
    return null;
  }
}

module.exports = {
  COUNTRY_CODES: COUNTRY_CODES,
  buildEventsUrl: buildEventsUrl,
  parseEvents: parseEvents,
  eventsToDraft: eventsToDraft,
  fetchEventsDraft: fetchEventsDraft
};
