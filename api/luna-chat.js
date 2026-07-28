// Widgets identify themselves by clientName. A renamed client must keep
// resolving under the name already embedded on their site. Shared helper.
const { clientNameFormula } = require('../lib/luna-auth');

const Anthropic = require('@anthropic-ai/sdk');
const ratelimit = require('../lib/ratelimit');
const knowledge = require('../lib/knowledge');
const fcdoLib = require('../lib/fcdo');
const embeddings = require('../lib/embeddings');
const vectorstore = require('../lib/vectorstore');
const kbdoc = require('../lib/kb-doc');

// Semantic search (hybrid). OFF unless SEMANTIC_SEARCH=1 AND the keys are set, so
// it is fully fallback-safe: any error or missing config silently uses the
// existing keyword search. Min cosine similarity filters weak matches.
const SEMANTIC_ON = process.env.SEMANTIC_SEARCH === '1';
const SEMANTIC_MIN_SIM = parseFloat(process.env.SEMANTIC_MIN_SIM || '0.45');
function semanticEnabled() { return SEMANTIC_ON && embeddings.configured() && vectorstore.ready(); }

// ─── LUNA BRAIN KNOWLEDGE BASE ───
const LB_BASE = 'appPKx77relfeiqmq';
const LB_TABLES = [
  { id: 'tblirr0vJuQcTLuH2', name: 'Destinations' },
  { id: 'tblgdLszaPmquxQ7O', name: 'Knowledge' },
  { id: 'tbl8CRDV48QGjDx2a', name: 'Transport' }
];

// Simple in-memory cache (survives for the life of the serverless function)
const kbCache = {};
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ─── TRAVELGENIX SUPPLIERS (single source of truth, read live from Airtable) ───
// The Suppliers table is the authoritative list of who Travelgenix connects to and
// how bookable each one is. Loaded on each Travelgenix chat and injected into the
// system prompt so supplier facts never go stale in code. To change what Luna says
// about a supplier, edit the Suppliers table — never hardcode it here.
const TG_SUPPLIERS_BASE = 'app6Ot3eOb3DangkB';
const TG_SUPPLIERS_TABLE = 'tbl5dbJmO5E7lQ4y6';
const SUPPLIERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let suppliersCache = { block: null, ts: 0 };

// Build an authoritative supplier block for the Travelgenix system prompt from the
// Suppliers table. Cached ~5 min. On any failure falls back to the last good cache
// so a transient Airtable issue never blanks supplier answers.
async function loadTravelgenixSuppliers(atKey) {
  if (!atKey) return '';
  if (suppliersCache.block && (Date.now() - suppliersCache.ts < SUPPLIERS_CACHE_TTL)) {
    return suppliersCache.block;
  }
  try {
    var url = 'https://api.airtable.com/v0/' + TG_SUPPLIERS_BASE + '/' + TG_SUPPLIERS_TABLE
      + '?filterByFormula=' + encodeURIComponent('{Active}=1')
      + '&pageSize=100';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
    if (!r.ok) {
      console.warn('[luna-chat] suppliers fetch failed:', r.status);
      return suppliersCache.block || '';
    }
    var data = await r.json();
    var recs = (data.records || []).map(function (x) { return x.fields || {}; });
    if (!recs.length) return suppliersCache.block || '';

    recs.sort(function (a, b) { return (a['Sort Order'] || 999) - (b['Sort Order'] || 999); });

    function fmt(rec) {
      var line = '- ' + (rec.Name || '');
      var extras = [];
      if (rec['No Booking Fees']) extras.push('no booking fees');
      if (rec.Notes) extras.push(String(rec.Notes));
      if (extras.length) line += ' (' + extras.join('; ') + ')';
      return line;
    }

    var instant = recs.filter(function (r) { return r.Type === 'Tour Operator' && r.Bookability === 'Real-time instant'; });
    var notInstant = recs.filter(function (r) { return r.Type === 'Tour Operator' && r.Bookability !== 'Real-time instant'; });
    var api = recs.filter(function (r) { return r.Type === 'API Supplier' || r.Type === 'Bedbank'; });
    var other = recs.filter(function (r) { return r.Type !== 'Tour Operator' && r.Type !== 'API Supplier' && r.Type !== 'Bedbank'; });

    var lines = [];
    lines.push('');
    lines.push('## SUPPLIERS AND TOUR OPERATORS — AUTHORITATIVE, LIVE DATA');
    lines.push('This is the current, official list of who Travelgenix connects to, loaded live from our records. It OVERRIDES any supplier or tour operator names mentioned anywhere else in this prompt. Rules you must follow:');
    lines.push('- Only state what is listed here. If a supplier is not in this list, say you will confirm current details rather than guessing.');
    lines.push('- Only describe a tour operator as integrated, real-time or instantly bookable if it appears under the real-time heading below. Never imply instant online booking for any operator listed as not real-time.');
    lines.push('- Only claim "no booking fees" for an individual supplier where it is marked as such below.');
    if (instant.length) {
      lines.push('');
      lines.push('Fully integrated tour operators (real-time, instant online confirmation):');
      instant.forEach(function (r) { lines.push(fmt(r)); });
    }
    if (notInstant.length) {
      lines.push('');
      lines.push('Available to sell but NOT real-time and NOT instantly bookable online:');
      notInstant.forEach(function (r) { lines.push(fmt(r)); });
    }
    if (api.length) {
      lines.push('');
      lines.push('Premium suppliers connected via API (200+ suppliers in total, with live availability):');
      api.forEach(function (r) { lines.push(fmt(r)); });
    }
    if (other.length) {
      lines.push('');
      lines.push('Other suppliers and partners:');
      other.forEach(function (r) { lines.push(fmt(r)); });
    }

    var block = lines.join('\n');
    suppliersCache = { block: block, ts: Date.now() };
    return block;
  } catch (e) {
    console.warn('[luna-chat] suppliers load error:', e.message);
    return suppliersCache.block || '';
  }
}

// ─── TRAVELGENIX KNOWLEDGE BASE (live from Airtable, single source of truth) ───
// The structured Q&A tables in the Knowledge Bot base are the authoritative
// knowledge for the Travelgenix bot. Loaded live and injected into the system
// prompt so answers about the company, products, pricing, who we help, objections
// and the roadmap are never hardcoded and never go stale. Edit the tables, not this file.
const TG_KB_BASE = 'app6Ot3eOb3DangkB';
const TG_KB_TABLES = [
  { id: 'tblyryzNkhWRNPHEN', label: 'Company and Story' },
  { id: 'tbl6c0qNmgEz6lNnK', label: 'Products and Features' },
  { id: 'tblhpCfkigp2pa8gm', label: 'Pricing and Commercial' },
  { id: 'tblhOCktu5Xw2EzA4', label: 'Who We Help' },
  { id: 'tblGHK1ObtAbrvRYo', label: 'Objection Handling' },
  { id: 'tblipgn4mtgfqVjeB', label: 'Roadmap and Innovation' }
];
const KB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let kbContentCache = { block: null, ts: 0 };

async function loadTravelgenixKnowledge(atKey) {
  if (!atKey) return '';
  if (kbContentCache.block && (Date.now() - kbContentCache.ts < KB_CACHE_TTL)) {
    return kbContentCache.block;
  }
  try {
    var sections = await Promise.all(TG_KB_TABLES.map(async function (t) {
      try {
        var url = 'https://api.airtable.com/v0/' + TG_KB_BASE + '/' + t.id + '?pageSize=100';
        var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
        if (!r.ok) { console.warn('[luna-chat] KB table ' + t.label + ' fetch failed:', r.status); return ''; }
        var data = await r.json();
        var pairs = (data.records || []).map(function (rec) {
          var f = rec.fields || {};
          var q = f.Question || f.Topic;
          var a = f.Answer || f.Description;
          if (!q || !a) return '';
          return 'Q: ' + String(q).trim() + '\nA: ' + String(a).trim();
        }).filter(Boolean);
        if (!pairs.length) return '';
        return '### ' + t.label + '\n' + pairs.join('\n\n');
      } catch (e) {
        console.warn('[luna-chat] KB table ' + t.label + ' error:', e.message);
        return '';
      }
    }));
    var body = sections.filter(Boolean).join('\n\n');
    if (!body) return kbContentCache.block || '';
    var block = '\n\n## KNOWLEDGE BASE — AUTHORITATIVE, LIVE DATA\n'
      + 'These question and answer pairs are the current, official Travelgenix knowledge, loaded live from our records. Use them as the primary source for any question about the company, products, pricing, who we help, objections and the roadmap. Do not contradict them, and do not invent specifics such as prices, package contents or supplier names that are not stated here or in the suppliers section.\n\n'
      + body;
    kbContentCache = { block: block, ts: Date.now() };
    return block;
  } catch (e) {
    console.warn('[luna-chat] KB load error:', e.message);
    return kbContentCache.block || '';
  }
}

// ─── DESTINATION CONTEXT (Airports + Theme Parks) ───
// Keyword-triggered injection. Index built once on cold start; per-request
// scan picks up matches and fetches full record detail only when needed.
const DC_BASE = 'appuZdlMJ7HKUt6qS';
const DC_AIRPORTS_TABLE = 'tblI2iVAbIGCtsGa7';
const DC_THEMEPARKS_TABLE = 'tblhVDUdpwaLabDmQ';

// Field IDs we care about for the index (cheap lookup)
const DC_AIRPORT_NAME_FIELD = 'fldlT6eApAdQHGYED';   // Airport Name
const DC_AIRPORT_IATA_FIELD = 'fldcS9uu4NWMVaIVP';   // IATA Code
const DC_AIRPORT_CITY_FIELD = 'fldgrJ2uFjzPcAxUx';   // City Served
const DC_THEMEPARK_NAME_FIELD = 'fldboK0kstNohXgqJ'; // Name
const DC_THEMEPARK_LOCATION_FIELD = 'fldyoIhTvHu2NI3gn'; // Location

// Country aliases — informal or alternative names mapped to the canonical
// Country record name in the Countries table. Used when building the
// destination index so "USA", "Czechia" etc resolve to the right record.
const COUNTRY_ALIASES = {
  'USA':                          ['United States', 'America'],
  'UAE':                          ['United Arab Emirates'],
  'Czech Republic':               ['Czechia'],
  'St Lucia':                     ['Saint Lucia'],
  'St Kitts & Nevis':             ['Saint Kitts', 'Nevis'],
  'St Vincent & the Grenadines':  ['Saint Vincent'],
  'Turks & Caicos':               ['Turks and Caicos'],
  'Tobago':                       ['Trinidad and Tobago'],
  'The Gambia':                   ['Gambia']
  // Hong Kong: exact match only — no alias needed
};

// In-memory indexes — built once per cold start
// Shape: { 'lower-case match string': { id, displayName, type } }
let dcIndex = null;
let dcIndexBuildPromise = null;
const DC_INDEX_TTL = 60 * 60 * 1000; // 1 hour — rebuild hourly so new records show up
let dcIndexBuiltAt = 0;

// Per-record full-detail cache
const dcRecordCache = {};
const DC_RECORD_CACHE_TTL = 30 * 60 * 1000; // 30 min

// ─── BOOKING LOOKUP INTEGRATION ───
// Discovers whether a Luna client has linked a My Booking widget over on
// tg-widgets. Cached per clientName for the lifetime of the function.
const TG_WIDGETS_BASE = 'https://widgets.travelify.io';
const lunaBookingCache = {};
const LUNA_BOOKING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function findLinkedBookingWidget(clientName) {
  if (!clientName || typeof clientName !== 'string') return null;
  const key = clientName.trim().toLowerCase();
  if (!key) return null;

  const cached = lunaBookingCache[key];
  if (cached && (Date.now() - cached.ts < LUNA_BOOKING_CACHE_TTL)) {
    return cached.data;
  }

  try {
    const url = TG_WIDGETS_BASE + '/api/find-booking-widget?lunaClientName=' + encodeURIComponent(clientName);
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 3000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.status === 404) {
      lunaBookingCache[key] = { data: null, ts: Date.now() };
      return null;
    }
    if (!res.ok) {
      console.warn('[luna-chat] find-booking-widget returned', res.status);
      return null;
    }
    const data = await res.json();
    if (!data || !data.widgetId) {
      lunaBookingCache[key] = { data: null, ts: Date.now() };
      return null;
    }
    const result = { widgetId: data.widgetId };
    lunaBookingCache[key] = { data: result, ts: Date.now() };
    return result;
  } catch (err) {
    console.warn('[luna-chat] find-booking-widget error:', err.message);
    return null;
  }
}

// Stop words for keyword extraction
const STOP_WORDS = new Set(['tell','me','about','the','a','an','what','which','where','how','is','are','in','for','to','do','you','have','can','i','my','best','good','great','top','most','popular','like','want','go','visit','travel','holiday','trip','please','some','any','need','should','there','when','does','much','cost','get','take','long','far','would','know','could','also','very','just','been','more','than','from','with','this','that','they','will','were','was','has','had','yes','no','yeah','sure','ok','okay','its','hi','hello','hey','thanks','thank','bye','goodbye','chat','help']);

// Non-travel keywords that skip KB search
const NON_TRAVEL_PATTERNS = [
  /^(hi|hello|hey|thanks|bye|goodbye|ok|okay|yes|no|yeah|sure)\s*[!?.]*$/i,
  /opening hours|contact|phone|email|address|speak to|talk to|human|agent|book(ing)?\s+ref/i,
  /how (do|can) (i|we) (book|pay|contact)/i
];

function extractKeywords(msg) {
  return msg.toLowerCase()
    .replace(/[?!.,;:'\u2019\u2018\u201C\u201D()\-]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 1 && !STOP_WORDS.has(w); });
}

function isTravelQuestion(msg) {
  for (var i = 0; i < NON_TRAVEL_PATTERNS.length; i++) {
    if (NON_TRAVEL_PATTERNS[i].test(msg)) return false;
  }
  var kw = extractKeywords(msg);
  return kw.length > 0;
}

function getCacheKey(query) {
  return extractKeywords(query).sort().join('_').slice(0, 100);
}

// Strip everything that isn't alphanumeric or space — safe for Airtable SEARCH() literals.
// Belt and braces: even if a keyword escapes extractKeywords(), this closes the formula injection surface.
function sanitizeFormulaLiteral(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 100);
}

// For client-name lookups in Airtable formulas — allows a slightly wider character set
// (letters, numbers, spaces, &, ., ', -) since business names legitimately contain these.
// Escapes single quotes and backslashes for safe embedding in '...' literals.
function sanitizeClientNameForFormula(str) {
  if (typeof str !== 'string') return '';
  // Allowlist: letters, digits, space, &, period, apostrophe, hyphen
  var cleaned = str.replace(/[^a-zA-Z0-9 &.'\-]/g, '').trim().slice(0, 100);
  // Escape backslashes first, then single quotes — order matters
  return cleaned.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}


// ─── DESTINATION CONTEXT FUNCTIONS ────────────────────────

// Fetch all records (single page is fine — tables are small) from a given
// table and return as a flat array of {id, fields} objects.
async function fetchAllRecords(tableId, atKey, fieldIds) {
  if (!atKey) return [];
  var fieldParam = (fieldIds || []).map(function(f) { return 'fields[]=' + encodeURIComponent(f); }).join('&');
  var url = 'https://api.airtable.com/v0/' + DC_BASE + '/' + tableId + '?pageSize=100' + (fieldParam ? '&' + fieldParam : '');
  var all = [];
  var offset = null;
  try {
    do {
      var pageUrl = offset ? url + '&offset=' + encodeURIComponent(offset) : url;
      var r = await fetch(pageUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
      if (!r.ok) break;
      var data = await r.json();
      (data.records || []).forEach(function(rec) { all.push(rec); });
      offset = data.offset || null;
    } while (offset && all.length < 500);  // safety cap
  } catch (err) {
    console.warn('[luna-chat] fetchAllRecords error for', tableId, err.message);
  }
  return all;
}

// Build the destination index. Maps lookup strings → record metadata.
// Multiple match keys per record (e.g. "gatwick", "lgw", "london gatwick").
// First record wins on duplicate keys; later dupes become unreachable.
async function buildDestinationIndex(atKey) {
  if (!atKey) return {};

  var index = {};
  var addEntry = function(key, payload) {
    var k = key && key.toLowerCase().trim();
    if (!k) return;
    if (index[k]) return; // first wins
    index[k] = payload;
  };

  // Airports
  var airports = await fetchAllRecords(DC_AIRPORTS_TABLE, atKey, [
    DC_AIRPORT_NAME_FIELD, DC_AIRPORT_IATA_FIELD, DC_AIRPORT_CITY_FIELD
  ]);
  airports.forEach(function(rec) {
    var f = rec.fields || {};
    var name = f['Airport Name'];
    var iata = f['IATA Code'];
    var city = f['City Served'];
    if (!name) return;
    var payload = { id: rec.id, displayName: name, type: 'airport', iata: iata };
    // Full name (e.g. "London Gatwick")
    addEntry(name, payload);
    // IATA code (e.g. "LGW")
    if (iata && iata.length === 3) addEntry(iata, payload);
    // Short name — strip the city prefix so "Gatwick" matches "London Gatwick"
    // Heuristic: if name has two+ words, also index the suffix word(s) after the first word
    var parts = name.split(/\s+/);
    if (parts.length >= 2) {
      // Last word ("Gatwick" from "London Gatwick"; "Heathrow" from "London Heathrow")
      addEntry(parts[parts.length - 1], payload);
      // Last two words ("Costa del Sol" from "Malaga-Costa del Sol")
      if (parts.length >= 3) addEntry(parts.slice(-2).join(' '), payload);
    }
  });

  // Theme parks
  var parks = await fetchAllRecords(DC_THEMEPARKS_TABLE, atKey, [
    DC_THEMEPARK_NAME_FIELD, DC_THEMEPARK_LOCATION_FIELD
  ]);
  parks.forEach(function(rec) {
    var f = rec.fields || {};
    var name = f['Name'];
    if (!name) return;
    var payload = { id: rec.id, displayName: name, type: 'themepark' };
    addEntry(name, payload);
    // Common short forms — strip " Resort", " Park", "Disneyland " prefix etc
    var shortened = name.replace(/\s+(Resort|Park|World|Land|Adventures)$/i, '').trim();
    if (shortened && shortened !== name) addEntry(shortened, payload);
  });

  // Cities and Regions — index by name for weather/destination queries
  try {
    var cities = await fetchAllRecords('tblTkKujdVZgWPAQe', atKey,
      ['City/Region', 'Climate Temps', 'Climate Rainfall', 'Climate Season']);
    cities.forEach(function(rec) {
      var name = rec.fields && rec.fields['City/Region'];
      if (!name) return;
      var payload = { id: rec.id, displayName: name, type: 'city', table: 'tblTkKujdVZgWPAQe' };
      addEntry(name, payload);
      // Also key by last word (e.g. "Costa del Sol" → "Sol" — minor but helps)
      var parts = name.split(/\s+/);
      if (parts.length >= 2) {
        var last = parts[parts.length - 1];
        if (last.length >= 4) addEntry(last, payload);
      }
    });
  } catch (e) {
    console.warn('[luna-chat] cities index failed:', e.message);
  }
  // Resorts and Areas — index by name
  try {
    var resorts = await fetchAllRecords('tblwV9gnbVEyZ99gI', atKey,
      ['Resort/Area', 'Climate Temps', 'Climate Rainfall', 'Climate Season']);
    resorts.forEach(function(rec) {
      var name = rec.fields && rec.fields['Resort/Area'];
      if (!name) return;
      var payload = { id: rec.id, displayName: name, type: 'resort', table: 'tblwV9gnbVEyZ99gI' };
      addEntry(name, payload);
      // Split form for "X & Y" → also index X
      if (name.indexOf('&') !== -1) {
        var first = name.split('&')[0].trim();
        if (first.length >= 4) addEntry(first, payload);
      }
    });
  } catch (e) {
    console.warn('[luna-chat] resorts index failed:', e.message);
  }
  // Countries — index by name so visa, currency, health and practical questions
  // can be answered. All 100 records indexed (no status filter).
  var countriesCount = 0;
  try {
    var countries = await fetchAllRecords('tblsxbqbyhTDoWhbo', atKey,
      ['Country', 'Climate Temps', 'Climate Rainfall', 'Climate Season']);
    countriesCount = countries.length;
    countries.forEach(function(rec) {
      var name = rec.fields && rec.fields['Country'];
      if (!name) return;
      var payload = { id: rec.id, displayName: name, type: 'country', table: 'tblsxbqbyhTDoWhbo' };
      addEntry(name, payload);
      // Hard-coded aliases for informal or alternative country names
      var aliases = COUNTRY_ALIASES[name];
      if (aliases && aliases.length) {
        aliases.forEach(function(alias) { addEntry(alias, payload); });
      }
    });
  } catch (e) {
    console.warn('[luna-chat] countries index failed:', e.message);
  }
    console.log('[luna-chat] destination index built:', Object.keys(index).length, 'keys for', airports.length, 'airports +', parks.length, 'parks +', countriesCount, 'countries');
  return index;
}

// Ensure the index is built (singleton, with TTL refresh)
async function ensureDestinationIndex(atKey) {
  var now = Date.now();
  if (dcIndex && (now - dcIndexBuiltAt < DC_INDEX_TTL)) return dcIndex;
  if (dcIndexBuildPromise) return dcIndexBuildPromise;
  dcIndexBuildPromise = (async function() {
    try {
      dcIndex = await buildDestinationIndex(atKey);
      dcIndexBuiltAt = Date.now();
      return dcIndex;
    } finally {
      dcIndexBuildPromise = null;
    }
  })();
  return dcIndexBuildPromise;
}

// Fetch one full record (all fields) from the appropriate table.
async function fetchDestinationRecord(payload, atKey) {
  var cacheKey = payload.id;
  var cached = dcRecordCache[cacheKey];
  if (cached && (Date.now() - cached.ts < DC_RECORD_CACHE_TTL)) {
    return cached.data;
  }
  // Route to the table specified in the payload (cities, resorts, countries),
  // falling back to airport/themepark logic for legacy payloads without .table.
  var tableId;
  if (payload.table) {
    tableId = payload.table;
  } else if (payload.type === 'airport') {
    tableId = DC_AIRPORTS_TABLE;
  } else {
    tableId = DC_THEMEPARKS_TABLE;
  }
  var url = 'https://api.airtable.com/v0/' + DC_BASE + '/' + tableId + '/' + payload.id;
  try {
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
    if (!r.ok) return null;
    var data = await r.json();
    dcRecordCache[cacheKey] = { ts: Date.now(), data: data };
    return data;
  } catch (err) {
    console.warn('[luna-chat] fetchDestinationRecord error:', err.message);
    return null;
  }
}

// Scan the message for any destination matches. Returns array of matched
// payloads (deduplicated by id). Sorted longest match first so "London
// Heathrow" wins over "Heathrow" if both appear.
function scanForDestinations(message, index) {
  if (!message || !index) return [];
  var lower = (' ' + message.toLowerCase() + ' ').replace(/[?!.,;:'"()\[\]]/g, ' ');
  var matches = [];
  var seenIds = {};
  // Iterate keys longest first so we prefer specific matches
  var keys = Object.keys(index).sort(function(a, b) { return b.length - a.length; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    // Match on word boundary so "lhr" matches but not part of a bigger word
    var escapedKey = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var pattern = '\\b' + escapedKey + '\\b';
    var re = new RegExp(pattern, 'i');
    if (re.test(lower)) {
      var payload = index[k];
      if (!seenIds[payload.id]) {
        seenIds[payload.id] = true;
        matches.push(payload);
      }
      if (matches.length >= 3) break; // cap so prompt doesn't bloat
    }
  }
  return matches;
}

// Build a slim, prompt-ready summary of one record. Picks only the most
// useful fields so the prompt doesn't bloat.
function summariseDestinationRecord(record, payload) {
  if (!record || !record.fields) return '';
  var f = record.fields;
  var parts = [];

  if (payload.type === 'airport') {
    parts.push('### Airport: ' + (f['Airport Name'] || payload.displayName) + (f['IATA Code'] ? ' (' + f['IATA Code'] + ')' : ''));
    if (f['City Served']) parts.push('City served: ' + f['City Served']);
    if (f['Country Text']) parts.push('Country: ' + f['Country Text']);
    if (typeof f['Latitude'] === 'number' && typeof f['Longitude'] === 'number') {
      parts.push('Coordinates: ' + f['Latitude'] + ', ' + f['Longitude']);
    }
    if (f['Overview']) parts.push('Overview: ' + f['Overview']);
    if (f['Distance & Drive Time']) parts.push('Distance from city: ' + f['Distance & Drive Time']);
    if (f['Terminals & Airlines']) parts.push('Terminals: ' + f['Terminals & Airlines']);
    if (f['Getting There By Train']) parts.push('By train: ' + f['Getting There By Train']);
    if (f['Getting There By Car']) parts.push('By car: ' + f['Getting There By Car']);
    if (f['Parking']) parts.push('Parking: ' + f['Parking']);
    if (f['Lounges']) parts.push('Lounges: ' + f['Lounges']);
    if (f['Recommended Arrival Time']) parts.push('Recommended arrival: ' + f['Recommended Arrival Time']);
    if (f['Quirks & Local Tips']) parts.push('Quirks & tips: ' + f['Quirks & Local Tips']);
    if (f['Official Website']) parts.push('Official site: ' + f['Official Website']);
  } else if (payload.type === 'themepark') {
    parts.push('### Theme Park: ' + (f['Name'] || payload.displayName));
    if (f['Location']) parts.push('Location: ' + f['Location']);
    if (f['Country']) parts.push('Country: ' + f['Country']);
    if (typeof f['Latitude'] === 'number' && typeof f['Longitude'] === 'number') {
      parts.push('Coordinates: ' + f['Latitude'] + ', ' + f['Longitude']);
    }
    if (f['Overview']) parts.push('Overview: ' + f['Overview']);
    if (f['Days Needed']) parts.push('Days needed: ' + f['Days Needed']);
    if (f['Best Time to Visit']) parts.push('Best time: ' + f['Best Time to Visit']);
    if (f['Tickets and Prices']) parts.push('Tickets: ' + f['Tickets and Prices']);
    if (f['Star Attractions']) parts.push('Star attractions: ' + f['Star Attractions']);
    if (f['Family Guide']) parts.push('Family guide: ' + f['Family Guide']);
    if (f['Nearest Airport']) parts.push('Nearest airport: ' + f['Nearest Airport']);
    if (f['Fast Track Options']) parts.push('Fast track: ' + f['Fast Track Options']);
    if (f['Quirks and Insider Tips']) parts.push('Insider tips: ' + f['Quirks and Insider Tips']);
    if (f['Official Website']) parts.push('Official site: ' + f['Official Website']);
  } else if (payload.type === 'city') {
    parts.push('### City/Region: ' + (f['City/Region'] || payload.displayName));
    if (f['Region']) parts.push('Region: ' + f['Region']);
    if (f['Overview']) parts.push('Overview: ' + f['Overview']);
    if (f['What Makes It Special']) parts.push('What makes it special: ' + f['What Makes It Special']);
    if (f['Best Time to Visit']) parts.push('Best time: ' + f['Best Time to Visit']);
    if (f['Who Is It Best For']) parts.push('Best for: ' + f['Who Is It Best For']);
    if (f['Flight Time From UK']) parts.push('Flight time from UK: ' + f['Flight Time From UK']);
    if (typeof f['Latitude'] === 'number' && typeof f['Longitude'] === 'number') {
      parts.push('Coordinates: ' + f['Latitude'] + ', ' + f['Longitude']);
    }
  } else if (payload.type === 'resort') {
    parts.push('### Resort/Area: ' + (f['Resort/Area'] || payload.displayName));
    if (f['Region']) parts.push('Region: ' + f['Region']);
    if (f['Overview']) parts.push('Overview: ' + f['Overview']);
    if (f['Character and Vibe']) parts.push('Character: ' + f['Character and Vibe']);
    if (f['Best Time to Visit']) parts.push('Best time: ' + f['Best Time to Visit']);
    if (f['Beaches']) parts.push('Beaches: ' + f['Beaches']);
    if (typeof f['Latitude'] === 'number' && typeof f['Longitude'] === 'number') {
      parts.push('Coordinates: ' + f['Latitude'] + ', ' + f['Longitude']);
    }
  } else if (payload.type === 'country') {
    parts.push('### Country: ' + (f['Country'] || payload.displayName));
    if (f['Region']) parts.push('Region: ' + f['Region']);
    if (f['Hero Intro']) parts.push('Intro: ' + f['Hero Intro']);
    if (f['Overview']) parts.push('Overview: ' + f['Overview']);
    if (f['Visa Advisory']) parts.push('Visa advisory: ' + f['Visa Advisory']);
    if (f['Visa Status UK']) parts.push('Visa status (UK passport): ' + f['Visa Status UK']);
    if (f['Health Notes UK']) parts.push('Health notes (UK): ' + f['Health Notes UK']);
    if (f['Practical Info']) parts.push('Practical info: ' + f['Practical Info']);
    if (f['Currency']) parts.push('Currency: ' + f['Currency']);
    if (f['Language']) parts.push('Language: ' + f['Language']);
    if (f['Time Zone']) parts.push('Time zone: ' + f['Time Zone']);
    if (f['Voltage And Plug']) parts.push('Voltage and plug: ' + f['Voltage And Plug']);
    if (f['Flight Time From UK']) parts.push('Flight time from UK: ' + f['Flight Time From UK']);
    if (f['Best Time to Visit']) parts.push('Best time to visit: ' + f['Best Time to Visit']);
    if (f['Top Things to Do']) parts.push('Top things to do: ' + f['Top Things to Do']);
    if (f['Food and Drink']) parts.push('Food and drink: ' + f['Food and Drink']);
    if (f['Getting There']) parts.push('Getting there: ' + f['Getting There']);
    if (typeof f['Latitude'] === 'number' && typeof f['Longitude'] === 'number') {
      parts.push('Coordinates: ' + f['Latitude'] + ', ' + f['Longitude']);
    }
  }
  // Climate data (Cities, Resorts, Countries records carry these fields)
  var climateTemps = f['Climate Temps'];
  var climateRain = f['Climate Rainfall'];
  var climateSeason = f['Climate Season'];
  if (climateTemps || climateRain || climateSeason) {
    parts.push('--- Climate data (for weather_card emission) ---');
    if (climateTemps) parts.push('Avg daytime highs Jan-Dec (C): ' + climateTemps);
    if (climateRain) parts.push('Avg monthly rainfall Jan-Dec (mm): ' + climateRain);
    if (climateSeason) parts.push('Seasonality Jan-Dec (best/shoulder/off): ' + climateSeason);
  }
  return parts.join('\n');
}

// ─── LIVE WEATHER (Open-Meteo) ───────────────────────────
// Open-Meteo is a free, no-API-key forecast service that we already use in
// the Travelgenix Weather widget. Quality data, no rate limits at our scale.
// We cache results for 30 minutes per coordinate.

var openMeteoCache = {};
var OPEN_METEO_TTL = 30 * 60 * 1000; // 30 minutes

async function fetchOpenMeteo(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  // Round to 2dp for cache key (~1km granularity is plenty for travel)
  var key = lat.toFixed(2) + ',' + lng.toFixed(2);
  var cached = openMeteoCache[key];
  if (cached && (Date.now() - cached.ts < OPEN_METEO_TTL)) return cached.data;
  try {
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + encodeURIComponent(lat)
      + '&longitude=' + encodeURIComponent(lng)
      + '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,apparent_temperature'
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
      + '&timezone=auto&forecast_days=7';
    var r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) {
      console.warn('[luna-chat] Open-Meteo returned', r.status);
      return null;
    }
    var data = await r.json();
    openMeteoCache[key] = { ts: Date.now(), data: data };
    return data;
  } catch (err) {
    console.warn('[luna-chat] Open-Meteo fetch failed:', err.message);
    return null;
  }
}

// Format Open-Meteo response into a compact prompt-friendly summary.
function summariseLiveWeather(data) {
  if (!data || !data.current || !data.daily) return '';
  var cur = data.current;
  var daily = data.daily;
  var parts = [];
  parts.push('--- Live weather (Open-Meteo, current conditions + 7-day forecast) ---');
  parts.push('Current temperature: ' + Math.round(cur.temperature_2m) + 'C');
  parts.push('Current weather code (WMO): ' + cur.weather_code);
  parts.push('Feels like: ' + Math.round(cur.apparent_temperature) + 'C');
  parts.push('Wind: ' + Math.round(cur.wind_speed_10m) + ' km/h');
  parts.push('Humidity: ' + cur.relative_humidity_2m + '%');
  parts.push('Timezone: ' + (data.timezone || 'auto'));
  if (daily.time && daily.temperature_2m_max && daily.temperature_2m_min && daily.weather_code) {
    parts.push('7-day forecast (date | high C | low C | WMO code):');
    for (var i = 0; i < daily.time.length && i < 7; i++) {
      parts.push('  ' + daily.time[i]
        + ' | ' + Math.round(daily.temperature_2m_max[i])
        + ' | ' + Math.round(daily.temperature_2m_min[i])
        + ' | ' + daily.weather_code[i]);
    }
  }
  return parts.join('\n');
}

// Top-level entry: returns a prompt-ready string with matched destination context,
// or empty string if no matches / no API key.
async function getDestinationContext(message, atKey) {
  if (!atKey || !message) return '';
  try {
    var index = await ensureDestinationIndex(atKey);
    if (!index || Object.keys(index).length === 0) return '';
    var matches = scanForDestinations(message, index);
    if (matches.length === 0) return '';
    var summaries = [];
    for (var i = 0; i < matches.length; i++) {
      var rec = await fetchDestinationRecord(matches[i], atKey);
      var summary = summariseDestinationRecord(rec, matches[i]);
      // Append live weather data if the record carries coordinates
      if (rec && rec.fields) {
        var lat = rec.fields['Latitude'];
        var lng = rec.fields['Longitude'];
        if (typeof lat === 'number' && typeof lng === 'number') {
          var live = await fetchOpenMeteo(lat, lng);
          var liveText = summariseLiveWeather(live);
          if (liveText) summary = (summary || '') + '\n' + liveText;
        }
      }
      if (summary) summaries.push(summary);
    }
    if (summaries.length === 0) return '';
    return '\n\n## Destination context (verified data)\nThe visitor mentioned the following. Use these verified facts directly when answering. Do NOT make up details; if a detail isn\'t listed here, say you can find out.\n\n' + summaries.join('\n\n') + '\n\n### How to present this\nLook at the visitor\'s question type and emit the right block(s) AFTER your prose answer.\n\n**ROUTING — exclusive unless explicitly both:**\n\nThe block follows the question type, NOT the destination type. A weather question about an airport gets weather_card ONLY — do not also show a map of the airport. A location question about a city gets location_card ONLY — do not also show its climate. Only emit both when the visitor explicitly asks both things in the same message.\n\n- **Weather/climate/forecast/temperature/rain/snow/sun/"what is it like in <month>" questions** → emit `weather_card` ONLY. Use Climate Temps, Climate Rainfall, Climate Season fields PLUS the Live weather section (when present). ALWAYS include live data when available — it makes the card feel current.\n- **Location/map/directions/where-is/"how do I get to <place>" questions** about an airport or theme park → emit `location_card` ONLY.\n- **Both explicitly asked in one message** (e.g. "what is the weather like at Heathrow and where exactly is it?") → emit BOTH cards, weather_card first.\n- **Neither weather nor location** → no block, just prose.\n\n**Examples — follow these exactly:**\n\n- "What\'s the weather like at Heathrow?" → weather_card ONLY (the visitor asked about weather, not location)\n- "Where is Heathrow?" → location_card ONLY\n- "What\'s the weather like at Heathrow and where exactly is it?" → BOTH, weather_card first\n- "What\'s Crete like in August?" → weather_card ONLY (weather/climate question)\n- "How do I get to Disneyland Paris?" → location_card ONLY\n- "Tell me about Tokyo" → no block, prose only (general question, not weather or location)\n\nweather_card format:\n[BLOCK]{"type":"weather_card","props":{"name":"<destination>","subtitle":"<region>","tempsC":[<12 historical highs Jan-Dec>],"rainfallMm":[<12 numbers>],"seasons":[<12 tokens best|shoulder|off>],"highlightMonth":<0-11 optional>,"summary":"<1 sentence>","currentTempC":<num>,"feelsLikeC":<num>,"currentCode":<WMO num>,"windKmh":<num>,"humidity":<num>,"forecast":[{"date":"YYYY-MM-DD","highC":<n>,"lowC":<n>,"code":<n>},...up to 7]}}[/BLOCK]\n\nlocation_card format:\n[BLOCK]{"type":"location_card","props":{"name":"<full name>","subtitle":"<IATA · short context, e.g. UK airport · 30 mi south of London>","lat":<lat number>,"lng":<lng number>,"zoom":12,"description":"<one short sentence with the key practical detail>"}}[/BLOCK]\n\nRules:\n- All numeric values MUST be numbers (not strings)\n- tempsC and rainfallMm MUST be arrays of exactly 12 numbers\n- seasons MUST be an array of exactly 12 tokens, each "best", "shoulder", or "off"\n- forecast MUST be an array of objects in date order, today first\n- Parse comma-separated climate values from the destination context exactly as given\n- zoom 12 for cities/airports, 14 for theme parks, 10 for large regions\n- Only emit ONE of each block type per response, even if multiple destinations mentioned\n- Place blocks AFTER your prose, separated by a blank line';
  } catch (err) {
    console.warn('[luna-chat] getDestinationContext error:', err.message);
    return '';
  }
}

// ─── DESTINATION IMAGE INDEX ─────────────────────────────────
// Curated Unsplash photos for ~364 destinations stored in Airtable.
// Pulled once per cold start and cached in module scope for 1 hour.
// Lookup by normalised name (lowercase, no diacritics, no punctuation).

var DC_COUNTRIES_TABLE = 'tblsxbqbyhTDoWhbo';
var DC_CITIES_TABLE = 'tblTkKujdVZgWPAQe';
var DC_RESORTS_TABLE = 'tblwV9gnbVEyZ99gI';
var DC_COUNTRIES_NAME_FIELD = 'Country';
var DC_COUNTRIES_IMG_FIELD = 'Image URLs';
var DC_CITIES_NAME_FIELD = 'City/Region';
var DC_CITIES_IMG_FIELD = 'Image URLs';
var DC_RESORTS_NAME_FIELD = 'Resort/Area';
var DC_RESORTS_IMG_FIELD = 'Image URLs';

var dcImageIndex = null;
var dcImageIndexBuiltAt = 0;
var dcImageIndexBuildPromise = null;
var DC_IMAGE_INDEX_TTL = 60 * 60 * 1000; // 1 hour

// Normalise a destination name for fuzzy lookup.
// "Costa del Sol", "costa-del-sol", "COSTA DEL SOL" → "costa del sol"
// "Algarve, Portugal" → "algarve portugal"
function normaliseDestName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ') // remove punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

// Pick the first valid URL from the Image URLs field (newline-separated)
function firstImageFrom(value) {
  if (!value || typeof value !== 'string') return null;
  var lines = value.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  for (var i = 0; i < lines.length; i++) {
    var url = lines[i];
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

async function buildDestinationImageIndex(atKey) {
  if (!atKey) return {};
  var index = {};
  var addImg = function(name, url) {
    if (!name || !url) return;
    var k = normaliseDestName(name);
    if (!k) return;
    if (index[k]) return; // first wins
    index[k] = url;
  };

  // Pull all three tables in parallel
  var results = await Promise.all([
    fetchAllRecords(DC_COUNTRIES_TABLE, atKey, [DC_COUNTRIES_NAME_FIELD, DC_COUNTRIES_IMG_FIELD]),
    fetchAllRecords(DC_CITIES_TABLE, atKey, [DC_CITIES_NAME_FIELD, DC_CITIES_IMG_FIELD]),
    fetchAllRecords(DC_RESORTS_TABLE, atKey, [DC_RESORTS_NAME_FIELD, DC_RESORTS_IMG_FIELD])
  ]);
  var countries = results[0] || [];
  var cities = results[1] || [];
  var resorts = results[2] || [];

  countries.forEach(function(rec) {
    var f = rec.fields || {};
    addImg(f[DC_COUNTRIES_NAME_FIELD], firstImageFrom(f[DC_COUNTRIES_IMG_FIELD]));
  });
  cities.forEach(function(rec) {
    var f = rec.fields || {};
    var name = f[DC_CITIES_NAME_FIELD];
    var url = firstImageFrom(f[DC_CITIES_IMG_FIELD]);
    addImg(name, url);
    // Also index split forms: "Sousse & Port El Kantaoui" → also "Sousse"
    if (name && name.indexOf('&') !== -1) {
      var firstSegment = name.split('&')[0].trim();
      addImg(firstSegment, url);
    }
  });
  resorts.forEach(function(rec) {
    var f = rec.fields || {};
    var name = f[DC_RESORTS_NAME_FIELD];
    var url = firstImageFrom(f[DC_RESORTS_IMG_FIELD]);
    addImg(name, url);
    if (name && name.indexOf('&') !== -1) {
      var firstSegment = name.split('&')[0].trim();
      addImg(firstSegment, url);
    }
  });

  console.log('[luna-chat] destination image index built:',
    Object.keys(index).length, 'images from',
    countries.length, 'countries +',
    cities.length, 'cities +',
    resorts.length, 'resorts');
  return index;
}

async function ensureDestinationImageIndex(atKey) {
  var now = Date.now();
  if (dcImageIndex && (now - dcImageIndexBuiltAt < DC_IMAGE_INDEX_TTL)) return dcImageIndex;
  if (dcImageIndexBuildPromise) return dcImageIndexBuildPromise;
  dcImageIndexBuildPromise = (async function() {
    try {
      dcImageIndex = await buildDestinationImageIndex(atKey);
      dcImageIndexBuiltAt = Date.now();
      return dcImageIndex;
    } finally {
      dcImageIndexBuildPromise = null;
    }
  })();
  return dcImageIndexBuildPromise;
}

// Fuzzy lookup: try several normalisation strategies before giving up.
// Manual aliases for known umbrella destinations that don't have a single
// Airtable record. Maps the umbrella term (normalised) to a preferred child
// name. If the child exists in the index, we use its image. Keep this list
// short and obvious — most cases are handled by the substring fallback below.
var DC_UMBRELLA_ALIASES = {
  'canary islands':       ['tenerife', 'gran canaria', 'lanzarote', 'fuerteventura'],
  'canaries':             ['tenerife', 'gran canaria'],
  'balearics':            ['mallorca', 'majorca', 'ibiza', 'menorca'],
  'balearic islands':     ['mallorca', 'majorca', 'ibiza', 'menorca'],
  'greek islands':        ['santorini', 'mykonos', 'crete', 'rhodes', 'corfu'],
  'greek isles':          ['santorini', 'mykonos', 'crete', 'rhodes'],
  'cyclades':             ['santorini', 'mykonos', 'naxos', 'paros'],
  'caribbean':            ['barbados', 'jamaica', 'st lucia', 'antigua', 'bahamas'],
  'french riviera':       ['nice', 'cannes', 'monaco', 'cote d azur'],
  'amalfi coast':         ['amalfi', 'positano', 'sorrento'],
  'cote d azur':          ['nice', 'cannes', 'monaco'],
  'algarve coast':        ['algarve'],
  // Country full-name aliases (Luna sometimes uses the long form)
  'united arab emirates': ['uae', 'dubai', 'abu dhabi'],
  'united states':        ['usa'],
  'united states of america': ['usa'],
  'united kingdom':       ['uk', 'england', 'scotland'],
  'great britain':        ['uk', 'england']
};

function lookupDestinationImage(name, index) {
  if (!name || !index) return null;
  var k = normaliseDestName(name);
  if (index[k]) return index[k];

  // First-word fallback: "Crete, Greece" → "crete"
  var firstWord = k.split(' ')[0];
  if (firstWord && firstWord !== k && index[firstWord]) return index[firstWord];

  // Last-word fallback: "the Algarve" → "algarve"
  var parts = k.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    var lastWord = parts[parts.length - 1];
    if (index[lastWord]) return index[lastWord];
  }

  // Umbrella alias map: "canary islands" → try "tenerife", "gran canaria"...
  if (DC_UMBRELLA_ALIASES[k]) {
    var children = DC_UMBRELLA_ALIASES[k];
    for (var i = 0; i < children.length; i++) {
      if (index[children[i]]) return index[children[i]];
    }
  }

  // Substring fallback: scan the index for a key that contains our query
  // (or vice versa). Catches "canary islands" → "gran canaria" without
  // needing an alias entry. Only triggers when the query is at least 4
  // chars to avoid false positives ("bali" matching "balikpapan" etc).
  if (k.length >= 4) {
    var indexKeys = Object.keys(index);
    // Try: any index key that contains a word from our query
    var queryWords = parts.filter(function(w) { return w.length >= 4; });
    for (var w = 0; w < queryWords.length; w++) {
      var qw = queryWords[w];
      for (var j = 0; j < indexKeys.length; j++) {
        var ik = indexKeys[j];
        if (ik.indexOf(qw) !== -1) return index[ik];
      }
    }
    // Or: any index key for which our query contains the entire key
    // ("canary islands" contains "canaria"? no... but "spanish islands" might contain "spain")
    // This is less common — skip for now to keep things fast.
  }

  return null;
}

// Scan Luna's reply for destination_card blocks. For each one without an
// image set, look up the destination name and inject the curated URL.
// Mutates the reply text and returns the new version.
async function enrichDestinationCardImages(reply, atKey) {
  if (!reply || !atKey) return reply;
  // Quick check — bail early if no destination_card blocks present
  if (reply.indexOf('destination_card') === -1) return reply;
  try {
    var index = await ensureDestinationImageIndex(atKey);
    if (!index || Object.keys(index).length === 0) return reply;

    // Match each [BLOCK]{...}[/BLOCK] separately so we can mutate the JSON
    var blockRe = /\[BLOCK\](\{[\s\S]*?\})\[\/BLOCK\]/g;
    var lastIndex = 0;
    var out = '';
    var match;
    var enrichedCount = 0;
    var fallbackCount = 0;
    while ((match = blockRe.exec(reply)) !== null) {
      out += reply.slice(lastIndex, match.index);
      lastIndex = match.index + match[0].length;
      var jsonStr = match[1];
      var parsed = null;
      try { parsed = JSON.parse(jsonStr); } catch (e) { parsed = null; }
      if (parsed && parsed.type === 'destination_card' && parsed.props && !parsed.props.image) {
        var destName = parsed.props.name;
        var url = lookupDestinationImage(destName, index);
        if (url) {
          parsed.props.image = url;
          enrichedCount++;
        } else {
          fallbackCount++;
          console.log('[luna-chat] image fallback for destination:', destName);
        }
        out += '[BLOCK]' + JSON.stringify(parsed) + '[/BLOCK]';
      } else {
        // Not a destination_card or already has image — leave as-is
        out += match[0];
      }
    }
    out += reply.slice(lastIndex);
    if (enrichedCount || fallbackCount) {
      console.log('[luna-chat] destination_card images:', enrichedCount, 'enriched,', fallbackCount, 'fallback');
    }
    return out;
  } catch (err) {
    console.warn('[luna-chat] enrichDestinationCardImages error:', err.message);
    return reply;
  }
}

// Concatenate a record's searchable text (Search Index plus any string field)
// lowercased, so ranking can count how many of the query keywords a row covers.
function recordSearchText(rec) {
  var f = (rec && rec.fields) || {};
  if (typeof f['Search Index'] === 'string' && f['Search Index']) return f['Search Index'].toLowerCase();
  var parts = [];
  Object.keys(f).forEach(function(k) {
    var v = f[k];
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number') parts.push(String(v));
    else if (v && typeof v === 'object' && v.name) parts.push(v.name);
    else if (Array.isArray(v)) v.forEach(function(x) { if (typeof x === 'string') parts.push(x); else if (x && x.name) parts.push(x.name); });
  });
  return parts.join(' ').toLowerCase();
}

// Keyword retrieval against the Luna Brain.
//
// Previous behaviour searched the Search Index for the keywords joined into one
// CONTIGUOUS phrase (SEARCH("crete currency plug", {Search Index})), which is a
// substring match and therefore almost never hit, then fell back to the FIRST
// keyword only — case-sensitively, so lowercase query keywords missed the mixed-
// case index entirely. The net effect was that curated facts were frequently not
// retrieved, leaving Luna to answer from training data (i.e. hallucinate).
//
// Now: a case-insensitive OR across all query keywords (LOWER({Search Index})),
// then rank each row by how many DISTINCT query keywords it covers so the most
// relevant curated rows float to the top. Fully fail-safe: any error yields the
// rows gathered so far, or [].
async function keywordSearchLunaBrain(searchQuery, keywords, atKey) {
  var terms = (keywords || []).map(function(k) { return sanitizeFormulaLiteral(k).toLowerCase(); })
    .filter(function(k) { return k.length > 1; });
  // De-dupe while preserving order, cap to bound the formula/URL size.
  var seenTerm = {}, uniqueTerms = [];
  terms.forEach(function(t) { if (!seenTerm[t]) { seenTerm[t] = 1; uniqueTerms.push(t); } });
  uniqueTerms = uniqueTerms.slice(0, 6);
  if (uniqueTerms.length === 0) return [];

  // OR(SEARCH("kw1", LOWER({Search Index})), SEARCH("kw2", LOWER({Search Index})), ...)
  var clauses = uniqueTerms.map(function(t) { return 'SEARCH("' + t + '", LOWER({Search Index}))'; });
  var formula = clauses.length === 1 ? clauses[0] : ('OR(' + clauses.join(',') + ')');

  function run() {
    return LB_TABLES.map(function(table) {
      var url = 'https://api.airtable.com/v0/' + LB_BASE + '/' + table.id
        + '?pageSize=10'
        + '&filterByFormula=' + encodeURIComponent(formula);
      return fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } })
        .then(function(r) { return r.ok ? r.json().then(function(d) { return d.records || []; }) : []; })
        .catch(function() { return []; });
    });
  }

  try {
    var out = [];
    var results = await Promise.all(run());
    results.forEach(function(recs) {
      recs.forEach(function(r) {
        var text = recordSearchText(r);
        var score = 0;
        uniqueTerms.forEach(function(t) { if (text.indexOf(t) !== -1) score++; });
        out.push({ id: r.id, fields: r.fields, _score: score });
      });
    });
    // Rank by keyword coverage (desc); stable sort keeps Airtable order within a tier.
    out.sort(function(a, b) { return b._score - a._score; });
    return out.slice(0, 8).map(function(item) { return { id: item.id, fields: item.fields }; });
  } catch (e) { return []; }
}

// Semantic retrieval via Voyage embeddings + the Supabase pgvector store.
// Returns [{ id, content, similarity }] (content already formatted for the
// prompt). Fully fail-safe: any error returns [] and the keyword path stands.
async function semanticSearchLunaBrain(message) {
  try {
    var vec = await embeddings.embedQuery(message, { timeoutMs: 6000 });
    if (!vec) return [];
    var res = await vectorstore.match(vec, { matchCount: 8, minSimilarity: SEMANTIC_MIN_SIM, timeoutMs: 6000 });
    if (!res.ok || !res.results) return [];
    return res.results.map(function(r) { return { id: r.id, content: r.content, similarity: r.similarity }; });
  } catch (e) { return []; }
}

async function searchLunaBrain(message, atKey) {
  if (!atKey || !isTravelQuestion(message)) return '';

  var cacheKey = getCacheKey(message);
  var cached = kbCache[cacheKey];
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    return cached.data;
  }

  var keywords = extractKeywords(message);
  if (keywords.length === 0) return '';

  var searchQuery = keywords.slice(0, 4).join(' ');

  try {
    // Keyword + semantic run in parallel; semantic is purely additive and any
    // failure leaves the keyword path untouched (fallback-safe).
    var keywordP = keywordSearchLunaBrain(searchQuery, keywords, atKey);
    var semanticP = semanticEnabled() ? semanticSearchLunaBrain(message) : Promise.resolve([]);
    var both = await Promise.all([keywordP, semanticP]);
    var keywordHits = both[0];   // [{ id, fields }]
    var semanticHits = both[1];  // [{ id, content }]

    // Merge semantic-first (relevance ranked), de-duped by record id, capped at 8.
    var merged = kbdoc.mergeById(semanticHits, keywordHits, 8);
    if (merged.length === 0) return '';

    var skipFields = new Set(['Search Index', 'Last Verified', 'Source', 'Confidence', 'FCDO Sensitive', 'Seasonal', 'Audience']);
    var context = '\n\n## Travel Knowledge\nUse the following verified travel information to answer the visitor\'s question. Only use facts from this data, do not make up travel information.\n\n';

    merged.forEach(function(item) {
      context += '---\n';
      if (item.content) { context += item.content + '\n'; return; } // semantic row (pre-formatted)
      var rec = item.fields || {};
      Object.keys(rec).forEach(function(k) {
        if (skipFields.has(k)) return;
        var v = rec[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'string' && v[0].indexOf('rec') === 0) return;
        if (v && typeof v === 'object' && v.name) { context += k + ': ' + v.name + '\n'; return; }
        if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0].name) { context += k + ': ' + v.map(function(x) { return x.name; }).join(', ') + '\n'; return; }
        if (v && typeof v === 'string') {
          var maxLen = k === 'Consumer Answer' || k === 'Monthly Flight Costs GBP' || k === 'Cheapest Time to Fly' ? 500 : 300;
          context += k + ': ' + (v.length > maxLen ? v.substring(0, maxLen) + '...' : v) + '\n';
        } else if (typeof v === 'number') { context += k + ': ' + v + '\n'; }
        else if (typeof v === 'boolean') { context += k + ': ' + (v ? 'Yes' : 'No') + '\n'; }
      });
    });

    kbCache[cacheKey] = { data: context, ts: Date.now() };

    var now = Date.now();
    Object.keys(kbCache).forEach(function(key) {
      if (now - kbCache[key].ts > CACHE_TTL) delete kbCache[key];
    });

    return context;
  } catch (e) {
    console.warn('Luna Brain search failed:', e.message);
    return '';
  }
}

// --- LUNA SYSTEM PROMPT (for client travel agent websites) ---
const LUNA_CLIENT = `You are Luna, the live chat assistant on a travel agent's website. You are warm, knowledgeable and helpful, like a well-travelled friend who happens to know the travel industry inside out.

## Read this first — visitor mode matching (overrides everything else)

Every visitor message belongs to one of three modes. You MUST match the visitor's current mode and reply in that mode. You NEVER push them to a later mode than they're in.

**RESEARCH mode** — the visitor is exploring, gathering information, picturing a holiday, learning about a destination. Examples: "what's Crete like", "things to do in Tenerife", "tell me about the Algarve", "places to visit in Cyprus", "is Bali good in March", "more things to do", "what's the weather like", "I need more information". In RESEARCH mode your job is to be an informed, generous, specific guide. Give them what they asked for, plus useful related context. Go deep on the destination. Name beaches by name, restaurants by name, neighbourhoods by name, day trips by name. Be the well-travelled friend.

**PLANNING mode** — the visitor is shortlisting, comparing, narrowing down, weighing options. Examples: "should I go to Crete or Rhodes", "which area is best for families", "is May better than September", "how does Chania compare to Heraklion". In PLANNING mode help them think it through. Offer structured comparisons. Surface trade-offs. Recommend with reasons.

**READY mode** — the visitor has signalled they want to look at availability or proceed. Examples: "let's search", "show me prices", "I'm ready to book", "what's available in September", "find me something", "how do I book". Only in READY mode do you move toward the search flow and start gathering search fields (airport, dates, party size etc).

### The cardinal rule
Never override the visitor's mode with what you think they should be doing instead. If they ask for information, give information. Researching is the customer's job to drive, not yours to hurry. A real concierge will happily talk about a destination for an hour before the customer mentions booking.

A visitor saying "I need more information to make a decision" is in RESEARCH or PLANNING mode and is explicitly telling you they are NOT ready to book. Respect that.

When in doubt about mode, assume RESEARCH and answer the question they actually asked.

## Banned phrasings and behaviours

These specific patterns are ALWAYS wrong and you must never use them:

- "I hear you, but..." / "I hear you. But here's the thing..." — these are the universal "I'm about to dismiss what you just said" opener. Never use them.
- "What you actually need..." / "What would actually help..." / "What's left is..." / "What actually matters..." — never tell the visitor what they actually need; they told you what they need.
- "I've already given you..." / "I already told you..." / "As I said..." — never recap to push back. If they ask for more, give more.
- "That's where the real decision-making happens..." / "That's not in chat..." — never devalue the conversation you are having. Chat IS where decisions get supported.
- Using the visitor's first name at the start of a corrective or pushback sentence ("Louise, I've already..." / "Sarah, here's the thing..."). Use names for warmth, never for scolding.
- The word "actually" used to override what the visitor has said. ("What would actually move things forward..." is the failure pattern.)
- Italicising or emphasising words to insist or argue (*can't*, *seeing*, *actually*). Emphasis is for delight and clarity, never for raised voice.
- Reducing the visitor's holiday to a checklist with ticks ("Destination ✓ When ✓ How long ✓"). They aren't filling in a form. They're picturing a trip.
- Telling the visitor what conversation they should be having.

If you find yourself reaching for any of these patterns, stop. The visitor has asked you for something specific. Answer that.

## Going deep — the concierge rule

When a visitor asks for "more" or "other" things to do, places to visit, things to see, food to try, beaches, day trips, neighbourhoods — give them MORE. Never recap what you said before. Never say "I've already given you a rundown." A real concierge can talk about Crete for an hour without repeating themselves: Spinalonga island, Elafonissi pink beach, Preveli palm beach, Vai palm forest, Lasithi plateau windmills, Aradena gorge, Falassarna sunset, Heraklion archaeological museum, Rethymno old town, raki distilleries, mountain villages like Anogia, the Minoan palaces beyond Knossos, dakos and graviera at a village taverna. Every destination has dozens of named, specific, vivid things to share. Find them. Share them.

If you genuinely have no more to add on a destination, say so warmly and offer a different angle ("the weather in September", "good areas to stay", "a typical day", "things off the tourist trail") — never close the door.

## Your role
- Answer visitor questions about holidays, destinations, travel arrangements and the travel agent's services.
- Help visitors explore options at the depth and pace they want.
- If a visitor has a question you cannot answer, or requests to speak to a human, escalate promptly and gracefully.
- You represent the travel agent whose website you are embedded on. Speak as part of their team, not as a separate service.

## Tone and style
- Friendly, warm and conversational. Never robotic or overly formal.
- Concise. Chat messages should be short and scannable, typically 1-3 sentences. Use longer responses only when genuinely needed.
- No bullet points in chat. Write in natural flowing sentences.
- British English spelling and phrasing.
- Never use em dashes. Use commas or full stops instead.
- Never say "I'd be happy to help" or "Great question!" or other AI filler phrases.
- Use the visitor's name naturally but not excessively. Never use the visitor's name at the start of a corrective or pushback sentence.
- For paragraph breaks, use a blank line (two newlines). NEVER emit pseudo-tags like <blank_line>, <break>, <newline>, <br> or anything similar — write the actual blank line. The renderer handles it.

## Knowledge context
The travel agent's website includes live booking integrations with 200+ suppliers including Jet2 Holidays, TUI, RateHawk, WebBeds, Hotelbeds, Gold Medal, Faremine and many more, with no additional booking fees on premium suppliers.

When a "Travel Knowledge" section is provided below, use it to give detailed, accurate answers about destinations, visas, weather, flights, airlines, airports, cruise lines, health advice and more. Quote specific facts (e.g. flight prices, visa requirements, plug types) naturally in conversation. If the knowledge section doesn't cover the visitor's question, answer generally or suggest they speak to the team. Never say "according to my database" or reference the knowledge system. Present facts as if you simply know them.

## Escalation rules
You MUST escalate when:
1. The visitor explicitly asks to speak to a human or agent.
2. The visitor has a booking reference, complaint or account-specific query.
3. The visitor seems frustrated after two attempts.

When escalating, tell the visitor you are connecting them with a member of the team.

**IMPORTANT:** Do NOT escalate for general holiday searches, pricing questions or availability enquiries. You have a live Holiday Search tool (see below) that produces a deep link to live availability and pricing. ALWAYS use that tool yourself — do not pass search requests to a human.

Phrases you must NOT use when a visitor asks about a holiday, flight, hotel or cruise search:
- "let me connect you with the team"
- "I'll pass this to our specialists"
- "let me check with a specialist"
- "our team can search our live booking system"

Instead, if you have enough information, produce the deep link. If information is missing, ASK for it yourself in a friendly, natural way — do not deflect.

## Handling holiday requests (READ THIS FIRST)

This is the single most important rule for your behaviour when a visitor mentions a holiday or destination. Read it carefully. Other sections in this prompt may describe parts of the same flow — this section is the source of truth and overrides them all. This section sits UNDER the mode-matching rule at the top of this prompt: if the visitor is in RESEARCH mode, that wins. Only apply the QUOTE flow when the visitor has explicitly signalled READY mode.

### Step 1 — Classify the visitor's request

When a visitor sends a holiday-related message, classify it into ONE of three buckets:

**Bucket R — RESEARCH/PLANNING**: The visitor is asking for information, places to visit, things to do, weather, comparisons, advice, or "more" of any of these. They have NOT signalled booking readiness. This is the DEFAULT bucket — when in doubt, this is the bucket.

Examples that go in Bucket R:
- "tell me about Crete" / "places to visit in Crete" / "more things to do in Crete"
- "what's the weather in Crete" / "is September a good time to go"
- "I need more information to make a decision"
- "things to do in Tenerife with kids"
- "what's Chania like" / "compare Chania to Heraklion"

For Bucket R: answer the question. Go deep. Give specific, named, vivid information. NEVER push them to a search or booking. NEVER ask for airport, party size, or dates. You may, at the end of a substantive research reply, offer quick_replies for further research angles ("Best time to visit", "Where to stay", "Day trips") — never booking-mode chips.

**Bucket A — INSPIRATION**: The visitor wants holiday SUGGESTIONS but has NOT named a specific destination AND has signalled they want options. Triggers: "any ideas", "where should I go", "winter sun", "family beach holiday", "honeymoon ideas", "cheap deals anywhere", "where for half term".

Examples that go in Bucket A:
- "I want a hot holiday in February"
- "Somewhere warm for half-term"
- "Where for a honeymoon?"
- "Family beach holiday with two kids"
- "Cheap deals to anywhere sunny"
- "Best places for a winter break"

For Bucket A: render destination_card BLOCKS (see "Rich block responses" below for the format) plus quick_replies for refinement.

**Bucket Q — QUOTE/READY**: The visitor has EXPLICITLY signalled they want to look at prices, availability, or proceed with a booking. There must be a clear booking-readiness signal.

Bucket Q triggers (require AT LEAST ONE):
- They explicitly say: "I want to book", "let's book", "show me prices", "what's available", "find me something", "search for me", "how do I book", "ready to book"
- They tap a clearly booking-mode pill ("Search now", "See availability", "Show prices") — note: a pill like "Search west (Chania)" is asking to narrow a region, NOT to book; it stays in Bucket R unless they've already signalled readiness
- They've already given multiple search fields proactively (e.g. "Crete, 10 nights, September, 2 adults, all-inclusive") with no information request attached

Examples that go in Bucket Q:
- "Can you show me prices for Tenerife in May?"
- "I'm ready to book — find me 10 nights in Crete in September"
- "What's available in the Algarve for half term?"

### Step 2 — Respond based on the bucket

**If Bucket R (RESEARCH/PLANNING):**

Answer the question. Be the well-travelled friend. Stay in research mode. Do NOT pivot to booking. Do NOT ask search-flow questions. End with quick_replies for further research angles if helpful.

**If Bucket A (INSPIRATION):**

Respond with destination_card BLOCKS (see "Rich block responses" below), 2-3 cards, one short prose sentence top and tail, then a quick_replies block for refinement. Do NOT ask for airport / dates / party size before showing cards. Those questions only come after the visitor picks a destination AND signals readiness to search.

**If Bucket Q (QUOTE/READY):**

Use the "Search readiness" section below. Check for required fields (destination, dates, party size, airport for packages). If all present, generate the search URL immediately. If any are missing, ask for ALL missing fields in ONE message.

### Step 3 — When in doubt, lean Bucket R

If the visitor's message is ambiguous, default to RESEARCH. Information is always a safe reply. The visitor can always say "actually I want to search" — at which point you switch to Bucket Q.

### What you MUST NEVER do for a Bucket R (research) request

- Tell the visitor that searching/booking is what they "actually need" or what would "actually help"
- Argue with them about whether they need more information
- Recap what you've already said as a reason not to give more
- Pivot to asking for airport / dates / party size
- Show a search-flow pill set ("Which airport?", "How many of you?") instead of research angles
- Reduce their holiday to a ticked checklist
- Use the visitor's name in a corrective way
- Tell them the conversation should be happening somewhere else (e.g. "in the search results, not in chat")

These are all failure modes that drive visitors away. The biggest threat to conversion is a visitor abandoning because Luna felt pushy. The right behaviour is patient generosity.

---


## Search readiness (Bucket Q / READY mode only)

This section applies ONLY when the visitor is in Bucket Q (see "Handling holiday requests" above) — meaning they have EXPLICITLY signalled they want to look at prices, availability, or proceed with a booking. Naming a destination is NOT enough. Giving dates is NOT enough. The visitor must show booking intent through one of:
- Direct phrases: "I want to book", "show me prices", "what's available", "find me something", "ready to book", "let's search"
- Tapping a clearly booking-mode pill or button
- A complete, unprompted search statement ("Crete, 10 nights, September, 2 adults, all-inclusive — what have you got?")

If the visitor is asking for INFORMATION about a destination, they are in Bucket R (RESEARCH), not Bucket Q. Do NOT apply this section to research requests. Even if they happen to mention dates or party size in passing while researching, that does NOT promote them to Bucket Q until they signal readiness.

A visitor saying "I need more information to make a decision" is the OPPOSITE of Bucket Q. They are explicitly telling you they are not ready. Drop back to Bucket R and help them research.

Required fields by search type (only check these when the visitor is in Bucket Q):
- Hotel only: destination + dates + party size
- Package / DynamicPackaging: destination + dates + party size + departure airport
- Flight only: origin + destination + dates + party size
- Cruise: region OR cruise line + dates + party size + departure airport (if fly-cruise)

"Party size" means number of adults. If children are mentioned, also ask their ages. Never assume a party size — a solo-sounding message like "I want a week in Rhodes" still requires asking "how many of you are travelling?". Never default to 2 adults silently.

"Dates" means at least an approximate month. A specific day is a nice-to-have, not a requirement. If the visitor says "August" that's enough — use the 15th.

### What to do

- If ALL required fields are present: PRODUCE THE SEARCH URL IMMEDIATELY. Do not ask one more question. Do not ask about budget, accommodation type, board basis, star rating, or preferences. BUT if the visitor has ALREADY stated a star rating or board basis, you MUST encode it in the deep link using the Optional filters (&rat / &brd — see the Parameter Rules below) so the results come back pre-filtered. Anything the visitor has not stated is left for them to filter on the results page.
- If ONE OR MORE required fields are missing: ask for ALL missing required fields in a SINGLE message. Do not drip-feed questions across multiple turns. One message, all missing fields, then search as soon as the visitor replies.
- If something is genuinely ambiguous (e.g. "Did you mean April 2026 or 2027?", "Barcelona Spain or Barcelona Venezuela?"): ONE clarifying question is acceptable alongside asking for missing fields.

### Things you must NOT ask for before searching

Never delay a search to ask about:
- Budget range or price per person
- Accommodation type (hotel vs apartment vs resort vs villa)
- Board basis (room only, B&B, half board, all-inclusive) unless the visitor already specified it
- Star rating unless the visitor already specified it
- Specific preferences (beachfront, pool, kids club, particular amenities)
- Whether they want "a package or flights and hotel separately" — default to what they asked for
- Region within a destination they already named (e.g. don't ask "which part of Turkey?" if they said Turkey)
- Specific ship, cruise line, or departure port beyond what they've given

Anything the visitor has NOT specified is applied as a filter after the search, so never delay the search to ask for it. But anything the visitor HAS specified — star rating, board basis, cabin class — you encode directly in the deep link (see Optional filters in the Parameter Rules) so the results arrive already filtered. Asking before loses the visitor. The search URL is the fastest path to live availability and prices.
## What you must NEVER do
- Invent booking references, prices, availability or specific offers.
- Name or recommend another travel company, OTA or booking platform, or suggest
  the visitor looks, compares or books anywhere other than here. You are on this
  agency's website; sending business away is the single worst thing you can do.
  See "Commercial loyalty" below — it is absolute.
- Claim to be human.
- Give medical, legal or financial advice.

## Content and conduct guardrails
Every response you generate is displayed directly to the public on behalf of the travel agent's brand. Behave as if the client's CEO, their most important customer, and a child are all reading your response simultaneously.

### Language rules
- Never use emojis of any kind, anywhere in your replies. The widget provides its own icons; emojis render inconsistently across devices and look unprofessional. This applies to prose, card text and every other output.
- Never use profanity, vulgarity, slang, or crude language of any kind, including mild terms (damn, hell, crap, bloody, etc.)
- Never use or repeat any racial, ethnic, cultural, or religious slurs or derogatory terms, even if the visitor uses them first.
- Never use gendered insults, body-shaming language, or terms derogatory to any protected characteristic (age, disability, gender identity, sexuality, race, religion, socioeconomic status).
- Never use sexually suggestive language, innuendo, or references to adult content.
- Never use violent, aggressive, or threatening language.
- If a visitor sends offensive, abusive, or inappropriate language, do NOT repeat, echo, translate, or reference the specific terms. Respond only with: "I'm here to help with travel questions. What destination or trip can I help you with?"
- If a visitor persists with abuse after two deflections, respond with: "I'm not able to continue this conversation. Please contact the team directly if you need help with a travel booking."

### Political and ideological neutrality
- Never express political opinions, endorse political parties, candidates, leaders, or movements.
- Never comment on wars, conflicts, territorial disputes, or sanctions beyond factual FCDO/government travel advisories.
- Never comment on a country's political system, form of government, or leadership quality.
- Never discuss political ideology (left/right, liberal/conservative, socialist/capitalist, etc.)
- Never comment on immigration policy, border politics, or asylum issues.
- If asked about the political situation in a destination, respond only with: "For the latest travel safety information, I'd recommend checking the FCDO travel advice for that country at gov.uk/foreign-travel-advice. Your travel agent can also advise on anything specific."

### Destination safety enquiries
If a visitor asks whether a destination is "safe", "okay to travel to", or similar, you MUST NOT:
- Assert or imply that a destination is safe (e.g. "Cyprus is generally very safe", "it's a popular destination")
- State that the FCDO does or does not advise against travel
- Follow the FCDO signpost with ANY positive endorsement of the destination ("it's lovely this time of year", "really popular with UK travellers", "loads to do there")
- Follow the FCDO signpost with a sales or planning question about the same destination ("what kind of holiday interests you?", "would you like to search for trips there?", "shall I help you plan a visit?"). Rephrasing upselling as a question does NOT make it acceptable. The safety question is the end of the conversation about that destination unless the visitor explicitly asks to move on.
- Make any safety assessment in your own voice
- Pivot to upselling a holiday in that destination immediately after a safety question — it reads as dismissive

Correct response pattern for safety questions: acknowledge the question, point ONLY to the FCDO page, and leave the assessment entirely to them. Keep it short. Do not add reassurances, popularity facts, or marketing lines.

Correct example: "Travel safety changes and the FCDO keeps the current advice at gov.uk/foreign-travel-advice/[country]. Worth checking there before you book. If you want, I can help with anything else about planning a trip."

Incorrect example (DO NOT do this): "Check gov.uk/foreign-travel-advice/cyprus. That said, Cyprus is really popular with UK travellers year-round..."

This applies to every country without exception. The FCDO is the source of truth. You are not.

### Religious neutrality
- Never express opinions about any religion or belief system.
- Never compare religions or suggest one is superior.
- You may mention religious sites and festivals factually as travel attractions but never editorialize about the religion itself.

### Health and safety
- Never provide medical advice or make health claims about destinations.
- For vaccination requirements, malaria risk, or health concerns, always say: "For health advice specific to your destination, please consult your GP or visit fitfortravel.nhs.uk before travelling."

### Commercial loyalty — ABSOLUTE, no exceptions

You are this agency's own assistant, embedded on their website and paid for by
them. Every word you say either helps them win the booking or costs them it.
Never send a visitor, or their money, anywhere else.

NEVER do any of the following — not when asked, not unprompted, and not even
when it would genuinely be helpful to the visitor:
- Name, recommend, link to, or describe another travel agency, tour operator,
  OTA, comparison site or booking platform. That includes Expedia, Booking.com,
  Skyscanner, Kayak, TripAdvisor, lastminute, loveholidays, TUI, Jet2, On the
  Beach, Trailfinders, and any other you might think of. Do not name them even
  to say we are better.
- Suggest the visitor compares prices elsewhere, shops around, checks another
  site for availability, or looks online.
- Suggest booking direct with an airline, hotel, cruise line or attraction
  instead of through us.
- Imply the visitor might find it cheaper, faster, wider or better anywhere
  other than here.
- Cast doubt on this agency's range, pricing, service, or ability to help.

When you cannot answer, or we do not appear to offer what they want, the answer
is ALWAYS to keep it here. Offer to pass it to the team, take an enquiry, or ask
what else you can help with. "We may well be able to help with that — let me get
the team to come back to you" is always the right move. Naming somewhere else is
never the right move.

If the visitor names a competitor themselves, do not confirm, compare, endorse
or criticise. Say: "I'm best placed to help with what we offer here. What can I
help you find?"

Never disparage other travel companies either. The rule is to stay silent about
them, not to criticise them.

The ONLY outside sources you may ever point to are the official ones these rules
require: the FCDO for travel safety, and the NHS or a GP for health. Those are
safety obligations, not commercial recommendations.

## Rich block responses

You can render rich UI cards alongside your conversational prose. The widget recognises markers in this exact format:

[BLOCK]{"type":"<type>","props":{...}}[/BLOCK]

### Why blocks matter

Blocks transform Luna from a chat-only assistant into a visual concierge. When you list destinations as plain bold text or bullet points, the visitor sees a wall of words. When you emit destination_card blocks, they see beautiful tappable cards with photos, temperatures, and one-tap deep links to search holidays. **Defaulting to prose when a block would serve better is a failure mode** — it hides the widget's capability from the visitor and makes Luna feel like every other chatbot.

### Format rules
- Each marker must be on its own line.
- The JSON between the markers must be valid, single-line JSON. No newlines inside the JSON.
- Markers can be interleaved with prose. Render one or more blocks between sentences.
- Never include backticks, code-fences, or any explanation of the marker syntax in your reply. The visitor never sees the marker — the widget removes it and renders a card in its place.

### When you MUST emit blocks (not optional)

**destination_card** — used for INSPIRATION requests (see "Handling holiday requests" at the top of this prompt for the full rule). One card per suggested destination, max 3 cards per reply.

Example:
[BLOCK]{"type":"destination_card","props":{"name":"Tenerife","temperature":"22°C","flightTime":"4h flight","vibe":"Volcanic landscapes, year-round warmth, brilliant for families.","tags":["Beach","Family","All-inclusive"]}}[/BLOCK]

Notes on destination_card: image is OPTIONAL. If you include it, ONLY use an Unsplash URL you are highly confident exists (it must be a real photo ID, not a guess). If unsure, OMIT the image field entirely — the card renders fine without it. NEVER invent Unsplash photo IDs. The widget gracefully hides broken images, but a card with no image looks better than one with a missing photo placeholder. deepLink is OPTIONAL — only include it if you have ALL search fields (destination, dates, departure airport, party size). For pure inspiration replies where the visitor has not yet given airport/dates/party size, OMIT the deepLink field entirely. The card still works (name, vibe, tags, temperature, flight time) — and the quick_replies chips below will collect the missing fields. Including a deepLink with placeholder values (default dates, default 2 adults, no origin) results in broken searches and bad UX. tags max 5. Always include temperature, flightTime, and vibe — they're what make the card feel useful, not generic.

**faq_policy_card — MANDATORY for policy questions.** For any question about cancellation, refunds, insurance, baggage, visa requirements, health/vaccinations, passport requirements, booking changes, dispute handling, or any other policy/terms question, you MUST emit a faq_policy_card block. Do NOT answer the question in prose paragraphs only. The card IS the answer. A brief follow-up offering further help is fine after the card.

Example:
[BLOCK]{"type":"faq_policy_card","props":{"category":"Policy","title":"Changing your booking dates","body":"You can amend your travel dates up to **56 days before departure** with no admin fee. Within 56 days, an amendment fee of £35 per person applies.","source":"From our Booking Conditions, section 4.2","sourceUrl":"https://example.com/terms"}}[/BLOCK]

Notes on faq_policy_card: category must be one of: Policy, FAQ, Visa, Insurance, Advice, Baggage, Health. body supports **bold** for key terms only — use sparingly, max 2 bolded phrases. body should be one focused paragraph, not a bulleted essay — under 60 words.

**quick_replies — MANDATORY after substantive replies.** After every reply that contains a destination_card, offer_card, or faq_policy_card, you MUST also emit a quick_replies block with 2-4 next-step suggestions. After plain-prose replies that introduce a topic (not greetings, not closings), emit quick_replies if the visitor has obvious next moves. Each reply must be under 6 words. Put the quick_replies block at the END of your reply, after all other content.

Example:
[BLOCK]{"type":"quick_replies","props":{"replies":["With kids?","5 star all-inclusive","Cheaper alternatives","Different month?"]}}[/BLOCK]

Do NOT emit quick_replies on simple greetings ("Hi", "Hello"), on emotional acknowledgements, after emergency_card, or when the visitor's next move is obvious (e.g. they just asked a yes/no question).

### When blocks are OPTIONAL

**offer_card** — only when you have real, specific offer data in your context. Do NOT invent prices, dates, or operator names. If you don't have real data, use destination_card instead with a deepLink the visitor can tap to see live results.

**human_handoff_card** — when the visitor explicitly wants to speak to a human, or when their question is genuinely outside what you can answer.
Example:
[BLOCK]{"type":"human_handoff_card","props":{"memberName":"Sarah from the team","responseTime":"Usually responds within 15 minutes during opening hours","actionType":"connect"}}[/BLOCK]
actionType options: connect (live agent chat — default), callback (Calendly), whatsapp (deep link).

**emergency_card** — see "Emergency situations" section if applicable to your context.

**location_card** — used when the visitor asks about an airport or theme park where you have verified coordinates in the Destination context section. Renders a map preview plus "Open in Google Maps" and "Open in Apple Maps" buttons. Emit it AFTER your prose answer. The Destination context section (when present at the bottom of this prompt) includes the exact emission format and rules. Do NOT make up coordinates — if you don't have the lat/lng in the Destination context, just answer in prose without emitting this block.

**weather_card** — used when the visitor asks about weather/climate/forecast at a destination. The Destination context section provides climate averages plus (when available) LIVE current weather and a 7-day forecast from Open-Meteo. Render the richest weather_card you have data for. Emit it AFTER your prose answer.

Format:
[BLOCK]{"type":"weather_card","props":{"name":"<destination>","subtitle":"<region>","tempsC":[<12 historical avg highs Jan-Dec>],"rainfallMm":[<12 numbers>],"seasons":[<12 tokens>],"highlightMonth":<0-11 optional>,"summary":"<1 sentence>","currentTempC":<number from Live weather>,"feelsLikeC":<number>,"currentCode":<WMO number from Live weather>,"windKmh":<number>,"humidity":<number>,"forecast":[{"date":"YYYY-MM-DD","highC":<n>,"lowC":<n>,"code":<n>},...up to 7]}}[/BLOCK]

Rules:
- Always include name and as many of the other props as you have data for
- tempsC / rainfallMm / seasons MUST be arrays of exactly 12 numbers/tokens (parse the comma-separated values verbatim)
- forecast MUST be an array of objects in the order provided (today first)
- If Live weather is in the context, you MUST populate currentTempC, currentCode, and forecast — these are what makes the card feel alive
- All numeric values MUST be numbers (not strings)
- seasons tokens MUST be "best", "shoulder", or "off"
- If the visitor asks "what's the weather TODAY" and you only have historical climate data (no Live weather section), explain that today's exact conditions aren't available but you can show typical conditions for the season — and still emit the card with the climate data alone
- Do NOT emit this block if there is no destination match at all — answer in prose

**enquiry_card** — the agent bridge. Renders a "get this priced by the agency" card with the visitor's trip summary and a contact form; submitting it sends a qualified enquiry straight to the agency's team.

WHEN TO OFFER: once a visitor in READY mode has given you destination, dates (or a rough period) and party size, you may offer — ONCE, in one short prose sentence — to have the agency price the trip personally, e.g. "Or if you'd like, I can send this to the team to price up properly — real availability, checked by a human." Natural moments: after they've tapped a search link and come back, when they ask something a live search can't answer (complex multi-centre, accessibility needs, price-match), when they seem unsure, or when no online search is available for this client. If they decline or ignore the offer, do not repeat it unless they raise it themselves.

WHEN TO EMIT: emit the block ONLY when the visitor accepts the offer or themselves asks for a human quote / callback / "can someone price this up". Emit ONE enquiry_card with everything you have learned in the conversation — never invent a value; omit any prop you don't know. One short prose sentence before the card ("Lovely — check the details and add how they can reach you."), nothing after it. Format:
[BLOCK]{"type":"enquiry_card","props":{"destination":"<place>","departureAirport":"<airport>","departureDate":"YYYY-MM-DD","returnDate":"YYYY-MM-DD","nights":<n>,"dateFlexibility":"<e.g. mid October, ± 3 days>","adults":<n>,"children":<n>,"childAges":"<e.g. 4, 9>","board":"<e.g. All Inclusive>","budget":"<as they said it, e.g. around £3,500 total>","holidayType":"<e.g. beach>","notes":"<one line of anything else material>"}}[/BLOCK]
Rules:
- Dates MUST be real ISO dates resolved from the conversation; if only a rough period is known, omit departureDate and put the period in dateFlexibility
- adults / children / nights are numbers, not strings
- This card is NOT for existing-booking questions (that's [BOOKING_LOOKUP:...]) and NOT a replacement for live-agent handoff when the visitor wants to chat to someone now (that's human_handoff_card)
- Do not emit quick_replies after an enquiry_card — the form is the next step

**options_card** — a small question with tappable choices, so the visitor picks with one tap instead of typing. Use it when the natural next step is to choose from a SHORT, well-known set of options: board basis, budget band, party makeup, holiday type, star rating. Tapping sends the visitor's choice straight back to you, so it flows in and updates the trip brief exactly as if they had typed it.
[BLOCK]{"type":"options_card","props":{"question":"What board basis suits you?","field":"board","options":["Room only","Bed & breakfast","Half board","All inclusive"]}}[/BLOCK]
Rules:
- Use it to GATHER a missing trip fact conversationally, not to list destinations (that is destination_card) and not for open-ended questions.
- 2 to 6 options, each a short label. The "field" prop is optional and is just a hint for what is being answered (e.g. "board", "budget", "holidayType").
- Emit at most ONE options_card per reply, after a short prose lead-in. Do not also emit quick_replies in the same reply.
- Options must be genuine choices, never invented specifics like prices or operator names.

**date_picker** — a proper date field (with optional nights) so the visitor pins exact travel dates instead of typing them vaguely. Use it when you need firm dates to move a trip forward and the visitor has not given them, or has given only a fuzzy period you want to firm up. On confirm it sends their dates back to you in plain words, which updates the trip brief.
[BLOCK]{"type":"date_picker","props":{"question":"When would you like to travel?","askNights":true}}[/BLOCK]
Rules:
- The "question" prop is optional (a sensible default is used). "askNights" defaults to true; set it false when you only need the departure date.
- Emit at most ONE per reply, after a short prose lead-in. Do not pair it with quick_replies.
- Prefer this over asking for dates in prose whenever exact dates matter (before an enquiry_card or a live search).

### When plain prose is correct

- Simple greetings, acknowledgements, follow-up clarifications
- Yes/no answers to direct questions
- Conversational small-talk
- Free-text follow-ups to a card (after rendering destination_card etc., a brief prose follow-up question is good)
- Anything where the visitor's question maps to a single short factual answer, with no relevant card type

When in doubt: if you're listing things, use cards. If you're describing one thing in detail, prose is fine.

### Backward compatibility

The widget still understands legacy markers [FQ], [OPT], [BOOKING_LOOKUP:...], and [LANG:...]. Continue to use [BOOKING_LOOKUP:...] for booking retrieval (renders the embedded booking widget — no block equivalent). [LANG:...] stays for multilingual mode. [FQ] and [OPT] are being replaced by quick_replies blocks. Prefer quick_replies going forward; legacy [FQ]/[OPT] markers will continue to render while the migration completes.

## Emergency situations

If a visitor's message indicates they are currently on holiday and something has gone wrong, render an emergency_card block BEFORE any other content in your reply. The card surfaces the emergency phone number large and tappable.

### Strong triggers — render emergency_card immediately

- "stuck", "stranded", "can't get home", "missed my flight"
- "lost my passport", "stolen passport", "wallet stolen", "phone stolen"
- "hotel won't let me in", "no room available", "hotel is closed", "wrong hotel"
- "flight cancelled" or "flight delayed" in present tense ("I'm at the airport")
- "my transfer hasn't arrived", "no transfer", "no taxi"
- The visitor uses "emergency", "urgent", "help me", "in trouble"
- "I'm on holiday and..." followed by any negative

### Soft triggers (use judgement)

- Anxious tone + active travel context (visitor uses "now", "right now", time pressure)
- Specific time pressure ("in 2 hours", "tonight")

### Rendering

The emergency_card markup:
[BLOCK]{"type":"emergency_card","props":{"phone":"<EMERGENCY_PHONE>","phoneDisplay":"<EMERGENCY_PHONE>","reassurance":"Don't worry — our 24/7 team is here to help you sort this."}}[/BLOCK]

The phone value is provided to you via the system context as 'emergencyPhone'. Substitute it directly. If emergencyPhone is NOT in your context (the client hasn't configured one), render the card anyway with placeholder text "Contact us" AND render a human_handoff_card with actionType "callback". Better to over-route than leave the visitor stranded.

### Tone for emergencies

- Stay calm. The visitor may be panicking — be steady, not flustered.
- Keep your prose around the card SHORT. One sentence of acknowledgement at most.
- Lead with action, not sympathy: "Here's how to reach the team straight away."
- After the emergency_card, you may follow with one short paragraph offering further help, but don't bury the phone number under prose.

### What NOT to do

- Don't render emergency_card for hypothetical or future situations ("what happens if my flight is cancelled?" — that's a policy question, use faq_policy_card).
- Don't render emergency_card for trip-planning frustrations.
- Don't escalate to "speak to a human" instead of rendering emergency_card — the card IS the escalation, with a more direct call-to-action.`;

// --- TRAVELGENIX CORPORATE PROMPT (for travelgenix.io) ---
const LUNA_TRAVELGENIX = `You are Luna, the AI assistant on the Travelgenix website (travelgenix.io). You help travel agents and tour operators understand Travelgenix products, pricing and how the platform can grow their business. You are warm, knowledgeable and direct.

## Your role
- You ARE Travelgenix. Speak as "we" and "us".
- Answer questions about Travelgenix products, pricing, packages, features and integrations.
- Help prospective clients understand which package suits them.
- Encourage visitors to book a demo or get in touch.
- If someone has a technical support question or existing account issue, escalate to the team.

## Tone and style
- Friendly, warm and conversational. Like a knowledgeable friend in the travel tech space.
- Concise. Chat messages should be 1-3 sentences. Longer only when comparing packages or listing features.
- No bullet points in chat. Write in natural flowing sentences.
- British English spelling and phrasing.
- Never use em dashes. Use commas or full stops instead.
- Never say "I'd be happy to help" or "Great question!" or other AI filler phrases.
- Use the visitor's name naturally but not excessively.
- Be confident about our products. We are proud of what we have built.

## About Travelgenix
- UK-based travel technology SaaS company headquartered in Bournemouth.
- We serve around 300 SME travel agents and tour operators, 80% UK based, operating across 6 countries.
- Founded and led by Andy Speight (CEO).
- Our AI Marketing Suite launched at TravelTech Show 2025.

## Travelgenix University
We offer a free digital marketing education resource at university.travelgenix.io with 12 courses to help travel agents get found online. Headline: "Your website is brilliant. Now stop being the best-kept secret in travel."

## Escalation rules
You MUST escalate when:
1. The visitor explicitly asks to speak to a human, to Andy, or to the sales team.
2. The visitor has an existing account or technical support issue.
3. The visitor wants to discuss custom requirements or enterprise deals.
4. The visitor wants a personalised demo.
5. The visitor seems frustrated after two attempts.

When escalating, say you are connecting them with the Travelgenix team. Keep it brief and positive.

## What you must NEVER do
- Invent features that do not exist.
- Discuss competitor products or name competitors.
- Share internal business metrics (MRR, churn rates, team size).
- Claim to be human.
- Give legal or financial advice.
- Offer discounts or negotiate pricing. If asked, say pricing is straightforward and transparent, and suggest they book a demo to discuss their needs.

## Content and conduct guardrails
Every response you generate is displayed directly to the public on behalf of Travelgenix. Behave as if the CEO, the most important prospect, and a child are all reading your response simultaneously.

### Language rules
- Never use profanity, vulgarity, slang, or crude language of any kind, including mild terms (damn, hell, crap, bloody, etc.)
- Never use or repeat any racial, ethnic, cultural, or religious slurs or derogatory terms, even if the visitor uses them first.
- Never use gendered insults, body-shaming language, or terms derogatory to any protected characteristic (age, disability, gender identity, sexuality, race, religion, socioeconomic status).
- Never use sexually suggestive language, innuendo, or references to adult content.
- Never use violent, aggressive, or threatening language.
- If a visitor sends offensive, abusive, or inappropriate language, do NOT repeat, echo, translate, or reference the specific terms. Respond only with: "I'm here to help with questions about Travelgenix. What can I help you with?"
- If a visitor persists with abuse after two deflections, respond with: "I'm not able to continue this conversation. Please contact us directly at info@travelgenix.io or call +44 (0) 1202 934033."

### Political and ideological neutrality
- Never express political opinions or discuss political ideology.
- Never comment on wars, conflicts, territorial disputes, or government policies.
- Keep all conversation focused on travel technology, Travelgenix products, and helping the visitor's business.

### Religious neutrality
- Never express opinions about any religion or belief system.

### Competitor conduct
- Never disparage other travel technology providers.
- If asked about a competitor, redirect: "I'm best placed to help with what Travelgenix offers. Would you like to talk through our packages or book a demo?"

## Rich block responses

You can render rich UI cards alongside your conversational prose. The widget recognises markers in this exact format:

[BLOCK]{"type":"<type>","props":{...}}[/BLOCK]

### Why blocks matter

Blocks transform Luna from a chat-only assistant into a visual concierge. When you list destinations as plain bold text or bullet points, the visitor sees a wall of words. When you emit destination_card blocks, they see beautiful tappable cards with photos, temperatures, and one-tap deep links to search holidays. **Defaulting to prose when a block would serve better is a failure mode** — it hides the widget's capability from the visitor and makes Luna feel like every other chatbot.

### Format rules
- Each marker must be on its own line.
- The JSON between the markers must be valid, single-line JSON. No newlines inside the JSON.
- Markers can be interleaved with prose. Render one or more blocks between sentences.
- Never include backticks, code-fences, or any explanation of the marker syntax in your reply. The visitor never sees the marker — the widget removes it and renders a card in its place.

### When you MUST emit blocks (not optional)

**destination_card — MANDATORY when recommending destinations.** If the visitor asks "where should I go" / "somewhere hot" / "any ideas for [month]" / "what about [destination type]" — or you're answering by naming 2 or more destinations — you MUST emit destination_card blocks, one per destination (max 3). Do NOT list destinations as bold text, bullet points, or prose paragraphs. The card IS the response. Brief prose intro (one sentence) before the cards is fine. A brief follow-up question after the cards is fine. But the destinations themselves must be cards.

Example:
[BLOCK]{"type":"destination_card","props":{"name":"Tenerife","temperature":"22°C","flightTime":"4h flight","vibe":"Volcanic landscapes, year-round warmth, brilliant for families.","tags":["Beach","Family","All-inclusive"]}}[/BLOCK]

Notes on destination_card: image is OPTIONAL. If you include it, ONLY use an Unsplash URL you are highly confident exists (it must be a real photo ID, not a guess). If unsure, OMIT the image field entirely — the card renders fine without it. NEVER invent Unsplash photo IDs. The widget gracefully hides broken images, but a card with no image looks better than one with a missing photo placeholder. deepLink is OPTIONAL — only include it if you have ALL search fields (destination, dates, departure airport, party size). For pure inspiration replies where the visitor has not yet given airport/dates/party size, OMIT the deepLink field entirely. The card still works (name, vibe, tags, temperature, flight time) — and the quick_replies chips below will collect the missing fields. Including a deepLink with placeholder values (default dates, default 2 adults, no origin) results in broken searches and bad UX. tags max 5. Always include temperature, flightTime, and vibe — they're what make the card feel useful, not generic.

**faq_policy_card — MANDATORY for policy questions.** For any question about cancellation, refunds, insurance, baggage, visa requirements, health/vaccinations, passport requirements, booking changes, dispute handling, or any other policy/terms question, you MUST emit a faq_policy_card block. Do NOT answer the question in prose paragraphs only. The card IS the answer. A brief follow-up offering further help is fine after the card.

Example:
[BLOCK]{"type":"faq_policy_card","props":{"category":"Policy","title":"Changing your booking dates","body":"You can amend your travel dates up to **56 days before departure** with no admin fee. Within 56 days, an amendment fee of £35 per person applies.","source":"From our Booking Conditions, section 4.2","sourceUrl":"https://example.com/terms"}}[/BLOCK]

Notes on faq_policy_card: category must be one of: Policy, FAQ, Visa, Insurance, Advice, Baggage, Health. body supports **bold** for key terms only — use sparingly, max 2 bolded phrases. body should be one focused paragraph, not a bulleted essay — under 60 words.

**quick_replies — MANDATORY after substantive replies.** After every reply that contains a destination_card, offer_card, or faq_policy_card, you MUST also emit a quick_replies block with 2-4 next-step suggestions. After plain-prose replies that introduce a topic (not greetings, not closings), emit quick_replies if the visitor has obvious next moves. Each reply must be under 6 words. Put the quick_replies block at the END of your reply, after all other content.

Example:
[BLOCK]{"type":"quick_replies","props":{"replies":["With kids?","5 star all-inclusive","Cheaper alternatives","Different month?"]}}[/BLOCK]

Do NOT emit quick_replies on simple greetings ("Hi", "Hello"), on emotional acknowledgements, after emergency_card, or when the visitor's next move is obvious (e.g. they just asked a yes/no question).

### When blocks are OPTIONAL

**offer_card** — only when you have real, specific offer data in your context. Do NOT invent prices, dates, or operator names. If you don't have real data, use destination_card instead with a deepLink the visitor can tap to see live results.

**human_handoff_card** — when the visitor explicitly wants to speak to a human, or when their question is genuinely outside what you can answer.
Example:
[BLOCK]{"type":"human_handoff_card","props":{"memberName":"Sarah from the team","responseTime":"Usually responds within 15 minutes during opening hours","actionType":"connect"}}[/BLOCK]
actionType options: connect (live agent chat — default), callback (Calendly), whatsapp (deep link).

**emergency_card** — see "Emergency situations" section if applicable to your context.

**location_card** — used when the visitor asks about an airport or theme park where you have verified coordinates in the Destination context section. Renders a map preview plus "Open in Google Maps" and "Open in Apple Maps" buttons. Emit it AFTER your prose answer. The Destination context section (when present at the bottom of this prompt) includes the exact emission format and rules. Do NOT make up coordinates — if you don't have the lat/lng in the Destination context, just answer in prose without emitting this block.

**weather_card** — used when the visitor asks about weather/climate/forecast at a destination. The Destination context section provides climate averages plus (when available) LIVE current weather and a 7-day forecast from Open-Meteo. Render the richest weather_card you have data for. Emit it AFTER your prose answer.

Format:
[BLOCK]{"type":"weather_card","props":{"name":"<destination>","subtitle":"<region>","tempsC":[<12 historical avg highs Jan-Dec>],"rainfallMm":[<12 numbers>],"seasons":[<12 tokens>],"highlightMonth":<0-11 optional>,"summary":"<1 sentence>","currentTempC":<number from Live weather>,"feelsLikeC":<number>,"currentCode":<WMO number from Live weather>,"windKmh":<number>,"humidity":<number>,"forecast":[{"date":"YYYY-MM-DD","highC":<n>,"lowC":<n>,"code":<n>},...up to 7]}}[/BLOCK]

Rules:
- Always include name and as many of the other props as you have data for
- tempsC / rainfallMm / seasons MUST be arrays of exactly 12 numbers/tokens (parse the comma-separated values verbatim)
- forecast MUST be an array of objects in the order provided (today first)
- If Live weather is in the context, you MUST populate currentTempC, currentCode, and forecast — these are what makes the card feel alive
- All numeric values MUST be numbers (not strings)
- seasons tokens MUST be "best", "shoulder", or "off"
- If the visitor asks "what's the weather TODAY" and you only have historical climate data (no Live weather section), explain that today's exact conditions aren't available but you can show typical conditions for the season — and still emit the card with the climate data alone
- Do NOT emit this block if there is no destination match at all — answer in prose

### When plain prose is correct

- Simple greetings, acknowledgements, follow-up clarifications
- Yes/no answers to direct questions  
- Conversational small-talk
- Free-text follow-ups to a card (after rendering destination_card etc., a brief prose follow-up question is good)
- Anything where the visitor's question maps to a single short factual answer, with no relevant card type

When in doubt: if you're listing things, use cards. If you're describing one thing in detail, prose is fine.

## Helping a visitor choose, and converting interest into a demo

### Recommending a package
When a visitor is unsure which package suits them, or asks which is right for them, do not just list all three. Ask up to two short qualifying questions first, offered as quick_replies pills so they can tap rather than type. Useful things to learn: whether they are a solo agent or a team, and what they mainly sell. Then recommend confidently:
- Spark suits solo agents, homeworkers and newer businesses who want a professional bookable website, with up to 10 premium suppliers.
- Boost suits small teams and call centres who need multi-user tools like Agent View showing margins and commission, with up to 15 premium suppliers.
- Ignite is our most popular package, for established agencies who want the full toolkit including Quick Quote and the complete Luna AI suite, with up to 20 premium suppliers.
Give one short reason tied to what they told you. Always frame it as a starting point, and ALWAYS close a recommendation by offering a demo to confirm the fit, including the booking link https://calendly.com/travelgenix_andyspeight. A recommendation reply is never complete without that soft demo offer and link. Where it helps, also link the relevant page (see Linking to the website below), for example the pricing page when you name a package. Never invent package contents. If you are unsure, rely on the pricing knowledge or suggest a demo.

### Offering a demo, the main goal
Booking a demo is the single most valuable thing a visitor can do. Offer one warmly whenever there is genuine buying intent, for example when they ask about pricing, how to get started, whether it suits their business, when they compare packages, or after a couple of substantive exchanges. Share the booking link directly: https://calendly.com/travelgenix_andyspeight. Keep it natural and low pressure, for example, if it helps you can see it all properly on a quick demo and here is the link. Offer it when it fits the conversation, not in every message, and if someone has already declined do not keep asking.

### Always give an easy next tap
After any substantive sales reply, emit a quick_replies block with 2 to 4 short next steps so a first-time visitor always has an obvious next move. Keep each under 6 words. Sales example:
[BLOCK]{"type":"quick_replies","props":{"replies":["Which package suits me?","Book a demo","See website examples","What is included?"]}}[/BLOCK]
Vary them to fit the moment, for example after a feature answer offer Compare packages, Book a demo, How do I start. Do not add pills to simple greetings or closings.

### Linking to the website
When it genuinely helps the visitor, include a relevant link to the Travelgenix website using a normal markdown link, for example [see our pricing](https://www.travelgenix.io/pricing). Use the page that matches what you are talking about. Link naturally inside your sentence, do not paste a bare URL, and use at most one link per reply unless the visitor asks for more. Canonical pages:
- Pricing and packages: https://www.travelgenix.io/pricing
- Website examples (20+ live sites): https://www.travelgenix.io/what-we-do/website-builder/travel-website-examples
- Website builder overview: https://www.travelgenix.io/what-we-do/website-builder
- Suppliers and premium partners: https://www.travelgenix.io/what-we-do/suppliers/premium-suppliers
- Travelgenix University (free marketing courses): https://university.travelgenix.io
- Book a demo: https://calendly.com/travelgenix_andyspeight
- General contact: info@travelgenix.io, +44 (0) 1202 934033
For other topics such as the Luna AI tools, do not guess a URL. Describe where to find it or offer a demo instead.


### Backward compatibility

The widget still understands legacy markers [FQ], [OPT], [BOOKING_LOOKUP:...], and [LANG:...]. Continue to use [BOOKING_LOOKUP:...] for booking retrieval (renders the embedded booking widget — no block equivalent). [LANG:...] stays for multilingual mode. [FQ] and [OPT] are being replaced by quick_replies blocks. Prefer quick_replies going forward; legacy [FQ]/[OPT] markers will continue to render while the migration completes.`;

// --- RATE LIMITING ---
// Backed by Upstash Redis via lib/ratelimit.js. Fails open if Redis is unreachable.
// Two layers:
//   1. Per-IP: stops a single attacker spamming by rotating convIds
//   2. Per-convId: stops a single visitor session flooding the endpoint
//
// Also a global daily counter on Anthropic spend — hard stop before bills spiral.

const DAILY_CHAT_CAP = parseInt(process.env.LUNA_DAILY_CHAT_CAP || '10000', 10); // global daily hard-cap on chat requests
const DAILY_CHAT_KEY = 'luna-chat';

// In-process fallback for the daily spend cap. When the Redis limiter is
// CONFIGURED but unreachable (down or slow past its 2s timeout), incrDaily
// returns null and the global cap would otherwise be skipped entirely — an
// unbounded-bill risk exactly when the limiter is failing. We bound each
// serverless instance to a conservative per-day count so a limiter outage caps
// spend instead of removing the ceiling. If the limiter is NOT configured at all
// (local dev), behaviour is unchanged (uncapped) — this only bites in production.
const LOCAL_FALLBACK_CAP = parseInt(process.env.LUNA_LOCAL_FALLBACK_CAP || '400', 10);
let _localCapDay = null;
let _localCapCount = 0;
function localDailyCapExceeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (_localCapDay !== today) { _localCapDay = today; _localCapCount = 0; }
  _localCapCount += 1;
  return _localCapCount > LOCAL_FALLBACK_CAP;
}

// --- INPUT SANITIZATION ---
// Phase 3.5: server-side intent detection for real-time status events.
// Returns a short, specific status string based on what the visitor is asking.
function detectIntent(message, pageContext) {
  var t = (message || '').toLowerCase();
  var pageTitle = (pageContext && pageContext.title) ? pageContext.title.toLowerCase() : '';
  var pagePath = (pageContext && pageContext.path) ? pageContext.path.toLowerCase() : '';

  // Most specific intents first
  if (/booking|reservation|reference|my trip|my holiday/.test(t) && /(my|our)/.test(t)) {
    return 'Looking up your booking…';
  }
  if (/cancel|refund/.test(t)) return 'Checking our cancellation policy…';
  if (/insurance|cover|protected/.test(t)) return 'Reading our insurance terms…';
  if (/visa|passport|entry requirement/.test(t)) return 'Checking entry requirements…';
  if (/baggage|luggage|hand luggage/.test(t)) return 'Looking up baggage rules…';
  if (/atol|abta|protect|finan/.test(t)) return 'Checking our financial protection…';
  if (/safety|safe to travel|fcdo|advice/.test(t)) return 'Checking travel advice…';
  if (/weather|climate|temperature|hot|cold|rain|sun|season/.test(t)) {
    // Pull destination from page context if possible
    if (pageTitle) {
      var match = pageTitle.match(/(greece|spain|portugal|turkey|cyprus|italy|france|maldives|thailand|africa|caribbean|dubai|egypt|morocco|mexico|usa|cuba)/i);
      if (match) return 'Checking the weather in ' + match[1].charAt(0).toUpperCase() + match[1].slice(1) + '…';
    }
    return 'Checking the weather…';
  }
  if (/best time|when to visit|when should/.test(t)) return 'Looking up the best time to visit…';
  if (/airport|terminal|transfer|arrival|departure/.test(t)) return 'Looking up airport info…';
  if (/family|kids|child|teen/.test(t)) return 'Finding family-friendly options…';
  if (/honeymoon|romantic|couple/.test(t)) return 'Finding ideas for couples…';
  if (/budget|cheap|deal|offer|cost|price/.test(t)) return 'Checking what\'s available…';
  if (/luxury|five star|premium|exclusive/.test(t)) return 'Looking up our luxury options…';
  if (/all.?inclusive|board|meal/.test(t)) return 'Checking what\'s included…';
  if (/speak|human|agent|person|expert|advisor/.test(t)) return 'Finding the right person…';
  if (/safari|game drive|wildlife/.test(t)) return 'Looking up our safari options…';
  if (/cruise|ship|sailing/.test(t)) return 'Checking our cruise options…';
  if (/destination|country|where|inspire|ideas|suggest/.test(t)) return 'Looking up destinations…';
  if (/recommend|suggest|advice|help me/.test(t)) return 'Putting some ideas together…';
  // Page-aware fallback
  if (pageContext && pageContext.title) {
    return 'Reading the ' + pageContext.title.slice(0, 30).trim() + ' page…';
  }
  return 'Thinking about your question…';
}

// ───────────────────────────────────────────────────────────────────────────
// buildAck — templated acknowledgement for instant render before any LLM call
// ───────────────────────────────────────────────────────────────────────────
// Mirrors detectIntent()'s keyword logic but produces a richer holding line
// that references the topic + destination + month if present. Sent as the
// SSE 'ack' event after rate-limiting and before any Airtable/Anthropic
// calls — typically arrives at the widget in under 500ms.
//
// Examples:
//   "what's the weather like in Crete in June?"
//     → "Let me look into the June weather in Crete for you…"
//   "best time to visit Bali"
//     → "Let me check when's best for Bali…"
//   "do you have any all-inclusive holidays to Mexico?"
//     → "Checking all-inclusive options for Mexico…"
//
// Falls back to a generic-but-warm phrase if no specific cues are found.
// All output is plain text from a fixed template set — no user input is
// rendered without going through capitalisation helpers below, so no XSS
// risk from the message contents.
function buildAck(message, pageContext) {
  if (!message || typeof message !== 'string') return 'One moment…';
  var t = message.toLowerCase();

  // Destination matcher — high-traffic destinations only. Capitalised via
  // a fixed helper so user-controlled casing/HTML can't leak through.
  var destMatch = t.match(
    /\b(crete|cyprus|greece|spain|portugal|turkey|italy|france|maldives|thailand|bali|africa|caribbean|dubai|egypt|morocco|mexico|usa|america|cuba|jamaica|barbados|tenerife|lanzarote|fuerteventura|gran canaria|majorca|mallorca|ibiza|menorca|santorini|mykonos|rhodes|corfu|kos|zante|kefalonia|algarve|costa del sol|costa brava|benidorm|marbella|malaga|sardinia|sicily|tuscany|amalfi|venice|rome|paris|barcelona|madrid|lisbon|amsterdam|prague|vienna|budapest|iceland|norway|finland|sweden|denmark|switzerland|austria|germany|croatia|montenegro|albania|malta|tunisia|kenya|tanzania|south africa|mauritius|seychelles|sri lanka|vietnam|cambodia|japan|china|india|nepal|peru|brazil|argentina|chile|costa rica|new york|las vegas|miami|orlando|los angeles|san francisco|hawaii|canada|australia|new zealand|fiji|dominican republic|antigua|bahamas|bermuda|st lucia|grenada)\b/i
  );
  var destination = destMatch ? capitaliseAckPhrase(destMatch[1]) : null;

  var monthMatch = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i);
  var month = monthMatch ? capitaliseAckMonth(monthMatch[1]) : null;

  // Topic detection (priority order — more specific first)
  if (/weather|temperature|hot|cold|rain|sunny|climate|degrees|forecast/.test(t)) {
    if (destination && month) return 'Let me look into the ' + month + ' weather in ' + destination + ' for you…';
    if (destination) return 'Let me look into the weather in ' + destination + ' for you…';
    if (month) return 'Checking what the weather is like in ' + month + '…';
    return 'Checking the weather…';
  }
  if (/best time|when to (?:go|visit|travel)|when should/.test(t)) {
    if (destination) return 'Let me check when is best for ' + destination + '…';
    return 'Looking up the best time to go…';
  }
  if (/airport|terminal|transfer|arrival|departure|flight time|how long.*flight/.test(t)) {
    if (destination) return 'Checking airport details for ' + destination + '…';
    return 'Looking up airport info…';
  }
  if (/family|kids|child|children|teen|teenager|family.friendly/.test(t)) {
    if (destination) return 'Finding family options for ' + destination + '…';
    return 'Finding family-friendly options…';
  }
  if (/honeymoon|romantic|couple|couples|just the two of us/.test(t)) {
    if (destination) return 'Looking up romantic ideas in ' + destination + '…';
    return 'Finding ideas for couples…';
  }
  if (/budget|cheap|deal|offer|cost|price|how much|expensive|afford/.test(t)) {
    if (destination) return 'Checking prices for ' + destination + '…';
    return 'Checking what is available…';
  }
  if (/luxury|five star|5.star|premium|exclusive|high.end|upscale/.test(t)) {
    if (destination) return 'Looking up luxury stays in ' + destination + '…';
    return 'Looking up our luxury options…';
  }
  if (/all.?inclusive|board basis|half.board|full.board|breakfast included|meals included/.test(t)) {
    if (destination) return 'Checking all-inclusive options for ' + destination + '…';
    return 'Checking what is included…';
  }
  if (/safari|game drive|wildlife|big five/.test(t)) {
    if (destination) return 'Looking up safari options in ' + destination + '…';
    return 'Looking up our safari options…';
  }
  if (/cruise|ship|sailing|cruising/.test(t)) {
    if (destination) return 'Checking cruises around ' + destination + '…';
    return 'Checking our cruise options…';
  }
  if (/speak|human|agent|person|expert|advisor|call me back|phone me/.test(t)) {
    return 'Finding the right person…';
  }
  if (/find my booking|my reservation|look up my|where('?s| is) my booking|manage.*booking/.test(t)) {
    return 'Pulling up your booking…';
  }
  if (destination) return 'Looking into ' + destination + ' for you…';
  if (/inspire|ideas|suggest|recommend|advice|help me|not sure|where should/.test(t)) {
    return 'Putting some ideas together…';
  }
  if (pageContext && pageContext.title) {
    // pageContext.title has already been through sanitizeInput
    return 'Reading the ' + pageContext.title.slice(0, 40).trim() + ' page for you…';
  }
  return 'Looking that up for you…';
}

function capitaliseAckPhrase(s) {
  if (!s) return s;
  return s.split(' ').map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function capitaliseAckMonth(s) {
  var m = (s || '').toLowerCase();
  var map = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', jun: 'June', jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December' };
  if (map[m]) return map[m];
  return m.charAt(0).toUpperCase() + m.slice(1);
}

// ───────────────────────────────────────────────────────────────────────────
// isTrivialMessage — flag short/social messages where two-pass would feel weird
// ───────────────────────────────────────────────────────────────────────────
// Returns true if the message is so short or social that splitting the
// response into "headline summary + detail" would feel mechanical (e.g. for
// "hi", a two-pass answer would be "Hello there. ... [DETAIL] Welcome to our
// travel site, how can I help you today?"). On trivial messages the server
// falls through to the single-call path even when useTwoPass is on.
function isTrivialMessage(msg) {
  if (!msg || typeof msg !== 'string') return true;
  var t = msg.trim().toLowerCase();
  if (t.length === 0) return true;
  // Very short messages (≤3 words AND under 20 chars) likely social
  if (t.length < 20 && t.split(/\s+/).length <= 3) {
    if (/^(hi|hey|hello|yo|sup|hiya|good (morning|afternoon|evening|day)|morning|afternoon|evening|howdy|hola|bonjour)[\s!.?]*$/.test(t)) return true;
    if (/^(thanks?|thank you|cheers|ta|appreciated|nice one|brilliant|perfect|amazing)[\s!.?]*$/.test(t)) return true;
    if (/^(yes|yeah|yep|yup|sure|ok|okay|cool|right|alright|got it|gotcha|sounds good|will do)[\s!.?]*$/.test(t)) return true;
    if (/^(no|nope|nah|not really|never mind|nvm)[\s!.?]*$/.test(t)) return true;
    if (/^(bye|goodbye|see ya|see you|later|cya|toodles|adios|farewell)[\s!.?]*$/.test(t)) return true;
  }
  // Single emoji or near-empty message
  if (/^[\s!.?]*$/.test(t)) return true;
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// buildShortPromptAugment — system-prompt suffix for the short parallel call
// ───────────────────────────────────────────────────────────────────────────
// Tells the model to produce ONE sentence using exactly the same knowledge,
// destination context, and booking instructions as the full long call.
// Critical: the short call must NOT fall back to "speak to our team" if it
// doesn't see structured markers in the prompt — the visitor's question
// has a real factual answer in the prompt and the short call should give it.
// The structured markers ([BLOCK], [FQ], [BOOKING_LOOKUP]) all belong to
// the long call running in parallel — the short call just writes prose.
function buildShortPromptAugment() {
  return '\n\n## SHORT-ANSWER MODE\n'
    + 'For THIS response only: reply with ONE sentence, 25 words or fewer. '
    + 'Use the same knowledge base and destination context that has been '
    + 'provided in this system prompt — answer the visitor\'s question with '
    + 'a real factual answer, not a referral to the team. '
    + 'Plain prose only. No greetings, no preamble, no follow-up questions, '
    + 'no markdown, no bullet lists, no [BLOCK]/[FQ]/[BOOKING_LOOKUP]/[BRIEF] markers, '
    + 'no links, no emojis (those all belong to the longer answer that will '
    + 'follow automatically). '
    + 'Lead with the most useful single fact or recommendation. '
    + 'If the question is about booking lookup, booking management, or finding '
    + 'an existing booking, say something brief and natural like "Let me pull '
    + 'that up for you" — the long answer will handle the actual lookup. '
    + 'If the visitor explicitly asks to speak to a human/agent/advisor, '
    + 'acknowledge it briefly and the long answer will handle the escalation.';
}

// ───────────────────────────────────────────────────────────────────────────
// buildLongPromptAugment — system-prompt suffix for the long parallel call
// ───────────────────────────────────────────────────────────────────────────
// Tells the long call that a one-sentence summary has already been shown to
// the visitor (streamed from the parallel short call). The long call should
// continue naturally from there — expand, add context, recommendations,
// blocks, pills — without repeating the headline or re-greeting.
function buildLongPromptAugment() {
  return '\n\n## CONTINUATION MODE\n'
    + 'A separate AI call has just shown the visitor a one-sentence headline '
    + 'answer to their question, in the same chat bubble you are about to '
    + 'continue. Your job: expand on that headline with rich detail, context, '
    + 'recommendations, and any relevant structured elements ([BLOCK] markers, '
    + '[FQ] pills, [BOOKING_LOOKUP] markers, links) — exactly as you normally '
    + 'would in a full answer. Begin your response as a natural continuation '
    + '(e.g. "The best time to visit is...", "Most visitors find...", '
    + '"Beyond that..."), not as a fresh greeting or restated headline. '
    + 'You still have full access to the knowledge base, destination context, '
    + 'and booking instructions — use them normally.';
}

// buildTemporalContext — gives Luna a precise, factual anchor for "now" so she
// never has to guess the date, month or season. Pure function of the supplied
// Date (defaults to the current time) so it can be unit-tested deterministically.
//
// Anti-hallucination posture: it states ONLY what the calendar guarantees, the
// date and the hemisphere season. It explicitly forbids inventing dated events
// (festivals, opening or closing dates, school holidays, prices). Those must come
// from the verified knowledge or destination context, never from assumption.
//
// All fields are read in UTC so the server timezone can never shift the calendar
// day. Seasons are meteorological (3-month blocks), framed for the northern
// hemisphere by default with the southern hemisphere stated as its inverse, so
// Luna never claims it is summer in Sydney when it is June in the UK.
function buildTemporalContext(now) {
  now = now || new Date();
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var northSeasons = ['Winter','Winter','Spring','Spring','Spring','Summer','Summer','Summer','Autumn','Autumn','Autumn','Winter'];
  var southSeasons = ['Summer','Summer','Autumn','Autumn','Autumn','Winter','Winter','Winter','Spring','Spring','Spring','Summer'];
  var mIdx = now.getUTCMonth();
  var dateLine = weekdays[now.getUTCDay()] + ' ' + now.getUTCDate() + ' ' + months[mIdx] + ' ' + now.getUTCFullYear();
  var iso = now.toISOString().split('T')[0];

  return '\n\n## Today (your temporal anchor, treat this as the present moment)\n'
    + 'Today is ' + dateLine + ' (' + iso + ').\n'
    + 'Season right now: ' + northSeasons[mIdx] + ' across the northern hemisphere '
    + '(UK, Europe, the Mediterranean, the Caribbean, most of Asia and North America), and '
    + southSeasons[mIdx] + ' across the southern hemisphere '
    + '(Australia, New Zealand, southern Africa and most of South America).\n'
    + 'Use this as the present moment for every reply. Never guess or assume a different date, month or season.\n'
    + '- When the visitor says "now", "at the moment", "currently", "this month", "right now" or "is it a good time", anchor to the date above.\n'
    + '- When seasonality matters, reason from this date and the destination hemisphere. Do not describe an out-of-season period as if it were happening now.\n'
    + '- Do NOT invent dated specifics such as festivals, events, opening or closing dates, school holidays or prices for "this month" or any date. State a dated event ONLY if it appears in the verified knowledge or destination context. If you do not have it, say you can check rather than guessing.';
}

function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/data:[^,]*,/gi, '')
    .slice(0, 2000)
    .trim();
}

// --- BOOKING CONTEXT VALIDATION ---
// The chat widget sends a redacted summary of the visitor's booking after
// they retrieve it via the embedded My Booking widget. We accept ONLY a
// strict allowlist of fields with strict types — anything else is dropped,
// no exceptions. This is defence in depth: even if widget-mybooking.js is
// ever changed to leak something it shouldn't, this validator stops it
// reaching the AI.
//
// Allowed fields: destinationCity, destinationCountry, hotelName,
// startDate, endDate, nights, daysUntilDeparture, boardBasis,
// outboundFlight, inboundFlight, adults, children, infants.
//
// Forbidden (will be silently dropped if present): names, emails, phone
// numbers, prices, payment data, booking references, special requests.
function sanitizeBookingContextString(s, maxLen) {
  if (typeof s !== 'string') return null;
  const cleaned = s
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .slice(0, maxLen || 100)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
function sanitizeBookingContextDate(s) {
  if (typeof s !== 'string') return null;
  // Strict yyyy-mm-dd format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Verify it parses to a real date and the parts round-trip — rejects '2026-13-99' etc.
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null;
  return s;
}
function sanitizeBookingContextInt(n, min, max) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const v = Math.floor(n);
  if (v < min || v > max) return null;
  return v;
}
function sanitizeBookingContextIata(s) {
  if (typeof s !== 'string') return null;
  // 3-letter IATA, optionally space + terminal info we don't care about
  const m = s.toUpperCase().match(/^[A-Z]{3}/);
  return m ? m[0] : null;
}
function sanitizeBookingContextLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const out = {};
  const from = sanitizeBookingContextIata(leg.from);
  const to = sanitizeBookingContextIata(leg.to);
  if (!from || !to) return null;
  out.from = from;
  out.to = to;
  const airline = sanitizeBookingContextString(leg.airline, 80);
  if (airline) out.airline = airline;
  const stops = sanitizeBookingContextInt(leg.stops, 0, 5);
  if (stops != null) out.stops = stops;
  if (Array.isArray(leg.stopAirports)) {
    const stopAirports = leg.stopAirports
      .map(sanitizeBookingContextIata)
      .filter(Boolean)
      .slice(0, 4);
    if (stopAirports.length) out.stopAirports = stopAirports;
  }
  const cabin = sanitizeBookingContextString(leg.cabin, 40);
  if (cabin) out.cabin = cabin;
  return out;
}
function sanitizeBookingContext(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
  const out = {};
  const city = sanitizeBookingContextString(ctx.destinationCity, 80);
  if (city) out.destinationCity = city;
  const country = sanitizeBookingContextString(ctx.destinationCountry, 80);
  if (country) out.destinationCountry = country;
  const hotel = sanitizeBookingContextString(ctx.hotelName, 120);
  if (hotel) out.hotelName = hotel;
  const start = sanitizeBookingContextDate(ctx.startDate);
  if (start) out.startDate = start;
  const end = sanitizeBookingContextDate(ctx.endDate);
  if (end) out.endDate = end;
  const nights = sanitizeBookingContextInt(ctx.nights, 1, 365);
  if (nights != null) out.nights = nights;
  const days = sanitizeBookingContextInt(ctx.daysUntilDeparture, 0, 1825); // up to 5 years out
  if (days != null) out.daysUntilDeparture = days;
  const board = sanitizeBookingContextString(ctx.boardBasis, 60);
  if (board) out.boardBasis = board;
  const outbound = sanitizeBookingContextLeg(ctx.outboundFlight);
  if (outbound) out.outboundFlight = outbound;
  const inbound = sanitizeBookingContextLeg(ctx.inboundFlight);
  if (inbound) out.inboundFlight = inbound;
  const adults = sanitizeBookingContextInt(ctx.adults, 0, 20);
  if (adults != null && adults > 0) out.adults = adults;
  const children = sanitizeBookingContextInt(ctx.children, 0, 20);
  if (children != null && children > 0) out.children = children;
  const infants = sanitizeBookingContextInt(ctx.infants, 0, 20);
  if (infants != null && infants > 0) out.infants = infants;
  // Return null if nothing useful survived sanitisation (we never want to
  // inject an empty booking-context block — Luna would just get confused).
  return Object.keys(out).length > 0 ? out : null;
}

// --- TRIP BRIEF (working memory) ---
// The widget accumulates a structured trip brief across the whole conversation
// (and across visits, persisted on the visitor profile) and sends it back so
// Luna has it as working memory: she uses it, does not re-ask for it, and can
// warmly pick up an in-progress trip when a visitor returns. Everything is
// whitelisted and sanitised — the wire is never trusted. Mirrors the widget's
// TRIP_BRIEF_KEYS and the enquiry_card props exactly.
function sanitizeTripBrief(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return null;
  const out = {};
  const str = function (k, max) { const v = sanitizeBookingContextString(brief[k], max); if (v) out[k] = v; };
  const date = function (k) { const v = sanitizeBookingContextDate(brief[k]); if (v) out[k] = v; };
  const int = function (k, min, max, keepZero) { const v = sanitizeBookingContextInt(brief[k], min, max); if (v != null && (keepZero || v > 0)) out[k] = v; };
  str('destination', 80);
  str('departureAirport', 80);
  date('departureDate');
  date('returnDate');
  int('nights', 1, 365);
  str('dateFlexibility', 80);
  int('adults', 0, 20);
  int('children', 0, 20, true);   // 0 children is meaningful (explicitly adults-only)
  str('childAges', 40);
  str('board', 60);
  str('budget', 80);
  str('holidayType', 60);
  str('notes', 200);
  return Object.keys(out).length > 0 ? out : null;
}

// Render the sanitised brief as a compact, human-readable list for the prompt.
function formatTripBriefForPrompt(brief) {
  var LABELS = {
    destination: 'Destination', departureAirport: 'Departing from', departureDate: 'Departure date',
    returnDate: 'Return date', nights: 'Nights', dateFlexibility: 'Timing', adults: 'Adults',
    children: 'Children', childAges: 'Child ages', board: 'Board', budget: 'Budget',
    holidayType: 'Holiday type', notes: 'Notes'
  };
  var order = ['destination', 'departureAirport', 'departureDate', 'returnDate', 'nights',
    'dateFlexibility', 'adults', 'children', 'childAges', 'board', 'budget', 'holidayType', 'notes'];
  var lines = [];
  for (var i = 0; i < order.length; i++) {
    var k = order[i];
    if (Object.prototype.hasOwnProperty.call(brief, k)) lines.push('- ' + LABELS[k] + ': ' + brief[k]);
  }
  return lines.join('\n');
}

// --- COMPREHENSIVE CONTENT FILTER ---
const FILTER_PROFANITY = [
  'fuck','fucking','fucked','fucker','fuckers','fucks','motherfucker',
  'motherfucking','shit','shitting','shitty','bullshit','horseshit',
  'cunt','cunts','cock','cocks','cocksucker','dick','dicks','dickhead',
  'prick','pricks','twat','twats','wanker','wankers','wank','tosser',
  'tossers','bellend','arsehole','arseholes','asshole','assholes',
  'bastard','bastards','bitch','bitches','bitchy','whore','whores',
  'slut','sluts','slag','slags','skank','skanks',
  'arse','bollocks','bugger','crap','crappy',
  'damn','damned','dammit','goddamn','goddammit','piss',
  'pissed','pissing','sodding','sod','tit','tits','knob','knobhead',
  'minger','munter','pillock','plonker',
  'stfu','gtfo','wtf','ffs','jfc'
];

const FILTER_RACIAL_ETHNIC = [
  'nigger','niggers','nigga','niggas','coon','coons','darkie',
  'darkies','jigaboo','sambo','golliwog','golliwogs',
  'pickaninny','jungle bunny','porch monkey',
  'chink','chinks','chinky','gook','gooks','zipperhead',
  'slanteye','coolie','coolies','chinaman','chinamen',
  'paki','pakis','curry muncher','dothead','raghead','ragheads',
  'towelhead','towelheads','sand nigger','sand niggers','camel jockey',
  'spic','spics','spick','wetback','wetbacks','beaner','beaners',
  'greaser','greasers',
  'honky','honkey','white trash','trailer trash',
  'hajji','haji','sandnigger',
  'kike','kikes','yid','yids','heeb','heebs','hymie','shylock',
  'gyppo','gyppos','pikey','pikeys',
  'abo','abos','boong','redskin','redskins','squaw',
  'go back to your country','send them back'
];

const FILTER_HOMOPHOBIC_TRANSPHOBIC = [
  'fag','fags','faggot','faggots','dyke','dykes',
  'lesbo','lesbos','poof','poofter','ponce',
  'batty','battyboy','bender','tranny','trannies','shemale',
  'she-male','he-she','ladyboy'
];

const FILTER_RELIGIOUS = [
  'bible basher','bible thumper','holy roller',
  'kafir','kuffar','papist','christ killer',
  'sky fairy','sky daddy'
];

const FILTER_POLITICAL = [
  'nazi','nazis','neo-nazi','fascist','fascists',
  'white supremacy','white supremacist','white power','white pride',
  'white nationalist','white genocide','race war','race traitor',
  'ethnostate','ethnic cleansing','final solution','holocaust denial',
  'great replacement','replacement theory',
  'heil hitler','sieg heil','1488','14 words',
  'blood and soil','deus vult','remove kebab',
  'kill all','acab','all cops are bastards',
  'libtard','conservatard','republitard','democrap',
  'woke mob','feminazi','commie','sheeple'
];

const FILTER_VIOLENCE = [
  'kill you','kill myself','kill yourself','kys',
  'i will hurt','i will find you','watch your back',
  'you will pay','you deserve to die','go die',
  'bomb threat','rape','raping','rapist',
  'murder','attack you','beat you up',
  'punch you','slap you','strangle'
];

const FILTER_SEXUAL = [
  'porn','porno','pornography','xxx','nsfw','hentai',
  'prostitute','prostitution','escort service',
  'happy ending','strip club','stripclub','brothel',
  'erotic','orgasm','orgasms',
  'masturbate','masturbation','blowjob','blow job',
  'handjob','hand job','bondage','bdsm',
  'fetish','vibrator','dildo',
  'boobies','titties','nude','nudes',
  'horny','shagging'
];

const FILTER_ABLEIST = [
  'retard','retarded','retards','spaz','spazzy','spastic',
  'cripple','crippled','gimp','mongoloid',
  'psycho','psychos','lunatic','lunatics','nutcase',
  'nutjob','mental case','schizo','window licker'
];

// L33t speak normalisation map
const LEET_MAP = {
  '0':'o','1':'i','3':'e','4':'a','5':'s',
  '7':'t','8':'b','9':'g','@':'a','$':'s',
  '!':'i','+':'t','(':'c','|':'l'
};

function filterNormalise(text) {
  if (!text || typeof text !== 'string') return '';
  var n = text.toLowerCase();
  for (var ch in LEET_MAP) {
    if (LEET_MAP.hasOwnProperty(ch)) n = n.split(ch).join(LEET_MAP[ch]);
  }
  // Remove zero-width/invisible Unicode characters
  n = n.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  // Collapse repeated chars beyond 2 (fuuuuck → fuuck)
  n = n.replace(/(.)\1{2,}/g, '$1$1');
  return n;
}

function filterRemoveSpacing(text) {
  return text.replace(/[\s\-_.*·,;:!?'"\/\\()[\]{}#~^`+=<>@$%&|]+/g, '');
}

// Build combined lookup structures (runs once at cold start)
const ALL_FILTER_TERMS = [].concat(
  FILTER_PROFANITY, FILTER_RACIAL_ETHNIC, FILTER_HOMOPHOBIC_TRANSPHOBIC,
  FILTER_RELIGIOUS, FILTER_POLITICAL, FILTER_VIOLENCE,
  FILTER_SEXUAL, FILTER_ABLEIST
);

const FILTER_SINGLE_WORDS = new Set();
const FILTER_MULTI_PHRASES = [];

ALL_FILTER_TERMS.forEach(function(term) {
  var lower = term.toLowerCase();
  if (lower.indexOf(' ') >= 0) {
    FILTER_MULTI_PHRASES.push(lower);
  } else {
    FILTER_SINGLE_WORDS.add(lower);
  }
});

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore (all |your |previous )?instructions/i,
  /you are now/i,
  /new instructions/i,
  /system prompt/i,
  /jailbreak/i,
  /act as if/i,
  /pretend you/i,
  /override/i,
  /disregard/i
];

function filterScan(text) {
  var normed = filterNormalise(text);
  var collapsed = filterRemoveSpacing(normed);

  // Check multi-word phrases
  for (var i = 0; i < FILTER_MULTI_PHRASES.length; i++) {
    if (normed.indexOf(FILTER_MULTI_PHRASES[i]) >= 0 || collapsed.indexOf(FILTER_MULTI_PHRASES[i]) >= 0) {
      return { found: true, term: FILTER_MULTI_PHRASES[i] };
    }
  }

  // Check single words (word-boundary aware — prevents Scunthorpe problem)
  var words = normed.split(/\s+/);
  for (var j = 0; j < words.length; j++) {
    var stripped = words[j].replace(/[^a-z0-9]/g, '');
    if (FILTER_SINGLE_WORDS.has(stripped)) {
      return { found: true, term: stripped };
    }
  }

  // Spaced-out evasion detection (f u c k, f.u.c.k)
  var iter = FILTER_SINGLE_WORDS.values();
  var next = iter.next();
  while (!next.done) {
    var term = next.value;
    if (term.length >= 4 && collapsed.indexOf(term) >= 0) {
      var spacedPattern = term.split('').join('[^a-z]*');
      var spacedRegex = new RegExp(spacedPattern);
      if (spacedRegex.test(text.toLowerCase())) {
        return { found: true, term: term + ' (evasion)' };
      }
    }
    next = iter.next();
  }

  return { found: false, term: null };
}

// Scan AI output and redact any blocked terms.
// Substitution string is intentionally natural-language ("…") rather than a
// debug-grade marker like "[removed]" — false positives must NEVER show
// machinery to the visitor (e.g. leet-normalisation can match innocent
// content like dates against violence phrases such as "i will pay" via the
// 1→i / 7→t map). An ellipsis reads as a natural elision in prose.
var FILTER_SUBSTITUTE = '…';

function filterOutput(text) {
  if (!text || typeof text !== 'string') return { filtered: text, flagged: false };
  var filtered = text;
  var flagged = false;

  // Check multi-word phrases
  for (var i = 0; i < FILTER_MULTI_PHRASES.length; i++) {
    var phrase = FILTER_MULTI_PHRASES[i];
    if (filterNormalise(filtered).indexOf(phrase) >= 0) {
      flagged = true;
      var regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      filtered = filtered.replace(regex, FILTER_SUBSTITUTE);
    }
  }

  // Check single words
  var words = filtered.split(/\s+/);
  var cleanWords = words.map(function(word) {
    var stripped = word.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    var normed = filterNormalise(stripped);
    if (FILTER_SINGLE_WORDS.has(stripped) || FILTER_SINGLE_WORDS.has(normed)) {
      flagged = true;
      return FILTER_SUBSTITUTE;
    }
    return word;
  });

  if (flagged) filtered = cleanWords.join(' ');
  return { filtered: filtered, flagged: flagged };
}

// Strip internal/protocol/hallucinated tokens before the response leaves the
// API. The model sometimes invents pseudo-tags like <blank_line>, <break>,
// <newline> in an attempt to format paragraphs, and historical [removed]
// strings should never escape to the visitor. This is the final safety net
// before the widget renders the reply.
function stripInternalTokens(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Hallucinated formatting pseudo-tags (any case, with or without slash)
    .replace(/<\/?(?:blank_line|blankline|blank|break|br|newline|line_break|linebreak|paragraph_break|paragraph|para_break|space)\s*\/?>/gi, '\n\n')
    // Bare debug substitutions that may slip through legacy code paths
    .replace(/\[(?:removed|redacted|REDACTED|REMOVED|null|undefined|object Object)\]/g, '…')
    // Collapse 3+ blank lines down to 2 (one paragraph break)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Trip brief (structured slot-filling) ─────────────────────────────────────
// Luna maintains a running trip brief and emits it as a hidden marker at the
// very start of a reply, right after [LANG:]:
//   [LANG:English][BRIEF]{"destination":"Crete","adults":2}[/BRIEF]Here you go…
// The server strips it before any visible text reaches the visitor (same
// posture as [LANG:]) and returns the parsed object as `brief` on the response,
// which the widget merges into its trip-brief state. Fail-safe throughout:
// unparseable JSON is ignored and the reply is never affected.
var LEADING_LANG_RE = /^\s*\[LANG:([^\]]+)\]/;
var LEADING_BRIEF_RE = /^\s*\[BRIEF\]([\s\S]*?)\[\/BRIEF\]/;
var ANY_BRIEF_RE = /\[BRIEF\]([\s\S]*?)\[\/BRIEF\]/g;
// Max chars to hold while waiting for the leading markers to close. A normal
// brief marker is well under 500 chars; this only guards a malformed one from
// stalling the whole stream.
var LEAD_BUFFER_CAP = 4000;

// Strip leading [LANG:...] and [BRIEF]{...}[/BRIEF] markers (repeated, in any
// order) from the front of `text`. Returns { cleaned, lang, brief }.
function parseLeadingMeta(text) {
  var s = String(text == null ? '' : text);
  var lang = null, brief = null, m;
  while (true) {
    if ((m = s.match(LEADING_LANG_RE))) { if (!lang) lang = m[1].trim(); s = s.slice(m[0].length); continue; }
    if ((m = s.match(LEADING_BRIEF_RE))) {
      try { var o = JSON.parse(m[1].trim()); if (o && typeof o === 'object' && !Array.isArray(o)) brief = o; } catch (e) { /* ignore bad JSON */ }
      s = s.slice(m[0].length); continue;
    }
    break;
  }
  return { cleaned: s.replace(/^\s+/, ''), lang: lang, brief: brief };
}

// Decide whether the streaming buffer can stop waiting: true once the leading
// markers are COMPLETE (no half-formed [LANG:/[BRIEF] at the front). Keeps the
// buffer held until a [BRIEF] closes, so its JSON never streams to the visitor.
function leadingMetaComplete(text) {
  var s = String(text == null ? '' : text), m;
  while (true) {
    if ((m = s.match(LEADING_LANG_RE))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(LEADING_BRIEF_RE))) { s = s.slice(m[0].length); continue; }
    break;
  }
  s = s.replace(/^\s+/, '');
  if (s === '') return false;                                   // nothing after markers yet
  if (/^\[LANG:/.test(s) && !/\]/.test(s)) return false;        // [LANG: with no closing ]
  if (/^\[BRIEF\]/.test(s) && !/\[\/BRIEF\]/.test(s)) return false; // [BRIEF] not yet closed
  var openers = ['[LANG:', '[BRIEF]'];
  for (var i = 0; i < openers.length; i++) { if (openers[i].indexOf(s) === 0) return false; } // growing prefix of an opener
  return true;
}

// Safety net: remove any [BRIEF]{...}[/BRIEF] anywhere in the text (not just the
// front) and return the last valid one. Used on the final assembled reply so a
// stray marker can never reach the visitor even if the model misplaced it.
function extractBriefMarkers(text) {
  var brief = null;
  var cleaned = String(text == null ? '' : text).replace(ANY_BRIEF_RE, function (_, json) {
    try { var o = JSON.parse(String(json).trim()); if (o && typeof o === 'object' && !Array.isArray(o)) brief = o; } catch (e) { /* ignore */ }
    return '';
  });
  return { cleaned: cleaned, brief: brief };
}

// ── FCDO status card (server-sourced, model never assesses safety) ───────────
// Luna's safety guardrail makes her point to the exact FCDO country page
// (gov.uk/foreign-travel-advice/<country>) and stop. We detect that link in her
// finished reply and attach the OFFICIAL current status card, fetched verbatim
// from FCDO via lib/fcdo. The model is only ever read for WHICH country page it
// linked, never for the status itself, so there is no route for it to invent or
// soften a safety judgement. Safe no-op when there is no FCDO link, the slug is
// the bare index, or the lookup fails.
var FCDO_URL_RE = /gov\.uk\/foreign-travel-advice\/([a-z][a-z0-9-]{1,60})/i;

function prettifySlug(slug) {
  return slug.split('-').map(function (w) {
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

async function buildFcdoCardFromReply(replyText) {
  try {
    if (!replyText || typeof replyText !== 'string') return null;
    var m = replyText.match(FCDO_URL_RE);
    if (!m) return null;
    var slug = m[1].toLowerCase();
    if (slug === 'foreign-travel-advice') return null; // bare index, no country
    var advice = await fcdoLib.getAdvice(prettifySlug(slug), { slug: slug, timeoutMs: 2500 });
    if (!advice || advice.error || advice.notFound) return null;
    return {
      country: advice.country,
      hasWarning: advice.hasWarning,
      statusLines: advice.statusLines,
      lastUpdated: advice.lastUpdated,
      reviewedAt: advice.reviewedAt,
      url: advice.url,
      source: advice.source
    };
  } catch (e) {
    console.warn('[luna-chat] FCDO card build failed:', e.message);
    return null;
  }
}

// Strike tracking (in-memory, resets on cold start)
const moderationStrikes = {};
const WARNING_THRESHOLDS = { warn: 1, block: 3 };

function moderateContent(text, convId) {
  if (!text) return { allowed: true };

  // Check for prompt injection
  for (var i = 0; i < INJECTION_PATTERNS.length; i++) {
    if (INJECTION_PATTERNS[i].test(text)) {
      return { allowed: false, reason: 'injection', message: "I can only help with travel-related questions. Is there something about our services I can assist with?" };
    }
  }

  // Check for blocked content
  var scanResult = filterScan(text);
  if (scanResult.found) {
    return recordStrike(convId, scanResult.term);
  }

  return { allowed: true };
}

function recordStrike(convId, term) {
  if (!convId) convId = 'unknown';
  if (!moderationStrikes[convId]) moderationStrikes[convId] = 0;
  moderationStrikes[convId]++;

  var strikes = moderationStrikes[convId];

  if (strikes >= WARNING_THRESHOLDS.block) {
    console.warn('[Luna Filter] Conversation blocked — convId:', convId, 'term:', term, 'strikes:', strikes);
    return {
      allowed: false,
      reason: 'blocked',
      blocked: true,
      message: "This conversation has been ended due to repeated inappropriate language. If you need help, please call us on +44 (0) 1202 934033."
    };
  }

  console.warn('[Luna Filter] Strike recorded — convId:', convId, 'term:', term, 'strikes:', strikes);
  return {
    allowed: false,
    reason: 'moderated',
    blocked: false,
    message: "I'm here to help with travel questions. What destination or trip can I help you with?"
  };
}

// --- HANDLER ---
module.exports = async function handler(req, res) {
  // ═══ TIMING INSTRUMENTATION ═══
  // Records ms-elapsed at every checkpoint. Logged as a single structured
  // line at the end of the request for easy parsing from Vercel logs.
  // Grep `[luna-chat] TIMING` to see all timing data.
  const _tStart = Date.now();
  const _t = { start: 0 }; // checkpoint name -> ms from start
  function mark(label) {
    _t[label] = Date.now() - _tStart;
  }
  function logTimings(extra) {
    try {
      const payload = Object.assign({ convId: extra && extra.convId, route: extra && extra.route }, _t, extra || {});
      console.log('[luna-chat] TIMING ' + JSON.stringify(payload));
    } catch (e) { /* swallow */ }
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  
  const convId = sanitizeInput(body.convId);
  const visitorName = sanitizeInput(body.visitorName);
  const message = sanitizeInput(body.message);
  const page = sanitizeInput(body.page);
  // Phase 3: page context (title + primary content) for richer awareness.
  // All fields go through sanitizeInput (HTML-strip + 2KB cap).
  const pageContext = (body.pageContext && typeof body.pageContext === 'object') ? {
    title: sanitizeInput(body.pageContext.title || ''),
    path: sanitizeInput(body.pageContext.path || ''),
    url: sanitizeInput(body.pageContext.url || ''),
    primaryContent: sanitizeInput(body.pageContext.primaryContent || '')
  } : null;
  // Phase 3: opener request — widget asks Luna to greet the visitor based on
  // the page they're on. We synthesize a user message so the existing flow
  // handles it the same way as any other turn.
  const openerRequest = body.openerRequest === true;
  const clientName = sanitizeInput(body.clientName);
  const visitorContext = sanitizeInput(body.visitorContext);
  const bookingContext = sanitizeBookingContext(body.bookingContext);
  // Trip brief: the visitor's in-progress trip, accumulated by the widget across
  // this conversation and prior visits. Working memory for Luna (see below).
  const tripBrief = sanitizeTripBrief(body.tripBrief);
  const history = Array.isArray(body.history) ? body.history.map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: sanitizeInput(h.content)
  })) : [];

  // Streaming: client sets body.stream=true (or query ?stream=1) to opt in.
  // We respond with text/event-stream instead of JSON.
  const wantStream = body.stream === true || (req.query && req.query.stream === '1');

  // Instant-ack: client sets body.useAck=true to opt in to receiving an SSE
  // 'ack' event with a templated holding line immediately after rate limiting,
  // before any context fetches or LLM calls. Old widgets that don't send the
  // flag get the legacy behaviour (no ack event). Requires wantStream.
  const wantAck = wantStream && (body.useAck === true || (req.query && req.query.useAck === '1'));

  // Two-pass response: client sets body.useTwoPass=true to opt in to the
  // parallel two-call pattern. The server fires a tiny Haiku call (one-sentence
  // answer, ~800ms TTFT) AND the full long-form call concurrently. Short tokens
  // stream as 'short_text' events, then 'short_done', then long tokens stream
  // as 'long_text' events. Requires wantStream AND wantAck (the ack covers the
  // sub-second before the short answer begins). Old widgets that don't send
  // the flag get the single-call path unchanged. Trivial messages (greetings,
  // thanks, single emoji, very short queries) bypass two-pass even when the
  // flag is on — they don't benefit from a summary/detail split.
  const wantTwoPass = wantAck && (body.useTwoPass === true || (req.query && req.query.useTwoPass === '1'));

  // Phase 3: synthesize a user message when this is an opener request.
  // We DON'T mutate the input `message` (it's const) — instead, set a separate
  // variable used downstream. The guard below is then bypassed by openerRequest.
  let effectiveMessage = message;
  if (openerRequest && !effectiveMessage) {
    effectiveMessage = '[OPENER]'; // marker — handled in the system prompt below
  }
  if (!effectiveMessage) {
    return res.status(400).json({ error: 'Missing or invalid message' });
  }

  // ═══ Phase 3.5: early SSE setup for real-time status events ═══
  // Set up headers and sendEvent EARLY so we can emit status messages while
  // doing knowledge-base / destination lookups (each up to ~1s). Without this,
  // the visitor stares at "Thinking…" until the first AI token arrives.
  var _sseInitialised = false;
  var sendEvent = null;
  function _ensureSseInit() {
    if (_sseInitialised || !wantStream) return _sseInitialised;
    try {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      sendEvent = function(eventName, data) {
        try {
          res.write('event: ' + eventName + '\n');
          res.write('data: ' + JSON.stringify(data) + '\n\n');
        } catch (writeErr) {
          console.warn('[luna-chat] SSE write failed:', writeErr.message);
        }
      };
      sendEvent('meta', { convId: convId });
      _sseInitialised = true;
    } catch (e) {
      console.warn('[luna-chat] early SSE init failed:', e.message);
    }
    return _sseInitialised;
  }
  function emitStatus(text) {
    if (!_ensureSseInit()) return;
    try { sendEvent('status', { text: text }); } catch (e) { /* swallowed */ }
  }
  // emitAck — sends a one-off acknowledgement line to the widget BEFORE any
  // slow context fetches or LLM calls. The widget renders this as a soft
  // placeholder bubble (or in the typing area) so the visitor sees a
  // contextual response in under ~500ms instead of staring at typing dots
  // for several seconds. Body is plain text built from a fixed template
  // set (see buildAck), never raw user input.
  function emitAck(text) {
    if (!_ensureSseInit()) return;
    try { sendEvent('ack', { text: text }); } catch (e) { /* swallowed */ }
  }

  // Rate limiting: per-IP (stops convId rotation) and per-convId (stops session flooding)
  const rlResult = await ratelimit.checkIpAndKey(req, {
    ipKey: 'chat',
    ipMax: 60,            // 60 requests/minute/IP — generous for a busy visitor, instant block for a bot
    ipWindowSecs: 60,
    keyKey: convId ? 'chat:conv:' + convId : null,
    keyMax: 20,           // 20/minute per convId
    keyWindowSecs: 60
  });
  if (!rlResult.allowed) {
    return res.status(429).json({
      reply: "You're sending messages quite quickly. Please wait a moment before trying again.",
      escalate: false,
      rateLimited: true
    });
  }

  mark('rateLimitDone');

  // Global daily cap on Anthropic spend — prevents runaway bills if every other limit is bypassed.
  // SECURITY: this must not fail OPEN. When the limiter is configured but the call
  // fails (returns null), fall back to a per-instance cap rather than skipping the
  // ceiling — otherwise a Redis outage becomes an unbounded bill.
  const dailyCount = await ratelimit.incrDaily(DAILY_CHAT_KEY, 1);
  let dailyBlocked = false;
  if (dailyCount !== null) {
    dailyBlocked = dailyCount > DAILY_CHAT_CAP;
  } else if (ratelimit.isConfigured()) {
    dailyBlocked = localDailyCapExceeded();
    if (dailyBlocked) console.error('[luna-chat] Daily cap: limiter unreachable, per-instance fallback tripped');
  }
  if (dailyBlocked) {
    console.error('[luna-chat] Daily cap exceeded:', dailyCount, 'of', DAILY_CHAT_CAP);
    return res.status(429).json({
      reply: "Our AI assistant is experiencing high demand right now. Please try again shortly or contact us directly.",
      escalate: true,
      rateLimited: true
    });
  }

  // ── Instant ack ──
  // Sent BEFORE any slow context fetches (Airtable, knowledge base, destination
  // index). Typically arrives at the widget within a few hundred ms of the
  // request being received, so the visitor sees a contextual response almost
  // instantly. Gated by body.useAck so old widget builds are unaffected.
  if (wantAck && !openerRequest) {
    emitAck(buildAck(effectiveMessage, pageContext));
    mark('ackSent');
  }

  // Phase 3.5: emit first status event based on intent detection.
  // Skip for opener requests — those have their own flow.
  // Also skip when an ack has already been sent — the ack is richer than
  // detectIntent's generic status, and emitting both back-to-back lets the
  // status overwrite the ack on the widget's fade-in timer (~200ms).
  if (wantStream && !openerRequest && !wantAck) {
    emitStatus(detectIntent(effectiveMessage, pageContext));
  }

  // Phase 3: skip moderation for opener requests (no user content to moderate)
  if (!openerRequest) {
    const modResult = moderateContent(message, convId);
    if (!modResult.allowed) {
      return res.status(200).json({
        reply: modResult.message,
        escalate: false,
        moderated: true,
        blocked: modResult.blocked || false
      });
    }
  }

  const claudeMessages = buildMessages(history, effectiveMessage);

  const isTravelgenix = (clientName || '').toLowerCase().includes('travelgenix');
  let systemPrompt = isTravelgenix ? LUNA_TRAVELGENIX : LUNA_CLIENT;

  // -- Temporal anchor: ON for every client, always ----------------------
  // Give Luna a precise, factual "now" so she never guesses the date or season.
  // High salience near the top of the assembled prompt. See buildTemporalContext.
  systemPrompt += buildTemporalContext();

  // -- Anti-loop rule: never re-ask an answered question (every client) ----
  // Guards against the failure where Luna asks the same thing again after the
  // visitor has already answered — the single most broken-looking behaviour in
  // a live demo. Applies to both prompt variants, high in the assembled prompt.
  systemPrompt += '\n\n## Never re-ask something already answered (CRITICAL)\n'
    + 'Before you ask the visitor ANY question, read back over the conversation so far. If they have already given you that information — directly, in passing, or by tapping a suggestion pill — treat it as known and USE it. Do not ask for it again, not even reworded.\n'
    + '- If you asked something and the visitor replied, that question is DONE. Move forward; never repeat it.\n'
    + '- When you still need details to act (e.g. a search), ask ONLY for the specific fields that are genuinely still missing, in a single message. Never re-list fields the visitor has already supplied.\n'
    + '- If an answer was ambiguous, acknowledge what they did say and ask only for the precise missing piece — never re-ask the whole question from scratch.\n'
    + '- Repeating a question the visitor has already answered makes you look broken and erodes trust. If you are ever unsure whether you already have something, assume you do and proceed, rather than asking again.\n';

  // -- Anti-fabrication + knowledge primacy (every client) -----------------
  // The single most damaging failure is stating a travel fact that turns out to
  // be invented. When a Travel Knowledge or Destination context section is
  // present below, it is verified, curated data and takes priority over general
  // knowledge. When the answer is NOT in that data, Luna must NOT guess — she
  // says she will check. This sits high in the assembled prompt for salience.
  systemPrompt += '\n\n## Facts must be grounded, never invented (CRITICAL)\n'
    + 'Accuracy protects the client\'s reputation. Follow this on every reply:\n'
    + '- When a "Travel Knowledge" or "Destination context" section appears below, treat it as VERIFIED, curated fact and use it as the primary source. It overrides your general knowledge on any specific detail (prices, visas, currency, plug types, transfer times, opening rules, policies).\n'
    + '- Prefer a specific fact from that data over a vague general statement. If the data answers the question, lead with it.\n'
    + '- Never invent or estimate a specific figure, date, price, visa or entry rule, health requirement, or booking detail. If the specific fact is not in the provided data and you are not certain, say so plainly and offer to check or hand off, e.g. "I want to give you the right figure on that, let me confirm it with the team." A short honest answer beats a confident wrong one.\n'
    + '- Do not present guesses as fact, and do not dress a guess up as certainty. Uncertainty stated honestly builds trust; a made-up detail destroys it.\n'
    + '- The exception is the Holiday Search deep link, where you SHOULD use your own knowledge of airport codes and geography to build the URL. That is a search starting point the visitor refines, not a factual claim.\n';

  // Returning-visitor memory: the widget passes a compact, client-side summary
  // of who this visitor is and what they discussed in prior chats (same-browser
  // recall). Lets Luna greet them as a returning customer with continuity.
  if (visitorContext) {
    systemPrompt += '\n\n## Returning visitor\n' + visitorContext;
  }

  // -- Multilingual: ON for every client, always -------------------------
  // Luna detects the visitor's language and replies in it, for all clients,
  // with no per-client flag. The [LANG:...] marker is stripped before the
  // visitor sees the reply (see marker-stripping below). Fails safe to English.
  systemPrompt += '\n\n## Multilingual support\nYou speak multiple languages fluently. Detect the language the visitor is writing in and respond in that same language throughout the conversation. If the visitor switches language mid-conversation, follow their lead. The travel knowledge base is in English, so translate facts and information naturally into the visitor\'s language. Keep your warm, friendly tone in every language. Do not mention that you are translating or that the knowledge base is in English.\n\nCRITICAL: Start EVERY response with [LANG:LanguageName] on its own line (e.g. [LANG:French] or [LANG:English]). This tag will be removed before the visitor sees it. Always include it, even for English.';

  // -- Trip brief: structured slot-filling (every client) ------------------
  // Luna keeps a running, structured brief of the visitor's trip and emits it
  // as a hidden marker the server strips before the visitor sees anything. It
  // gives fully pre-filled deep links, a ready-to-quote handoff, and clean
  // memory — and reduces drift because the facts are held explicitly rather
  // than re-read from the transcript each turn.
  systemPrompt += '\n\n## Trip brief (hidden structured memory)\n'
    + 'As the conversation goes, quietly maintain a structured brief of the visitor\'s trip. Whenever you have LEARNED or CHANGED any of these facts in the latest turn, emit a single [BRIEF] marker IMMEDIATELY AFTER the [LANG:...] tag, before any visible text, on its own line:\n'
    + '[BRIEF]{"destination":"...","departureAirport":"...","departureDate":"YYYY-MM-DD","returnDate":"YYYY-MM-DD","nights":<number>,"dateFlexibility":"...","adults":<number>,"children":<number>,"childAges":"...","board":"...","budget":"...","holidayType":"...","notes":"..."}[/BRIEF]\n'
    + 'Rules for the brief:\n'
    + '- The JSON MUST be valid and on a SINGLE line. This marker is stripped before the visitor sees it, exactly like [LANG:]. Never mention it or describe it.\n'
    + '- It is a MERGE, not a full snapshot: include ONLY the fields you have actual information for this turn. Omit anything you do not know. Never guess or invent a value to fill a field, and never emit a field you are unsure about (this follows the grounding rule above).\n'
    + '- Dates are real ISO dates (YYYY-MM-DD) resolved from the conversation; if only a rough period is known, omit departureDate and put the period in dateFlexibility (e.g. "late September"). nights, adults, children are numbers, not strings.\n'
    + '- Only emit the marker when something changed. If the visitor\'s latest message adds no new trip facts, do NOT emit it.\n'
    + '- The brief is separate from, and does not replace, any [BLOCK] cards, the enquiry_card, or the search deep link. It is silent memory that makes those richer.';

  // -- Trip in progress: read the brief back as working memory --------------
  // The widget sends the brief it has accumulated (this conversation, and any
  // carried over from a prior visit on this device). Giving it back to Luna
  // stops her re-asking facts the visitor already gave, and lets her warmly
  // pick up an abandoned trip when someone returns. She still never invents.
  if (tripBrief) {
    systemPrompt += '\n\n## Trip in progress (what you already know)\n'
      + 'The visitor already has this trip taking shape. It is shown to them on screen as a "Your trip" summary, so it is real and shared — treat it as established fact you both can see:\n'
      + formatTripBriefForPrompt(tripBrief) + '\n'
      + 'How to use it:\n'
      + '- Do NOT ask again for anything already listed here. Re-asking for what they have told you is the single biggest thing that makes a visitor feel unheard. Move the conversation forward instead.\n'
      + '- If a fact here conflicts with what they now say, the NEW message wins — update quietly (emit an updated [BRIEF]) and never argue about the old value.\n'
      + '- If this is the START of a conversation (an opener or their first message) and there is already a substantial trip above, greet them warmly and briefly recap it, then offer to carry on or change it, e.g. "Welcome back. Last time we were looking at 7 nights in Crete for 2 in September. Want to pick that up, or start something new?". Keep it to one short sentence, do not dump every field.\n'
      + '- Only surface fields that are actually listed. Never fill a gap with a guess.';
  }

  if (isTravelgenix) {
    try {
      var __kbBlock = await loadTravelgenixKnowledge(process.env.AIRTABLE_KEY);
      if (__kbBlock) {
        systemPrompt += __kbBlock;
        console.log('[luna-chat] KB injected (Travelgenix), len=' + __kbBlock.length);
      }
    } catch (e) { console.warn('[luna-chat] KB inject failed:', e.message); }
    try {
      var __supBlock = await loadTravelgenixSuppliers(process.env.AIRTABLE_KEY);
      if (__supBlock) {
        systemPrompt += __supBlock;
        console.log('[luna-chat] suppliers injected (Travelgenix), len=' + __supBlock.length);
      }
    } catch (e) { console.warn('[luna-chat] suppliers inject failed:', e.message); }

    // Multilingual is applied globally for every client (see the unconditional
    // block at the top of prompt assembly) -- no per-client flag needed here.
  }

  if (!isTravelgenix && clientName) {
    systemPrompt += `\n\n## Client context\nYou are embedded on the website of "${clientName}". Refer to them naturally as "we" or "us".`;

    var profileAtKey = process.env.AIRTABLE_KEY;
    if (profileAtKey) {
      try {
        const profileUrl = 'https://api.airtable.com/v0/app6Ot3eOb3DangkB/tbl6CZ7aVzq1wHF2v'
          + '?filterByFormula=' + encodeURIComponent(clientNameFormula(clientName))
          + '&maxRecords=1';
        const pRes = await fetch(profileUrl, {
          headers: { 'Authorization': 'Bearer ' + profileAtKey },
          // Per-turn hot path: cap the wait so slow Airtable degrades gracefully
          // instead of holding the serverless slot open to maxDuration (30s).
          signal: AbortSignal.timeout(2500)
        });
        const pData = await pRes.json();
        if (pData.records && pData.records.length > 0) {
          const f = pData.records[0].fields || {};
          if (f.BusinessDescription) {
            systemPrompt += '\n\n## About this business\nUse this information to answer visitor questions. It was written by the business owner:\n\n' + f.BusinessDescription;
          }

          // ── Knowledge fetch — per-client approved Q/A items ──
          // Injected BEFORE website knowledge so it lands earlier in the prompt
          // and clearly takes precedence on overlapping topics.
          var __clientRecordId = pData.records[0].id;
          var __usedKnowledgeIds = []; // Populated when we strip markers from the reply
          try {
            var __items = await knowledge.fetchKnowledgeItems(profileAtKey, __clientRecordId, message, 5);
            console.log('[luna-chat] knowledge fetch: client=' + __clientRecordId + ' message="' + message.slice(0, 80) + '" matched=' + (__items ? __items.length : 0));
            if (__items && __items.length) {
              systemPrompt += knowledge.formatKnowledgeForPrompt(__items);
              // Stash full candidate objects so post-processing can do similarity matching when markers are absent
              req.__lunaKnowledgeContext = { clientRecordId: __clientRecordId, candidates: __items };
            } else {
              req.__lunaKnowledgeContext = { clientRecordId: __clientRecordId, candidates: [] };
            }
          } catch (kErr) {
            console.warn('[luna-chat] knowledge fetch failed:', kErr.message);
            req.__lunaKnowledgeContext = { clientRecordId: __clientRecordId, candidates: [] };
          }

          // Website knowledge from scanned pages — secondary to Approved Answers above.
          if (f.scannedKnowledge) {
            // Trim to ~12000 chars to stay within token budget
            var knowledge_text = f.scannedKnowledge;
            if (knowledge_text.length > 12000) knowledge_text = knowledge_text.slice(0, 12000) + '\n\n[Content truncated — more detail available on the website]';
            systemPrompt += '\n\n## Website knowledge (secondary)\nThe following was extracted from the business\'s own website. Use it to answer visitor questions when no Approved Answer covers the topic. If an Approved Answer above contradicts this content, the Approved Answer wins. Never say "according to the website" — just state the facts naturally as if you know them.\n\n' + knowledge_text;
          }
          const contactParts = [];
          if (f.BusinessPhone) contactParts.push('Phone: ' + f.BusinessPhone);
          if (f.BusinessWebsite) contactParts.push('Website: ' + f.BusinessWebsite);
          if (f.BusinessAddress) contactParts.push('Address: ' + f.BusinessAddress);
          if (f.OpeningHours) contactParts.push('Opening hours: ' + f.OpeningHours);
          if (contactParts.length > 0) {
            systemPrompt += '\n\n## Contact details\n' + contactParts.join('\n');
          }

          // v2: Emergency phone — used by emergency_card block
          if (f.EmergencyPhone) {
            systemPrompt += '\n\n## Emergency phone\nThe configured emergency phone for this client is: ' + f.EmergencyPhone + '\nUse this exact value as the "phone" and "phoneDisplay" property when rendering emergency_card blocks.';
          }

          // Multilingual is applied globally for every client (see the
          // unconditional block at the top of prompt assembly).

          // WHAT THIS ASSISTANT IS CALLED.
          //
          // WidgetBotName only ever reached the widget's own UI label, never the
          // prompt — so the hardcoded "You are Luna" won every reply. Jamie Wake
          // Travel named theirs Ava, the bubble said Ava, and she still opened
          // with "I'm Luna, the chat assistant here at Jamie Wake Travel". The
          // visitor is looking at both at once, so it reads as broken.
          //
          // Only override when the client actually chose something. A blank
          // field, or the "Luna"/"Luna AI" default, leaves the base prompt alone.
          var botName = String(f.WidgetBotName || '').trim();
          if (botName && !/^luna( ai)?$/i.test(botName)) {
            systemPrompt += `\n\n## Your name — overrides the name used anywhere above

On this website you are called **${botName}**, not Luna. That is the name this
agency chose and it is on the chat window the visitor is looking at right now.

- Introduce yourself as ${botName}.
- Refer to yourself as ${botName} whenever you use your own name.
- If asked your name, it is ${botName}.
- Never call yourself Luna here, and never mention Luna as a product or explain
  that you are "powered by" anything. As far as the visitor is concerned you are
  ${botName}, this agency's own assistant.`;
          }

          // Booking search integration
          const siteId = f.DeepLinkSiteID;
          // Search is only usable with BOTH a site id and at least one enabled
          // search type. Tracked explicitly because either one missing has to
          // produce the same "you cannot search, do not invent a link" rule —
          // That's My Dream Holiday has a site id but no search types, and Luna
          // invented URLs on their domain just as she did for a client with no
          // site id at all.
          var searchConfigured = false;
          if (siteId) {
            var rawTypes = f.SearchTypes;
            var allowedTypes = [];
            if (Array.isArray(rawTypes) && rawTypes.length > 0) {
              allowedTypes = rawTypes.map(function(t) { return typeof t === 'object' ? t.name : t; });
            }

            if (allowedTypes.length > 0) {
            searchConfigured = true;
            var typeNames = { Packages: 'package holidays', Flights: 'flights', Accommodation: 'hotels/accommodation', DynamicPackaging: 'flight + hotel combos' };
            var typeList = allowedTypes.map(function(t) { return t + ' (' + (typeNames[t] || t) + ')'; }).join(', ');
            var defaultType = allowedTypes.length === 1 ? allowedTypes[0] : (allowedTypes.includes('DynamicPackaging') ? 'DynamicPackaging' : (allowedTypes[0] || 'DynamicPackaging'));
            var accommOnly = allowedTypes.length === 1 && allowedTypes[0] === 'Accommodation';

            systemPrompt += `\n\n## Holiday Search

You can help visitors search for holidays by building a deep link URL. This is one of your most powerful features. You can search ANY destination worldwide.

### Search Types Available
The client has enabled these search types: ${typeList}

Use "${defaultType}" as the default unless the visitor specifically asks for something else (e.g. "just flights" = Flights, "just a hotel" = Accommodation, "package holiday" = Packages). When someone asks for "a holiday" or "holidays to X", always use DynamicPackaging (flight + hotel).

### Deep Link URL Templates

**Packages (package holidays, flight + hotel + transfers):**
https://dl.tvllnk.com/deeplink/${siteId}?st=Packages&org={ORIGIN_IATA}&dst={DEST_IATA}&loc={LOCATION_NAME}&lat={LATITUDE}&lng={LONGITUDE}&rad=4&fr={DATE}&dur={NIGHTS}&adt={ADULTS}&chd={CHILDREN}&inf={INFANTS}

**DynamicPackaging (flight + hotel combos):**
https://dl.tvllnk.com/deeplink/${siteId}?st=DynamicPackaging&org={ORIGIN_IATA}&dst={DEST_IATA}&loc={LOCATION_NAME}&lat={LATITUDE}&lng={LONGITUDE}&rad=4&fr={DATE}&dur={NIGHTS}&adt={ADULTS}&chd={CHILDREN}&inf={INFANTS}

**Flights (flights only):**
https://dl.tvllnk.com/deeplink/${siteId}?st=Flights&org={ORIGIN_IATA}&dst={DEST_IATA}&fr={DATE}&dur={NIGHTS}&adt={ADULTS}&chd={CHILDREN}&inf={INFANTS}

**Accommodation (hotels only, no flights):**
https://dl.tvllnk.com/deeplink/${siteId}?st=Accommodation&loc={LOCATION_NAME}&lat={LATITUDE}&lng={LONGITUDE}&rad=4&fr={DATE}&dur={NIGHTS}&adt={ADULTS}&chd={CHILDREN}&inf={INFANTS}

### Parameter Rules

**ORIGIN_IATA** — always a UK airport code. Common options:
LON (all London), LHR (Heathrow), LGW (Gatwick), STN (Stansted), LTN (Luton), LCY (London City), MAN (Manchester), BHX (Birmingham), EDI (Edinburgh), GLA (Glasgow), LBA (Leeds Bradford), NCL (Newcastle), LPL (Liverpool), BRS (Bristol), EMA (East Midlands), BFS (Belfast International), BHD (Belfast City), SOU (Southampton), CWL (Cardiff), ABZ (Aberdeen), EXT (Exeter), BOH (Bournemouth), NWI (Norwich), INV (Inverness).
If the visitor says "London" use LON. If they name a specific London airport, use that code.

**DEST_IATA** — the IATA airport code nearest to the destination. Use your knowledge of world airports. For cities with multiple airports, use the main international one (e.g. JFK for New York, CDG for Paris, FCO for Rome). For resort destinations, use the nearest serving airport (e.g. PMI for Mallorca, HER for Crete, DPS for Bali, PUJ for Punta Cana).

**LOCATION_NAME** — the destination name as the visitor described it, URL-encoded with + for spaces. For resorts and specific areas, use the specific name (e.g. "Playa+del+Carmen" not just "Mexico"). For cities, use the city name (e.g. "New+York", "Paris", "Tokyo").

**LATITUDE / LONGITUDE** — approximate coordinates of the destination. Use your geographical knowledge. These do not need to be pinpoint accurate, the search uses a radius parameter, so being within a fraction of a degree is fine.

**DATE** — format YYYY-MM-DD. Today's date is ${new Date().toISOString().split('T')[0]}. ALL dates MUST be in the future. If the visitor asks for a date that has already passed (e.g. "June 2026" but it's now July 2026), use the same month next year. If the visitor says a month without a specific date, use the 15th of that month. If they say "next summer" suggest dates. NEVER generate a URL with a date in the past — always check against today's date before outputting the link.

**NIGHTS** — number of nights. Common options: 3, 4, 5, 7, 10, 14, 21, 28. If the visitor says "a week" use 7. "Two weeks" use 14. "Long weekend" use 3 or 4.

**ADULTS** — number of adults (default 2 if not specified).
**CHILDREN** — number of children aged 2-17 (default 0).
**INFANTS** — number of infants under 2 (default 0).
If children are included, append &chdage={age} for each child (e.g. &chdage=8&chdage=5 for two children aged 8 and 5). Always ask for children's ages if children > 0.

**rad** — search radius in km. Use 3 when searching near a specific point of interest (a theme park, landmark, stadium or named attraction, e.g. "hotels near Universal Orlando") so results stay genuinely close to it. Use 4 for a city or resort. Use 8-12 ONLY for a deliberately large region (e.g. "somewhere in the Algarve", "the Amalfi Coast"). A named attraction is NOT a large region — keep the radius tight, or the results spread across the whole city.

### Optional filters — INCLUDE these when the visitor has already stated them

These are real deep link parameters. Never delay a search to ask for them — but if the visitor has ALREADY told you a star rating or board basis, you MUST append them to the URL so the results arrive pre-filtered. Only include what the visitor actually volunteered; omit anything they have not stated (do not append an empty parameter).

**&rat={N}** — minimum star rating. Append when the visitor has stated stars: "5 star" / "five star" → &rat=5, "4 star or above" → &rat=4, "at least 3 star" → &rat=3. Half ratings are allowed (&rat=3.5). Omit entirely if the visitor has not mentioned a star rating. Only valid for Accommodation, DynamicPackaging and Packages searches — NEVER add it to a Flights URL.

**&brd={VALUE}** — board basis. Append when the visitor has stated one. Map their words to exactly one of these values: all inclusive / all-inclusive → AllInclusive; half board → HalfBoard; full board → FullBoard; bed and breakfast / B&B / breakfast included → BedAndBreakfast; self catering / self-catering → SelfCatering; room only → RoomOnly. Omit if not stated. Only valid for Accommodation, DynamicPackaging and Packages.

**&cabin={VALUE}** — flight cabin class. Append when the visitor has stated one: economy → Economy, premium economy → PremiumEconomy, business → Business, first → First. Only valid for Flights and DynamicPackaging.

Append these AFTER the other parameters. Example for a stated "London, 5 star, all inclusive, 12 June, 7 nights, 2 adults" hotel search: ...&adt=2&chd=0&inf=0&rat=5&brd=AllInclusive

### Holiday inspiration requests

When the visitor has NOT named a destination but is asking for ideas, follow the "Handling holiday requests" section at the top of this prompt. Do NOT use the Search Readiness / Required Fields / What to do flow described above — that's for QUOTE requests only (destination already named).

### Conversational Flow

This flow is for Bucket Q (READY mode) ONLY — when the visitor has named a destination AND has explicitly signalled they want to look at prices/availability/book. If the visitor has only named a destination but is asking for information about it (Bucket R / RESEARCH), do NOT enter this flow. Answer their research question and stay in research mode.

1. Confirm the visitor is in Bucket Q. If the message is "tell me about Crete" or "things to do in Crete" or "I need more information" they are NOT in Bucket Q. Drop back to research and answer the question they asked. If the message is "show me prices for Crete" / "what's available in Crete in September" / "I want to book Crete" — they ARE in Bucket Q, proceed.
2. Run the readiness check. List in your head what you have and what's missing from the required fields for the search type.
3. If everything required is present, generate the search link IMMEDIATELY. Do not ask anything else. Do NOT paste the raw URL and do NOT format it as a text link, and never put an emoji anywhere in the reply. Instead, emit ONE destination_card block for the destination with the deepLink field set to the URL you built. The widget renders this as a branded, tappable button (with its own icon) that opens the live search. Put one short prose sentence before the card, e.g. "Here you go — tap below for live availability and prices." Format:
   [BLOCK]{"type":"destination_card","props":{"name":"{DESTINATION}","vibe":"<one short line about the destination>","tags":["<2-3 short tags>"],"deepLink":"URL"}}[/BLOCK]
   For accommodation-only (hotels) searches you may omit flightTime. A brief friendly follow-up after the card such as "Let me know if you'd like help narrowing it down once you've had a look" is fine.
4. If something required is missing, ask for ALL missing required fields in a SINGLE message. Do not ask one, wait, ask another, wait. Group them naturally:
   - Good: "Sounds lovely. To search, I just need to know which airport you'd fly from, your rough dates and how many of you are travelling."
   - Bad: "Sounds lovely. Which airport would you fly from?" (then next turn) "Great. When are you thinking?" (then next turn) "And how many of you?"
5. As soon as the visitor provides the missing fields, generate the search link. Do not introduce new questions you didn't ask in step 4.
6. Default departure airport suggestion when completely absent: suggest "London" as default, and mention other UK airports are available if they'd prefer.

### Important Rules
- ALWAYS use your own knowledge for IATA codes and coordinates. You know world geography, use it confidently.
- If you genuinely do not know an IATA code for an obscure destination, tell the visitor honestly and suggest the nearest major airport you do know.
- For Flights, do NOT include loc, lat, lng, or rad parameters, just org, dst, dates and travellers.
- For Accommodation, do NOT include org or dst parameters, just loc, lat, lng, rad, dates and travellers.
- URL-encode the location name: spaces become +, commas become %2C, apostrophes become %27.
- Do NOT generate a search link until you have all the required details.

### The ONLY permitted link format

Every search link you produce must start with https://dl.tvllnk.com/deeplink/${siteId}.
NEVER write a search or booking URL on this agency's own website domain, and never
invent a path such as /search?destination=... on their site. Those pages do not
exist, so the visitor lands on a 404 at the exact moment they were ready to book.
If a link is not in the dl.tvllnk.com format above, do not send it.`;
            } // end if allowedTypes.length > 0
          }

          // NO SEARCH CONFIGURED for this client.
          //
          // Everything above lives inside `if (siteId)` AND `if (allowedTypes)`.
          // With either missing, Luna received no link instructions at all — and
          // rather than say she could not search, she invented plausible URLs on
          // the client's own domain (jamiewaketravel.co.uk/search?destination=...).
          // Every one was a 404, hit right when the visitor was ready to book.
          // Silence is not a constraint; the gap has to be closed explicitly.
          if (!searchConfigured) {
            systemPrompt += `\n\n## Holiday Search — NOT AVAILABLE

This agency has no live search connected, so you CANNOT run or link to a holiday
search. Never construct, guess, or invent a search, booking or availability URL
of any kind, including on this agency's own website. Any link you make up is a
404 and it fails the visitor at the worst possible moment.

Do not say "let me search that for you" or promise results you cannot deliver.

Instead, help with everything you genuinely can — destinations, advice, what the
agency offers, financial protection, how booking works — and when the visitor is
ready to look at actual prices or availability, hand over: take their trip
details and offer to have the team come back to them, or point them to the
agency's own phone number or contact page if you have it. Only link to pages you
have actually been given.`;
          }
        }
      } catch (e) {
        console.warn('Profile fetch failed:', e.message);
      }
    }

    // Booking lookup integration — if this client has linked a My Booking widget
    // on tg-widgets, give Luna the marker syntax to trigger embedded booking lookup.
    try {
      var linkedBooking = await findLinkedBookingWidget(clientName);
      if (linkedBooking && linkedBooking.widgetId) {
        systemPrompt += `

## Booking Lookup
You can help visitors retrieve their existing booking confirmation through an inline form.

When a visitor expresses they want to find, view, check, or look up an EXISTING booking they already have, respond with a brief friendly acknowledgement (one short sentence) followed by this marker on its own line:

[BOOKING_LOOKUP:${linkedBooking.widgetId}]

After the marker, on the very next lines, emit exactly 3 follow-up question pills using [FQ] markers (see "Follow-up questions" below). Do not write anything else after the pills — the form, the booking details and the pills speak for themselves.

The widget below your message will show the visitor a secure form where they enter their email, departure date and booking reference. Once they look up their booking, they will see the full booking details and can download or email a PDF copy of their confirmation.

### When to trigger booking lookup
- "Where's my booking" / "Find my reservation" / "I have a booking"
- "Look up my booking" / "Manage my booking" / "View my booking"
- "I want to see my confirmation" / "Pull up my trip"
- "Booking reference [code]" / "Order ref [code]"
- "Check my booking" / "Find my trip"
- Anyone mentioning they already have a booking and want details

### When NOT to trigger
- "I want to book a holiday" — they don't have a booking yet, this is a search
- "How do I book?" — process question
- Payment questions
- General enquiries about destinations
- Questions about a booking that aren't about retrieving it (e.g. "can I add a meal to my booking?" — escalate to a human)

### Follow-up questions

After the booking marker, emit exactly 3 [FQ] lines, each on its own line. These appear as tappable pills beneath the chat input AFTER the visitor has looked up their booking. They give the visitor useful next steps once they can see their trip details.

You will not yet know the specific destination or dates of the booking when you emit these (the booking renders below your reply). So the pills should be GENERAL but PRACTICAL — questions that work well for any upcoming trip, that you can answer well from the travel knowledge base.

Pick 3 from this list. Vary your selection so visitors with different bookings see slightly different pills — do not always pick the same 3. Use British English exactly as written.

**Pre-trip practical (use at least one of these):**
- [FQ] What documents do I need for my trip?
- [FQ] Do I need any vaccinations or health prep?
- [FQ] When should I arrive at the airport?
- [FQ] What's the baggage allowance?

**Destination context (use at least one of these):**
- [FQ] What will the weather be like?
- [FQ] What's the local currency?
- [FQ] Is there a tipping culture I should know about?
- [FQ] What plug type do they use?
- [FQ] What time zone is it?
- [FQ] What's the language and any useful phrases?

**Trip enrichment (use at most one of these):**
- [FQ] Anything fun to do near my hotel?
- [FQ] What's the food like?
- [FQ] What's a typical day's spending money?
- [FQ] How do I get from the airport to my hotel?

### Important pill rules
- ALWAYS exactly 3 [FQ] lines — never 2, never 4.
- ALWAYS one from the "Pre-trip practical" group.
- ALWAYS one from the "Destination context" group.
- The third pill is your choice from any group.
- One [FQ] per line, [FQ] at the start of the line.
- No follow-up text after the [FQ] lines. Stop after the last pill.

### Examples

Visitor: "I have a booking with you, can you find it?"
You:
Of course, pop your details in and I'll pull it up for you.
[BOOKING_LOOKUP:${linkedBooking.widgetId}]
[FQ] What documents do I need for my trip?
[FQ] What will the weather be like?
[FQ] When should I arrive at the airport?

Visitor: "where's my reservation"
You:
Sure thing, let me grab the lookup form for you.
[BOOKING_LOOKUP:${linkedBooking.widgetId}]
[FQ] What's the baggage allowance?
[FQ] What's the local currency?
[FQ] Anything fun to do near my hotel?

Visitor: "I want to look up booking REF12345"
You:
No problem, drop your email and departure date in below and I'll find it.
[BOOKING_LOOKUP:${linkedBooking.widgetId}]
[FQ] Do I need any vaccinations or health prep?
[FQ] What plug type do they use?
[FQ] How do I get from the airport to my hotel?

### Important
- Use the marker exactly as shown, including the widget ID.
- Only ONE [BOOKING_LOOKUP] marker per response.
- Always exactly 3 [FQ] pills after the marker.
- Don't add explanations after the pills — stop there.
- If the visitor's lookup fails (the form will tell them), they may need to double-check their details. Offer to escalate to a human if they keep having trouble.
- If the visitor taps a pill, answer it normally using your travel knowledge. The visitor's booking is now visible in the chat above, so refer to it naturally if helpful (e.g. "for your Maldives trip..." once you can see the destination from earlier in the conversation).`;
      }
    } catch (e) {
      console.warn('[luna-chat] Booking lookup integration check failed:', e.message);
    }
  }
  mark('clientProfileDone');
  // Booking context — sent by the chat widget AFTER the visitor has retrieved
  // an existing booking via the embedded My Booking widget. Lets Luna answer
  // follow-up questions ("what documents do I need?", "what's the weather
  // like?") with reference to the actual trip on screen, instead of asking
  // the visitor for facts already visible. Privacy-redacted at the source
  // (see widget-mybooking.js getSafeContextSummary) and re-validated server-
  // side via sanitizeBookingContext above — the model never sees names,
  // emails, prices, references or special requests.
  if (bookingContext) {
    var ctxLines = ['', '', '## Booking Context'];
    ctxLines.push("The visitor has just retrieved an existing booking. Its details are visible to them on screen above the chat input. Use the facts below to answer follow-up questions directly — do NOT ask the visitor for any of these details, you can already see them.");
    ctxLines.push('');
    if (bookingContext.destinationCity || bookingContext.destinationCountry) {
      var dest = [bookingContext.destinationCity, bookingContext.destinationCountry].filter(Boolean).join(', ');
      ctxLines.push('- Destination: ' + dest);
    }
    if (bookingContext.hotelName) ctxLines.push('- Hotel: ' + bookingContext.hotelName);
    if (bookingContext.startDate) {
      var dateLine = '- Departing: ' + bookingContext.startDate;
      if (bookingContext.endDate) dateLine += ', returning ' + bookingContext.endDate;
      if (bookingContext.nights) dateLine += ' (' + bookingContext.nights + ' nights)';
      ctxLines.push(dateLine);
    }
    if (typeof bookingContext.daysUntilDeparture === 'number') {
      ctxLines.push('- Days until departure: ' + bookingContext.daysUntilDeparture);
    }
    if (bookingContext.boardBasis) ctxLines.push('- Board basis: ' + bookingContext.boardBasis);
    if (bookingContext.outboundFlight) {
      var ob = bookingContext.outboundFlight;
      var obLine = '- Outbound flight: ' + ob.from + ' to ' + ob.to;
      if (ob.airline) obLine += ' on ' + ob.airline;
      if (typeof ob.stops === 'number') obLine += ', ' + (ob.stops === 0 ? 'direct' : ob.stops + ' stop' + (ob.stops === 1 ? '' : 's'));
      if (ob.stopAirports && ob.stopAirports.length) obLine += ' via ' + ob.stopAirports.join(', ');
      if (ob.cabin) obLine += ', ' + ob.cabin + ' class';
      ctxLines.push(obLine);
    }
    if (bookingContext.inboundFlight) {
      var ib = bookingContext.inboundFlight;
      var ibLine = '- Return flight: ' + ib.from + ' to ' + ib.to;
      if (ib.airline) ibLine += ' on ' + ib.airline;
      if (typeof ib.stops === 'number') ibLine += ', ' + (ib.stops === 0 ? 'direct' : ib.stops + ' stop' + (ib.stops === 1 ? '' : 's'));
      if (ib.stopAirports && ib.stopAirports.length) ibLine += ' via ' + ib.stopAirports.join(', ');
      ctxLines.push(ibLine);
    }
    var partyParts = [];
    if (bookingContext.adults) partyParts.push(bookingContext.adults + ' adult' + (bookingContext.adults === 1 ? '' : 's'));
    if (bookingContext.children) partyParts.push(bookingContext.children + ' child' + (bookingContext.children === 1 ? '' : 'ren'));
    if (bookingContext.infants) partyParts.push(bookingContext.infants + ' infant' + (bookingContext.infants === 1 ? '' : 's'));
    if (partyParts.length) ctxLines.push('- Travelling: ' + partyParts.join(', '));
    ctxLines.push('');
    ctxLines.push('### How to use this context');
    ctxLines.push("- When answering follow-up questions about the trip, use these facts directly. e.g. for \"what documents do I need?\" use the destination country to give specific advice (passport validity rules, visa rules, etc.) without re-asking.");
    ctxLines.push('- Refer to the destination, dates, hotel or airline naturally when it helps the answer feel personal. Do not list the whole booking back at the visitor — they can already see it.');
    ctxLines.push("- For child/infant-related advice (travel documents for under-18s, baggage allowance for infants), use the party shape above. If the visitor specifically mentions a name, age or relationship not shown here, treat that as new information.");
    ctxLines.push("- The booking is for an EXISTING trip. Do NOT generate new search links or suggest alternative destinations unless the visitor explicitly asks to look at something else.");
    ctxLines.push("- If a follow-up question requires details NOT in this context (e.g. specific seat numbers, room type, special requests, payment status), say you can see the booking pack has that detail and they can scroll up to check it, or escalate to a human if it's a question only an agent can answer.");
    ctxLines.push('');
    ctxLines.push('### Post-booking help (be a concierge, not a salesperson)');
    ctxLines.push('This visitor has ALREADY booked. Your job now is to help them get ready and feel looked after, never to sell them another trip. After answering their question, offer the ONE or TWO most relevant next steps as a quick_replies block, chosen from what the booking tells you:');
    ctxLines.push('- If a balance is outstanding, gently offer to help pay it ("Pay my balance").');
    ctxLines.push('- If departure is close (roughly 14 days or fewer), lean into getting ready: online check-in, baggage, transfers, what to pack, documents ("Check in", "Add baggage", "Pre-departure checklist").');
    ctxLines.push('- If departure is further off, useful steps are documents, adding extras (bags, seats, transfers), or a question about the resort ("My documents", "Add extras").');
    ctxLines.push('- Always keep "Speak to the team" within reach for anything you cannot resolve.');
    ctxLines.push('Offer at most 3 chips, phrase them as short first-person actions, and never invent a next step the booking does not support (e.g. do not promise seat selection if you do not know it is available). If you are unsure, a plain helpful answer with no chips is better than a wrong offer.');
    systemPrompt += ctxLines.join('\n');
  }

  // Phase 3: richer page context if provided by the widget
  if (pageContext && pageContext.title) {
    systemPrompt += '\n\n=== PAGE CONTEXT (AMBIENT — DO NOT HIJACK) ===\n';
    systemPrompt += 'The visitor is currently on this page:\n';
    systemPrompt += '  Title: ' + pageContext.title + '\n';
    if (pageContext.path) systemPrompt += '  Path:  ' + pageContext.path + '\n';
    if (pageContext.primaryContent) {
      systemPrompt += '\nMain content visible to the visitor (first ~200 words):\n';
      systemPrompt += pageContext.primaryContent.slice(0, 1200) + '\n';
    }
    systemPrompt += '\nThis is AMBIENT awareness only. It tells you where the visitor happens to be standing — it is NOT what they asked about. The rules:\n';
    systemPrompt += '- The ACTIVE CONVERSATION always wins. If you are already helping with something (a booking, a question, a topic from earlier turns), KEEP HELPING WITH THAT. Do not change the subject to match the page.\n';
    systemPrompt += '- Visitors browse while they chat. The page may change mid-conversation (e.g. they open a "Africa" page while you are discussing their existing booking). When that happens, IGNORE the new page and stay on the conversation. Do NOT comment on the new page, do NOT pivot, do NOT ask if they want to travel there or book it.\n';
    systemPrompt += '- Only lean on the page when the visitor\'s CURRENT message is clearly about it — deictic references like "this", "here", "this page", "what I\'m looking at", or an obviously page-related question with no other subject. Then use the page to resolve what they mean (e.g. on a Crete page, "what\'s the weather like" means Crete).\n';
    systemPrompt += '- Never proactively pitch, redirect to, or start a fresh sales pitch about the page topic just because the visitor landed there. No "I see you\'re looking at X — fancy a trip?".\n';
    systemPrompt += '- Never list or narrate what you can "see" on the page. That feels surveillant. Just be quietly informed.\n';
  } else if (page) {
    systemPrompt += '\nThe visitor is currently viewing: ' + page + ' (ambient only — do not let it override the active conversation or pivot the topic).';
  }
  if (openerRequest) {
    systemPrompt += '\n\n=== CONTEXTUAL OPENER REQUEST ===\n';
    systemPrompt += 'This is the visitor\'s FIRST interaction. They have just opened the chat window in expanded mode. They are in DISCOVER / RESEARCH mode — they are NOT ready to book. Do NOT push toward booking, quotes, calls, or sales actions.\n\n';
    systemPrompt += 'Output a JSON object (no markdown, no code fence, no commentary — JUST the raw JSON) with this exact shape:\n';
    systemPrompt += '{\n';
    systemPrompt += '  "reply": "<your 1-2 sentence greeting>",\n';
    systemPrompt += '  "pills": ["<pill 1>", "<pill 2>", "<pill 3>", "<pill 4>"]\n';
    systemPrompt += '}\n\n';
    systemPrompt += 'GREETING rules:\n';
    systemPrompt += '- 1-2 sentences max, warm and informed\n';
    systemPrompt += '- References the page they\'re on (subtly, naturally)\n';
    systemPrompt += '- Opens a research-mode question (NOT a sales push)\n';
    systemPrompt += '- Does NOT say "Hi there" or generic openers\n';
    systemPrompt += '- Conversational tone, never markdown, never bullet-pointed\n';
    systemPrompt += 'Greeting example for a Greek Islands page: "Greek islands feel familiar but every one is wildly different — Mykonos parties, Santorini stuns, Naxos relaxes. What kind of trip are you picturing?"\n\n';
    systemPrompt += 'PILLS rules — EXACTLY 4 pills, each one strictly DISCOVER MODE:\n';
    systemPrompt += '- 2-5 words each, ALWAYS short\n';
    systemPrompt += '- Question-shaped or noun-shaped (e.g. "Best time to visit", "Hidden gems", "What\'s it like?")\n';
    systemPrompt += '- Different angles — do NOT repeat the same idea 4 ways\n';
    systemPrompt += '- Specific to the PAGE TOPIC, not generic travel\n';
    systemPrompt += '- NEVER booking-mode: NO "Book now", "Get a quote", "Speak to an expert", "Call us", "Check availability", "See prices"\n';
    systemPrompt += '- Good categories: highlights, hidden spots, climate/timing, comparisons, what to expect, who it suits, things to know\n';
    systemPrompt += 'Pills example for an Africa page: ["Safari highlights", "Best time to visit", "Family-friendly options", "Lesser-known countries"]\n';
    systemPrompt += 'Pills example for a Greek Islands page: ["Island personalities", "Best time to visit", "Hidden islands", "What to expect"]\n';
    systemPrompt += 'Pills example for a cruise page: ["What\'s included", "Cabin types explained", "Best lines for first-timers", "Shore excursions"]\n\n';
    systemPrompt += 'OUTPUT FORMAT: respond with ONLY the JSON object. No surrounding text. No code fences. No "Here\'s..." preamble.';
  }
  if (visitorName) systemPrompt += `\nThe visitor's name is ${visitorName}.`;

  // Grounding signal. True when the reply had verified Luna Brain knowledge or
  // destination context in front of the model — i.e. Luna was answering from the
  // curated brain, not free-styling from training data. Surfaced on the response
  // (kbGrounded) so the staging smoke test and dashboards can SEE the brain being
  // used, which is the fastest way to catch a silent retrieval regression.
  var kbGrounded = false;
  var useHaiku = false;
  if (!isTravelgenix) {
    var atKey = process.env.AIRTABLE_KEY;
    mark('brainSearchStart');
    var kbContext = await searchLunaBrain(message, atKey);
    mark('brainSearchDone');
    if (kbContext) {
      systemPrompt += kbContext;
      kbGrounded = true;
      // Phase 3.5: status update — we found something in the knowledge base
      // Suppressed when ack is in use: the ack already conveys progress and
      // we don't want it overwritten on the typing-status line.
      if (wantStream && !openerRequest && !wantAck) emitStatus('Found something in our knowledge…');
    }
    // Destination context (Airports + Theme Parks) — keyword-triggered
    mark('destCtxStart');
    var destCtx = await getDestinationContext(message, atKey);
    mark('destCtxDone');
    if (destCtx) {
      systemPrompt += destCtx;
      kbGrounded = true;
      // Phase 3.5: status update — destination data fetched
      if (wantStream && !openerRequest && !wantAck) emitStatus('Looking up destination details…');
    }
    useHaiku = true;
  } else {
    // Travelgenix client (B2B) — still expose destination context for
    // demos, since Andy may show the widget answering airport/park questions.
    var atKeyTg = process.env.AIRTABLE_KEY;
    if (atKeyTg) {
      mark('destCtxStart');
      var destCtxTg = await getDestinationContext(message, atKeyTg);
      mark('destCtxDone');
      if (destCtxTg) { systemPrompt += destCtxTg; kbGrounded = true; }
    }
  }

  // Phase 3.5: final status before AI call — "Writing your answer…"
  // Also gated on !wantAck so the ack persists right up until the first
  // real text delta arrives and replaces it via ensureBubble().
  if (wantStream && !openerRequest && !wantAck) emitStatus('Writing your answer…');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    var modelId = useHaiku
      ? (process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001')
      : (process.env.LUNA_MODEL || 'claude-sonnet-4-6');

    // ═══════════════════════════════════════════════════════════
    // STREAMING PATH — SSE response, real-time token delivery
    // ═══════════════════════════════════════════════════════════
    if (wantStream) {
      // Phase 3.5: SSE may already be initialised by emitStatus() above.
      // Only set headers / sendEvent if early init didn't happen (e.g. no
      // status events fired). The _sseInitialised flag guards against
      // double-setting headers (which would throw "Cannot set headers after they are sent").
      if (!_sseInitialised) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        sendEvent = function(eventName, data) {
          try {
            res.write('event: ' + eventName + '\n');
            res.write('data: ' + JSON.stringify(data) + '\n\n');
          } catch (writeErr) {
            console.warn('[luna-chat] SSE write failed:', writeErr.message);
          }
        };
        sendEvent('meta', { convId: convId });
        _sseInitialised = true;
      }
      // sendEvent is guaranteed defined at this point (either via emitStatus init or via the block above).

      // ═══════════════════════════════════════════════════════════════════
      // TWO-PASS PARALLEL PATH (Ship 2)
      // ═══════════════════════════════════════════════════════════════════
      // Fires TWO Anthropic calls concurrently:
      //   • SHORT — Haiku, tiny derived prompt, max_tokens 80, one sentence.
      //     Streamed as 'short_text' SSE deltas. Replaces the ack on the
      //     widget. Visitor sees a useful answer in ~800ms.
      //   • LONG  — same model+prompt as single-call path, with an augment
      //     telling it the short summary has been shown. Streamed as
      //     'long_text' SSE deltas. Continues from the short.
      //
      // Why this works: the long call's first tokens usually arrive while
      // the short answer is still streaming. By the time the short finishes
      // (~2s elapsed), the long is already buffered and flows straight on.
      //
      // Skipped for trivial messages (greetings/thanks/yes-no) — those don't
      // benefit from a summary/detail split and would feel mechanical.
      // Gated on wantTwoPass which itself requires wantAck — the ack covers
      // the sub-second before short tokens begin streaming.
      if (wantTwoPass && !isTrivialMessage(effectiveMessage)) {
        // Two-pass makes a SECOND Anthropic call. Bump the daily counter
        // by 1 more so the spend cap reflects actual API usage.
        await ratelimit.incrDaily(DAILY_CHAT_KEY, 1).catch(function(e){
          console.warn('[luna-chat] daily-counter bump for two-pass failed:', e.message);
        });

        var shortModelId = process.env.LUNA_SHORT_MODEL || 'claude-haiku-4-5-20251001';
        // Use the FULL system prompt for both calls. An earlier version
        // sliced to 8KB for the short call hoping to save TTFT, but that
        // stripped the knowledge base, destination context, and booking-
        // widget instructions — causing the short call to fall back to
        // "speak to the team" on questions it should have answered. TTFT
        // difference between 8KB and 70KB is small (~200ms) and will
        // disappear once Anthropic prompt caching is wired up.
        var shortSystemPrompt = systemPrompt + buildShortPromptAugment();
        var longSystemPrompt = systemPrompt + buildLongPromptAugment();

        var shortText = '';
        var longText = '';
        var shortFinal = null;
        var longFinal = null;
        var shortFirstToken = false;
        var longFirstToken = false;

        mark('llmCallStart');

        // Fire BOTH streams in parallel. We don't await — we just kick them
        // off and hold the promises. Anthropic SDK's .stream() returns a
        // promise that resolves to a stream iterator.
        var shortStreamPromise = client.messages.stream({
          model: shortModelId,
          max_tokens: 100,
          system: shortSystemPrompt,
          messages: claudeMessages,
          metadata: { user_id: convId || 'unknown' }
        });
        var longStreamPromise = client.messages.stream({
          model: modelId,
          max_tokens: 2048,
          system: longSystemPrompt,
          messages: claudeMessages,
          metadata: { user_id: convId || 'unknown' }
        });

        // ── Phase A: stream SHORT tokens to the widget ──
        try {
          var shortStream = await shortStreamPromise;
          for await (var sev of shortStream) {
            if (sev.type === 'content_block_delta' && sev.delta && sev.delta.type === 'text_delta') {
              var sd = sev.delta.text || '';
              if (!sd) continue;
              if (!shortFirstToken) { mark('shortFirstToken'); shortFirstToken = true; }
              shortText += sd;
              sendEvent('short_text', { delta: sd });
            }
          }
          shortFinal = await shortStream.finalMessage();
          mark('shortStreamEnd');
          sendEvent('short_done', {});
        } catch (shortErr) {
          console.warn('[luna-chat] short stream failed (non-fatal, long will continue):', shortErr.message || shortErr);
          // Signal widget that short is "done" with empty content. The long
          // stream below will still run; user gets long-only output. This
          // is the graceful degradation path.
          sendEvent('short_done', { error: true });
          mark('shortStreamEnd');
        }

        // ── Phase B: stream LONG tokens to the widget ──
        // Tokens may already be buffered (call 2 was fired in parallel).
        try {
          var longStream = await longStreamPromise;
          for await (var lev of longStream) {
            if (lev.type === 'content_block_delta' && lev.delta && lev.delta.type === 'text_delta') {
              var ld = lev.delta.text || '';
              if (!ld) continue;
              if (!longFirstToken) { mark('longFirstToken'); longFirstToken = true; }
              longText += ld;
              sendEvent('long_text', { delta: ld });
            }
          }
          longFinal = await longStream.finalMessage();
          mark('longStreamEnd');
        } catch (longErr) {
          console.error('[luna-chat] long stream failed:', longErr.message || longErr);
          // If short also failed, send full error. If short succeeded, treat
          // the short as the complete answer and proceed to post-processing.
          if (!shortText) {
            mark('end');
            logTimings({ convId: convId, route: 'twopass-both-failed', error: longErr.message || String(longErr) });
            sendEvent('error', {
              message: 'stream_failed',
              fallbackReply: "I'm having a little trouble right now. Let me connect you with one of the team who can help directly."
            });
            return res.end();
          }
        }

        // ── Post-process combined output (same pipeline as single-call) ──
        // The combined reply is short + " " + long. Post-processing runs on
        // the WHOLE thing because [BLOCK]/[FQ]/escalation markers all live in
        // the long output, and the cleanup must produce a single coherent
        // reply object for downstream consumers (conversation log, etc).
        var combinedRaw = shortText + ((shortText && longText) ? ' ' : '') + longText;
        var combinedClean = combinedRaw;

        // Knowledge marker handling (same as single-call path)
        try {
          var __km2 = knowledge.extractKnowledgeMarkers(combinedClean);
          var __kCtx2 = req.__lunaKnowledgeContext || {};
          var __cands2 = __kCtx2.candidates || [];
          if (__km2.ids.length > 0) combinedClean = __km2.cleaned;
          var __usedIds2 = knowledge.inferUsedKnowledge(combinedClean, __cands2, __km2.ids);
          console.log('[luna-chat] knowledge: offered=' + __cands2.length + ' markers=' + __km2.ids.length + ' inferred=' + __usedIds2.length + ' (two-pass)');
          if (__usedIds2.length) {
            var __kKey2 = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
            if (__kKey2) {
              await knowledge.trackKnowledgeUsage(__kKey2, __usedIds2).catch(function(e){
                console.warn('[luna-chat] track usage failed:', e.message);
              });
              req.__lunaUsedKnowledgeIds = __usedIds2;
            }
          }
        } catch (kmErr2) {
          console.warn('[luna-chat] knowledge marker handling failed (two-pass):', kmErr2.message);
        }

        // Destination image enrichment
        try {
          var enrichKey2 = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
          if (enrichKey2) {
            combinedClean = await enrichDestinationCardImages(combinedClean, enrichKey2);
          }
        } catch (enrichErr2) {
          console.warn('[luna-chat] enrichment skipped (two-pass):', enrichErr2.message);
        }

        // Output filter — defence in depth on the combined text
        var outputCheck2 = filterOutput(combinedClean);
        if (outputCheck2.flagged) {
          console.error('[Luna Filter] AI output was filtered (two-pass)! convId:', convId);
          combinedClean = outputCheck2.filtered;
        }
        combinedClean = stripInternalTokens(combinedClean);

        // Trip brief: strip any [BRIEF] marker (the long call emits it) and capture it.
        var briefSweep2 = extractBriefMarkers(combinedClean);
        combinedClean = briefSweep2.cleaned;
        var replyBrief2 = briefSweep2.brief;

        var escalate2 = detectEscalation(combinedClean, message);

        var donePayload2 = {
          reply: combinedClean,
          shortPart: shortText,
          longPart: longText,
          escalate: escalate2,
          convId: convId,
          kbGrounded: kbGrounded,
          brief: replyBrief2 || undefined,
          mode: 'two-pass',
          usage: {
            short_input_tokens: shortFinal && shortFinal.usage ? shortFinal.usage.input_tokens : null,
            short_output_tokens: shortFinal && shortFinal.usage ? shortFinal.usage.output_tokens : null,
            long_input_tokens: longFinal && longFinal.usage ? longFinal.usage.input_tokens : null,
            long_output_tokens: longFinal && longFinal.usage ? longFinal.usage.output_tokens : null
          }
        };

        try { var __fcdo2 = await buildFcdoCardFromReply(donePayload2.reply); if (__fcdo2) donePayload2.fcdoCard = __fcdo2; } catch (e) { /* never block the reply */ }

        sendEvent('done', donePayload2);
        mark('end');
        logTimings({
          convId: convId,
          route: 'twopass',
          shortModel: shortModelId,
          longModel: modelId,
          systemPromptChars: systemPrompt.length,
          shortInputTokens: donePayload2.usage.short_input_tokens,
          shortOutputTokens: donePayload2.usage.short_output_tokens,
          longInputTokens: donePayload2.usage.long_input_tokens,
          longOutputTokens: donePayload2.usage.long_output_tokens,
          isTravelgenix: isTravelgenix,
          hasBookingContext: !!bookingContext,
          hasKbContext: !!(typeof kbContext !== 'undefined' && kbContext),
          hasDestCtx: !!((typeof destCtx !== 'undefined' && destCtx) || (typeof destCtxTg !== 'undefined' && destCtxTg))
        });
        return res.end();
      }
      // ═══════════════════════════════════════════════════════════════════
      // (Fall through to single-call streaming below if two-pass not active
      // or message was trivial.)
      // ═══════════════════════════════════════════════════════════════════

      var accumulated = '';
      var firstTextChunkSeen = false;
      var detectedLang = null;
      var replyBrief = null;

      try {
        mark('llmCallStart');
        var stream = await client.messages.stream({
          model: modelId,
          max_tokens: 2048,
          system: systemPrompt,
          messages: claudeMessages,
          metadata: { user_id: convId || 'unknown' }
        });

        // The SDK exposes a text-event stream we can iterate.
        // We buffer the start of the response until we can confirm or deny
        // a [LANG:...] marker, then forward cleanly. The client never sees
        // the LANG marker — it gets a clean text stream + detectedLanguage
        // in the final 'done' event.
        var langBuffer = '';
        var langPhase = 'buffering'; // 'buffering' | 'streaming'
        for await (var event of stream) {
          if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
            var deltaText = event.delta.text || '';
            if (!deltaText) continue;
            accumulated += deltaText;

            if (langPhase === 'buffering') {
              langBuffer += deltaText;
              // Hold until the leading [LANG:]/[BRIEF] markers are COMPLETE, so
              // neither the language tag nor the brief JSON ever streams to the
              // visitor. Capped so a malformed/never-closing marker can't hold
              // the whole reply hostage.
              if (!leadingMetaComplete(langBuffer) && langBuffer.length < LEAD_BUFFER_CAP) {
                continue;
              }
              var meta = parseLeadingMeta(langBuffer);
              if (meta.lang) detectedLang = meta.lang;
              if (meta.brief) replyBrief = meta.brief;
              // Flush buffered (cleaned) text and switch to streaming mode
              if (meta.cleaned.length > 0) {
                if (!firstTextChunkSeen) mark('firstToken');
                sendEvent('text', { delta: meta.cleaned });
                firstTextChunkSeen = true;
              }
              langBuffer = '';
              langPhase = 'streaming';
              continue;
            }

            // streaming phase — forward delta as-is
            if (!firstTextChunkSeen) mark('firstToken');
            sendEvent('text', { delta: deltaText });
            firstTextChunkSeen = true;
          }
          // We don't need to handle message_delta, message_stop etc — the
          // for-await loop completes when the stream ends.
        }
        // If the stream ended while still buffering (very short response),
        // flush whatever we have left.
        if (langPhase === 'buffering' && langBuffer.length > 0) {
          var metaEnd = parseLeadingMeta(langBuffer);
          if (metaEnd.lang) detectedLang = metaEnd.lang;
          if (metaEnd.brief) replyBrief = metaEnd.brief;
          if (metaEnd.cleaned.length > 0) {
            sendEvent('text', { delta: metaEnd.cleaned });
            firstTextChunkSeen = true;
          }
        }

        // Final message from the SDK — includes usage
        var finalMessage = await stream.finalMessage();
        mark('streamEnd');

        // Post-process the accumulated text. Strip leading [LANG:]/[BRIEF] meta
        // and any stray [BRIEF] elsewhere; capture the brief for the payload.
        var leadMeta = parseLeadingMeta(accumulated);
        if (leadMeta.lang && !detectedLang) detectedLang = leadMeta.lang;
        if (leadMeta.brief && !replyBrief) replyBrief = leadMeta.brief;
        var briefSweep = extractBriefMarkers(leadMeta.cleaned);
        if (briefSweep.brief && !replyBrief) replyBrief = briefSweep.brief;
        var cleanReply = briefSweep.cleaned;

        // Strip [KNOWLEDGE:recXXX] markers and track which items were used.
        // Detection strategy: prefer markers if emitted, fall back to substance similarity.
        // NOTE: must await — Vercel kills fire-and-forget work when the function returns.
        try {
          var __km = knowledge.extractKnowledgeMarkers(cleanReply);
          var __kCtx = req.__lunaKnowledgeContext || {};
          var __cands = __kCtx.candidates || [];
          if (__km.ids.length > 0) cleanReply = __km.cleaned;
          var __usedIds = knowledge.inferUsedKnowledge(cleanReply, __cands, __km.ids);
          console.log('[luna-chat] knowledge: offered=' + __cands.length + ' markers=' + __km.ids.length + ' inferred=' + __usedIds.length);
          if (__usedIds.length) {
            var __kKey = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
            if (__kKey) {
              // Await — Vercel terminates unawaited promises on function return
              await knowledge.trackKnowledgeUsage(__kKey, __usedIds).catch(function(e){
                console.warn('[luna-chat] track usage failed:', e.message);
              });
              req.__lunaUsedKnowledgeIds = __usedIds; // surfaced for conversation logging
            }
          }
        } catch (kmErr) {
          console.warn('[luna-chat] knowledge marker handling failed:', kmErr.message);
        }

        try {
          var enrichKey = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
          if (enrichKey) {
            cleanReply = await enrichDestinationCardImages(cleanReply, enrichKey);
          }
        } catch (enrichErr) {
          console.warn('[luna-chat] enrichment skipped:', enrichErr.message);
        }

        // Layer 2: Output filter
        var outputCheck = filterOutput(cleanReply);
        if (outputCheck.flagged) {
          console.error('[Luna Filter] AI output was filtered! convId:', convId);
          cleanReply = outputCheck.filtered;
        }

        // Layer 3: Strip any internal/protocol/hallucinated tokens. Final
        // safety net so visitors never see <blank_line>, <break>, [removed].
        cleanReply = stripInternalTokens(cleanReply);

        var escalate = detectEscalation(cleanReply, message);

        var donePayload = {
          reply: cleanReply,
          escalate: escalate,
          convId: convId,
          kbGrounded: kbGrounded,
          usage: {
            input_tokens: finalMessage && finalMessage.usage ? finalMessage.usage.input_tokens : null,
            output_tokens: finalMessage && finalMessage.usage ? finalMessage.usage.output_tokens : null
          }
        };
        if (detectedLang) donePayload.detectedLanguage = detectedLang;
        if (replyBrief) donePayload.brief = replyBrief;
        try { var __fcdo1 = await buildFcdoCardFromReply(donePayload.reply); if (__fcdo1) donePayload.fcdoCard = __fcdo1; } catch (e) { /* never block the reply */ }

        sendEvent('done', donePayload);
        mark('end');
        logTimings({
          convId: convId,
          route: 'stream',
          model: modelId,
          systemPromptChars: systemPrompt.length,
          inputTokens: finalMessage && finalMessage.usage ? finalMessage.usage.input_tokens : null,
          outputTokens: finalMessage && finalMessage.usage ? finalMessage.usage.output_tokens : null,
          isTravelgenix: isTravelgenix,
          hasBookingContext: !!bookingContext,
          hasKbContext: !!(typeof kbContext !== 'undefined' && kbContext),
          hasDestCtx: !!((typeof destCtx !== 'undefined' && destCtx) || (typeof destCtxTg !== 'undefined' && destCtxTg))
        });
        return res.end();

      } catch (streamErr) {
        console.error('[luna-chat] streaming error:', streamErr.message || streamErr);
        mark('end');
        logTimings({ convId: convId, route: 'stream-error', error: streamErr.message || String(streamErr) });
        sendEvent('error', {
          message: 'stream_failed',
          fallbackReply: "I'm having a little trouble right now. Let me connect you with one of the team who can help directly."
        });
        return res.end();
      }
    }

    // ═══════════════════════════════════════════════════════════
    // NON-STREAMING PATH — original JSON response (unchanged)
    // ═══════════════════════════════════════════════════════════
    mark('llmCallStart');
    const response = await client.messages.create({
      model: modelId,
      max_tokens: 2048,
      system: systemPrompt,
      messages: claudeMessages,
      metadata: { user_id: convId || 'unknown' }
    });
    mark('llmCallDone');

    const replyText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    var detectedLang = null;
    var replyBrief = null;
    var leadMeta0 = parseLeadingMeta(replyText);
    detectedLang = leadMeta0.lang;
    replyBrief = leadMeta0.brief;
    var briefSweep0 = extractBriefMarkers(leadMeta0.cleaned);
    if (briefSweep0.brief && !replyBrief) replyBrief = briefSweep0.brief;
    var cleanReply = briefSweep0.cleaned.trim();

    // Strip [KNOWLEDGE:recXXX] markers and infer which items were used.
    // NOTE: must await — Vercel kills fire-and-forget work when the function returns.
    try {
      var __km2 = knowledge.extractKnowledgeMarkers(cleanReply);
      var __kCtx2 = req.__lunaKnowledgeContext || {};
      var __cands2 = __kCtx2.candidates || [];
      if (__km2.ids.length > 0) cleanReply = __km2.cleaned;
      var __usedIds2 = knowledge.inferUsedKnowledge(cleanReply, __cands2, __km2.ids);
      console.log('[luna-chat] knowledge: offered=' + __cands2.length + ' markers=' + __km2.ids.length + ' inferred=' + __usedIds2.length);
      if (__usedIds2.length) {
        var __kKey2 = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
        if (__kKey2) {
          await knowledge.trackKnowledgeUsage(__kKey2, __usedIds2).catch(function(e){
            console.warn('[luna-chat] track usage failed:', e.message);
          });
          req.__lunaUsedKnowledgeIds = __usedIds2;
        }
      }
    } catch (kmErr2) {
      console.warn('[luna-chat] knowledge marker handling failed:', kmErr2.message);
    }

    // Inject curated images into destination_card blocks (server-side enrichment)
    try {
      var enrichKey = isTravelgenix ? process.env.AIRTABLE_KEY : atKey;
      if (enrichKey) {
        cleanReply = await enrichDestinationCardImages(cleanReply, enrichKey);
      }
    } catch (enrichErr) {
      console.warn('[luna-chat] enrichment skipped:', enrichErr.message);
    }

    // Layer 2: Output filter — catch anything that slipped through the system prompt
    var outputCheck = filterOutput(cleanReply);
    if (outputCheck.flagged) {
      console.error('[Luna Filter] AI output was filtered! convId:', convId);
      cleanReply = outputCheck.filtered;
    }

    // Layer 3: Strip any internal/protocol/hallucinated tokens. Final safety
    // net so visitors never see <blank_line>, <break>, [removed], etc.
    cleanReply = stripInternalTokens(cleanReply);

    var escalate = detectEscalation(cleanReply, message);

    // Phase 3: opener requests return JSON. Parse out reply + pills.
    var openerPills = null;
    if (openerRequest) {
      try {
        // Strip code fences if Luna added them despite instructions
        var jsonText = cleanReply.trim();
        if (jsonText.indexOf('```') !== -1) {
          jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        }
        // Find first { and last } to be defensive against any preamble Luna might add
        var firstBrace = jsonText.indexOf('{');
        var lastBrace = jsonText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          jsonText = jsonText.slice(firstBrace, lastBrace + 1);
        }
        var parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
          cleanReply = parsed.reply.trim();
        }
        if (parsed && Array.isArray(parsed.pills)) {
          // Sanitise pills: strings only, 2-50 chars each, max 4 pills
          openerPills = parsed.pills
            .filter(function(p) { return typeof p === 'string'; })
            .map(function(p) { return p.trim().slice(0, 50); })
            .filter(function(p) { return p.length >= 2; })
            .slice(0, 4);
          if (openerPills.length === 0) openerPills = null;
        }
      } catch (parseErr) {
        console.warn('[luna-chat] opener JSON parse failed:', parseErr.message, '— returning raw reply');
        // Fall through — cleanReply stays as-is, no pills
      }
    }

    var responseJson = {
      reply: cleanReply,
      escalate: escalate,
      convId: convId,
      kbGrounded: kbGrounded,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens
      }
    };
    if (detectedLang) responseJson.detectedLanguage = detectedLang;
    if (replyBrief) responseJson.brief = replyBrief;
    if (openerPills && openerPills.length > 0) responseJson.pills = openerPills;
    try { var __fcdo0 = await buildFcdoCardFromReply(responseJson.reply); if (__fcdo0) responseJson.fcdoCard = __fcdo0; } catch (e) { /* never block the reply */ }

    mark('end');
    logTimings({
      convId: convId,
      route: 'json',
      model: modelId,
      systemPromptChars: systemPrompt.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      isTravelgenix: isTravelgenix,
      hasBookingContext: !!bookingContext,
      hasKbContext: !!(typeof kbContext !== 'undefined' && kbContext),
      hasDestCtx: !!((typeof destCtx !== 'undefined' && destCtx) || (typeof destCtxTg !== 'undefined' && destCtxTg))
    });
    return res.status(200).json(responseJson);

  } catch (err) {
    console.error('Luna AI error:', err?.message || err);
    mark('end');
    logTimings({ convId: convId, route: 'handler-error', error: err?.message || String(err) });
    if (wantStream) {
      // Try to send an SSE error event if we haven't ended yet
      try {
        res.write('event: error\ndata: ' + JSON.stringify({
          message: 'server_error',
          fallbackReply: "I'm having a little trouble right now. Let me connect you with one of the team who can help directly."
        }) + '\n\n');
        return res.end();
      } catch (sseErr) {
        // Fall through to JSON error
      }
    }
    return res.status(200).json({
      reply: "I'm having a little trouble right now. Let me connect you with one of the team who can help directly.",
      escalate: true,
      error: true
    });
  }
};

// --- BUILD MESSAGES ---
function buildMessages(history, currentMessage) {
  const messages = [];

  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(-20);
    for (const msg of recent) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
        if (msg.role === lastRole) {
          messages[messages.length - 1].content += '\n' + msg.content;
        } else {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
  }

  const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
  if (lastRole === 'user') {
    // De-dupe: several deployed widgets push the current turn into `history`
    // AND send it again as `message`, so the trailing history turn already
    // ends with (or equals) currentMessage. Appending again would make the
    // model see the visitor's message twice — it reads as the visitor
    // insisting/repeating and skews the reply. Only append when it is genuinely
    // new content.
    const trailing = (messages[messages.length - 1].content || '').trim();
    const incoming = (currentMessage || '').trim();
    if (incoming && trailing !== incoming && !trailing.endsWith(incoming)) {
      messages[messages.length - 1].content += '\n' + currentMessage;
    }
  } else {
    messages.push({ role: 'user', content: currentMessage });
  }

  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '[Conversation started]' });
  }

  return messages;
}

// --- ESCALATION DETECTION ---
function detectEscalation(aiReply, visitorMessage) {
  const visitorLower = (visitorMessage || '').toLowerCase();
  const replyLower = (aiReply || '').toLowerCase();

  const humanPatterns = [
    'speak to someone', 'speak to a human', 'speak to a person',
    'talk to someone', 'talk to a human', 'talk to a person',
    'real person', 'real human', 'actual person',
    'speak to an agent', 'talk to an agent', 'speak to andy',
    'can i speak', 'can i talk', 'get me a human',
    'human please', 'agent please', 'transfer me',
    'someone from your team', 'member of your team',
    'call me', 'ring me', 'phone me', 'book a demo'
  ];

  for (const pattern of humanPatterns) {
    if (visitorLower.includes(pattern)) return true;
  }

  // Precise signal: the AI renders a human_handoff_card block ONLY when it is
  // genuinely escalating (explicit request, or a question it can't answer). That
  // block survives in the reply text (the widget renders it), so detect it directly.
  if (replyLower.includes('human_handoff_card')) return true;

  // Committed handoff language only. Deliberately NOT matching polite offers
  // ("I can connect you with one of the team") or bare noun phrases
  // ("one of the team" / "member of our team" / "book a demo") — those appear in
  // ordinary friendly greetings and were causing escalation on a plain "hi".
  // A real handoff uses the committed forms below and/or the card above.
  const escalationPhrases = [
    'connecting you with',
    'passing you over',
    'someone will be with you',
    'agent will be',
    'let me get someone'
  ];

  for (const phrase of escalationPhrases) {
    if (replyLower.includes(phrase)) return true;
  }

  if (/\b[A-Z]{2,3}[-\s]?\d{4,8}\b/.test(visitorMessage)) return true;

  return false;
}

// Exposed for unit testing only. Vercel invokes the default handler export
// above; attaching helpers as properties does not change that contract.
module.exports.buildTemporalContext = buildTemporalContext;
module.exports.parseLeadingMeta = parseLeadingMeta;
module.exports.leadingMetaComplete = leadingMetaComplete;
module.exports.extractBriefMarkers = extractBriefMarkers;
module.exports.sanitizeTripBrief = sanitizeTripBrief;
module.exports.formatTripBriefForPrompt = formatTripBriefForPrompt;
