// Deep-link geo resolver: make Luna's searches match the site's searches.
//
// The site search sends Travelify a curated centre point, a per-destination
// radius and Travelify's own airport grouping for every destination it knows.
// Luna used to let the model guess all three, with a radius capped at 12 and
// labelled as km when the deeplink actually takes miles. The Algarve got a
// 4 "km" circle around Faro; the site uses 47 miles around Mid-Algarve.
//
// This module holds the site's table (lib/geo/travelify-geo.json, built from
// the Travelify export by scripts/build-geo-table.js) and rewrites every
// dl.tvllnk.com link the model emits so that lat, lng, rad and dst come from
// the table whenever the destination is one the table knows. The model keeps
// naming the place; the numbers come from the same data the site uses.
//
// Matching is on the `loc` parameter (the destination name as the visitor
// said it): exact, then by first comma segment and parenthetical aliases,
// then longest-prefix ("St Anton am Arlberg" → "St Anton"), then a small edit
// distance for typos on either side ("Magaluf" → "Magalluf"). Where several
// rows share a name (Manhattan, Dead Sea) the model's own dst and coordinates
// pick the right one, and a match whose centre is nowhere near the model's
// coordinates is rejected rather than trusted (Paris, Texas is not Paris).
//
// Everything is pure and idempotent: rewriting a rewritten link changes nothing.

'use strict';

var TABLE = require('./geo/travelify-geo.json');

var LINK_PREFIX = 'https://dl.tvllnk.com/deeplink/';
// What ends a URL in prose, markdown or a JSON string.
var URL_END = /[\s"'<>)\]}\\]/;
var LINK_RE = /https:\/\/dl\.tvllnk\.com\/deeplink\/[^\s"'<>)\]}\\]+/g;

// ── normalisation ──

function normalise(s) {
  if (!s) return '';
  var t = String(s);
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old runtime */ }
  t = t.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(saint|sankt|st\.)\s+/g, 'st ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^the\s+/, '').replace(/\s+the$/, '');
  return t;
}

// "Bourgas (Burgas)" → ["bourgas", "burgas"]; "A/B (C)" → ["a", "b", "c"];
// "Bahamas (All Bahamas)" → ["bahamas", "all bahamas"]; "Arlberg (The)" → ["arlberg"].
function segmentAliases(segment) {
  var out = [];
  var parens = [];
  var base = segment.replace(/\(([^)]*)\)/g, function (_, inner) { parens.push(inner); return ' '; });
  base.split('/').forEach(function (p) { var n = normalise(p); if (n) out.push(n); });
  parens.forEach(function (p) {
    p.split('/').forEach(function (q) { var n = normalise(q); if (n) out.push(n); });
  });
  return out;
}

// ── index ──

var index = null; // { exact: Map<key, row[]>, firstKeys: [{ key, rows }] }

function buildIndex() {
  var exact = new Map();
  var firstMap = new Map();
  function add(map, key, row) {
    if (!key) return;
    var list = map.get(key);
    if (!list) { list = []; map.set(key, list); }
    if (list.indexOf(row) === -1) list.push(row);
  }
  TABLE.rows.forEach(function (row) {
    var segs = row.name.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    add(exact, normalise(row.name), row);
    add(exact, normalise(segs.map(function (s) { return s.replace(/\([^)]*\)/g, ''); }).join(' ')), row);
    var firsts = segmentAliases(segs[0] || '');
    firsts.forEach(function (k) { add(exact, k, row); add(firstMap, k, row); });
    if (segs.length > 1) {
      // "Magalluf, Majorca" / "Chania, Crete" as the visitor might say it.
      firsts.forEach(function (k) {
        segmentAliases(segs[1]).forEach(function (k2) { add(exact, k + ' ' + k2, row); });
      });
    }
  });
  index = {
    exact: exact,
    firstKeys: Array.from(firstMap.entries()).map(function (e) { return { key: e[0], rows: e[1] }; })
  };
  return index;
}

function getIndex() { return index || buildIndex(); }

// ── matching ──

function levenshtein(a, b) {
  if (a === b) return 0;
  var m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    var t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function allowedDistance(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

// Returns { rows, how } or null.
function candidatesFor(locKey) {
  if (!locKey) return null;
  var ix = getIndex();
  var hit = ix.exact.get(locKey);
  if (hit) return { rows: hit, how: 'exact' };

  // The visitor may have said "Algarve, Portugal" or "Crete (Greece)".
  var firstSeg = normalise(String(locKey).split(/[,(]/)[0]);
  if (firstSeg && firstSeg !== locKey) {
    hit = ix.exact.get(firstSeg);
    if (hit) return { rows: hit, how: 'first-segment' };
  }

  // "St Anton am Arlberg" → "st anton"; "Crete island" → "crete".
  var best = null;
  ix.firstKeys.forEach(function (e) {
    if (e.key.length >= 4 && locKey.length > e.key.length && locKey.indexOf(e.key + ' ') === 0) {
      if (!best || e.key.length > best.key.length) best = e;
    }
  });
  if (best) {
    // A qualifier after a small place is just how people say it (St Anton am
    // Arlberg). After a LARGE place it is usually a sub-area (Dubai Marina,
    // Bali Seminyak) and the model's tight circle round that spot serves the
    // visitor better than the whole region's, so only generic qualifiers
    // ("Crete island", "Algarve coast", "Tenerife Spain") take the big row.
    var remainder = locKey.slice(best.key.length + 1).trim();
    var big = best.rows.some(function (r) { return r.radiusMi > 15; });
    if (!big || isGenericQualifier(remainder)) return { rows: best.rows, how: 'prefix' };
  }

  // "New York" → "New York City".
  if (locKey.length >= 5) {
    var longer = [];
    ix.firstKeys.forEach(function (e) {
      if (e.key.indexOf(locKey + ' ') === 0) longer = longer.concat(e.rows);
    });
    if (longer.length) return { rows: longer, how: 'extends' };
  }

  // Typos on either side.
  var maxD = allowedDistance(locKey.length);
  if (maxD > 0) {
    var bestD = maxD + 1, rows = [];
    ix.firstKeys.forEach(function (e) {
      if (Math.abs(e.key.length - locKey.length) > maxD) return;
      var d = levenshtein(locKey, e.key);
      if (d < bestD) { bestD = d; rows = e.rows.slice(); }
      else if (d === bestD) rows = rows.concat(e.rows);
    });
    if (bestD <= maxD) return { rows: rows, how: 'fuzzy' };
  }
  return null;
}

var GENERIC_QUALIFIERS = /^(island|islands|isle|coast|coastline|region|area|city|centre|center|town|old town|resort|resorts|beach|beaches|mainland|north|south|east|west|peninsula|riviera)$/;
var countryKeys = null;
function isGenericQualifier(rem) {
  if (!rem) return true;
  if (GENERIC_QUALIFIERS.test(rem)) return true;
  if (!countryKeys) {
    countryKeys = new Set();
    TABLE.rows.forEach(function (r) {
      var segs = r.name.split(',');
      if (segs.length > 1) countryKeys.add(normalise(segs[segs.length - 1]));
    });
  }
  return countryKeys.has(rem);
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  var R = 3958.8, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// Pick one row from several. The model's dst is explicit intent; its
// coordinates are approximate but never on the wrong continent.
function disambiguate(rows, hint) {
  if (rows.length === 1) return rows[0];
  if (hint.dst) {
    var byDst = rows.filter(function (r) { return r.iata === hint.dst; });
    if (byDst.length === 1) return byDst[0];
    if (byDst.length > 1) rows = byDst;
  }
  if (hint.lat !== null && hint.lng !== null) {
    var best = null, bestD = Infinity;
    rows.forEach(function (r) {
      var d = haversineMiles(hint.lat, hint.lng, r.lat, r.lng);
      if (d < bestD) { bestD = d; best = r; }
    });
    return best;
  }
  return null; // genuinely ambiguous and nothing to go on: leave the link alone
}

// Resolve a destination. `hint` may carry dst, lat, lng from the model's link.
// Returns { row, how } or { row: null, reason }.
function resolve(loc, hint) {
  hint = hint || {};
  var h = {
    dst: hint.dst ? String(hint.dst).trim().toUpperCase() : '',
    lat: num(hint.lat),
    lng: num(hint.lng)
  };
  var key = normalise(loc);
  if (!key) return { row: null, reason: 'no-loc' };
  var found = candidatesFor(key);
  if (!found) return { row: null, reason: 'miss' };
  var row = disambiguate(found.rows, h);
  if (!row) return { row: null, reason: 'ambiguous' };
  if (h.lat !== null && h.lng !== null) {
    var dist = haversineMiles(h.lat, h.lng, row.lat, row.lng);
    var limit = Math.max(250, row.radiusMi * 3);
    if (dist > limit) {
      return { row: null, reason: 'far', distanceMi: Math.round(dist), candidate: row.name, how: found.how };
    }
  }
  return { row: row, how: found.how };
}

// ── link rewriting ──

function fmtRadius(r) {
  return Number.isInteger(r) ? String(r) : String(Math.round(r * 10) / 10);
}

function fmtCoord(c) { return String(Math.round(c * 1e6) / 1e6); }

// Rewrite one dl.tvllnk.com link. Returns { url, changed, ...detail }.
function rewriteLink(url, opts) {
  var enabled = !opts || opts.enabled !== false;
  var out = { url: url, changed: false };
  if (!enabled || typeof url !== 'string' || url.indexOf(LINK_PREFIX) !== 0) return out;
  var u;
  try { u = new URL(url); } catch (e) { return out; }
  var p = u.searchParams;
  var st = p.get('st') || '';
  var loc = p.get('loc');
  if (!loc || /^flights$/i.test(st)) return out; // flights carry no place, only airports
  var res = resolve(loc, { dst: p.get('dst'), lat: p.get('lat'), lng: p.get('lng') });
  out.loc = loc;
  if (!res.row) { out.reason = res.reason; if (res.candidate) { out.candidate = res.candidate; out.distanceMi = res.distanceMi; } return out; }
  var row = res.row;
  var before = { lat: p.get('lat'), lng: p.get('lng'), rad: p.get('rad'), dst: p.get('dst') };
  p.set('lat', fmtCoord(row.lat));
  p.set('lng', fmtCoord(row.lng));
  p.set('rad', fmtRadius(row.radiusMi));
  if (p.has('dst') && row.iata) p.set('dst', row.iata);
  var next = u.toString();
  out.url = next;
  out.changed = next !== url;
  out.matched = row.name;
  out.how = res.how;
  out.before = before;
  out.after = { lat: p.get('lat'), lng: p.get('lng'), rad: p.get('rad'), dst: p.get('dst') };
  return out;
}

function logResult(r) {
  if (!r || !r.loc) return;
  try {
    if (r.matched) {
      console.log('[geo] loc="' + r.loc + '" -> "' + r.matched + '" (' + r.how + ') rad ' + r.before.rad + '->' + r.after.rad
        + (r.before.dst !== r.after.dst ? ' dst ' + r.before.dst + '->' + r.after.dst : ''));
    } else if (r.reason === 'far') {
      console.log('[geo] loc="' + r.loc + '" rejected "' + r.candidate + '" (' + r.how + '): model coords ' + r.distanceMi + ' mi away');
    } else {
      console.log('[geo] loc="' + r.loc + '" ' + r.reason + ' (left as the model built it)');
    }
  } catch (e) { /* logging never breaks a reply */ }
}

// Rewrite every deep link in a piece of text.
function rewriteDeepLinks(text, opts) {
  if (!text || typeof text !== 'string' || text.indexOf(LINK_PREFIX) === -1) return text;
  return text.replace(LINK_RE, function (m) {
    var r = rewriteLink(m, opts);
    if (!opts || opts.quiet !== true) logResult(r);
    return r.url;
  });
}

// Streaming: deltas arrive a few characters at a time and a link can straddle
// several. This holds back only a link in progress (and any tail that could be
// the start of one) so nothing partial is ever sent to the widget. Prose keeps
// flowing; the widget already buffers a [BLOCK] until it closes, so holding the
// link inside it is invisible to the visitor.
function createStreamRewriter(opts) {
  var pending = '';
  var MAX_HOLD = 4096;

  function process(final) {
    var out = '';
    for (;;) {
      var i = pending.indexOf(LINK_PREFIX);
      if (i === -1) {
        if (final) { out += pending; pending = ''; return out; }
        // Keep any tail that is a prefix of the link start.
        var keep = 0;
        for (var k = Math.min(LINK_PREFIX.length - 1, pending.length); k > 0; k--) {
          if (LINK_PREFIX.indexOf(pending.slice(pending.length - k)) === 0) { keep = k; break; }
        }
        out += pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        return out;
      }
      out += pending.slice(0, i);
      pending = pending.slice(i);
      var endM = URL_END.exec(pending);
      var end = endM ? endM.index : -1;
      if (end === -1 && !final && pending.length < MAX_HOLD) return out; // link still arriving
      if (end === -1) end = pending.length;
      out += rewriteDeepLinks(pending.slice(0, end), opts);
      pending = pending.slice(end);
    }
  }

  return {
    push: function (delta) { pending += (delta || ''); return process(false); },
    flush: function () { return process(true); }
  };
}

module.exports = {
  normalise: normalise,
  resolve: resolve,
  rewriteLink: rewriteLink,
  rewriteDeepLinks: rewriteDeepLinks,
  createStreamRewriter: createStreamRewriter,
  tableSize: function () { return TABLE.rows.length; },
  tableUnit: TABLE.unit,
  _internals: { candidatesFor: candidatesFor, levenshtein: levenshtein, haversineMiles: haversineMiles, segmentAliases: segmentAliases }
};
