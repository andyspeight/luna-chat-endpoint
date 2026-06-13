// Luna Knowledge freshness module
//
// Pure, side-effect-free helpers that decide whether a Knowledge item is due a
// human re-check. This is deliberately ADVISORY: it never changes what Luna
// retrieves or says. It only classifies age so the owner can be shown a
// "review due" queue and a re-verify button in Luna Brain.
//
// Freshness anchor for an item is, in order of preference:
//   1. LastVerifiedAt  — when a human last confirmed the answer is still current
//   2. createdTime     — Airtable's native record creation time (always present)
// A brand-new item is therefore "fresh" until it ages, even before anyone has
// verified it, so we never nag about knowledge that was just added.
//
// Anti-hallucination posture: this module asserts nothing about the CONTENT of
// an answer. It cannot tell whether a fact is right, only how long it has gone
// unchecked. The human re-verify step is what re-establishes trust.
//
// Used by: api/knowledge-freshness.js (cron digest) and api/luna-brain.js
// (the review-due queue in the owner feed).

'use strict';

// Default review windows, in days. Deliberately conservative so the queue is
// signal not noise. Time-sensitive categories decay faster (see TYPE_WINDOWS).
var DEFAULTS = { reviewDays: 180, overdueDays: 365 };

// Per-Type overrides. Prices and supplier rules go stale fastest, so they fall
// due for a re-check sooner. Anything not listed uses DEFAULTS.
var TYPE_WINDOWS = {
  'Pricing':       { reviewDays: 90,  overdueDays: 180 },
  'Supplier Rule': { reviewDays: 120, overdueDays: 240 },
  'Booking Process': { reviewDays: 120, overdueDays: 240 }
};

// Whole-day age between an ISO timestamp and `now`. Negative ages (clock skew,
// a future-dated verification) are clamped to 0. Returns null for missing or
// unparseable input so callers can treat it as "unknown" rather than "ancient".
function ageInDays(iso, now) {
  if (!iso) return null;
  var t = Date.parse(iso);
  if (isNaN(t)) return null;
  var ms = now.getTime() - t;
  if (ms < 0) ms = 0;
  return Math.floor(ms / 86400000);
}

// Resolve the effective review windows for an item, honouring per-type overrides
// and any caller-supplied opts (opts wins, so the endpoint can tune via env).
function windowsFor(type, opts) {
  opts = opts || {};
  var base = (type && TYPE_WINDOWS[type]) || DEFAULTS;
  return {
    reviewDays: opts.reviewDays != null ? opts.reviewDays : base.reviewDays,
    overdueDays: opts.overdueDays != null ? opts.overdueDays : base.overdueDays
  };
}

// Classify a single item.
//   item: { lastVerifiedAt?, createdTime?, type? }
// Returns { state, ageDays, anchorIso, everVerified, windows }.
//   state is one of: 'fresh' | 'review_due' | 'overdue' | 'unknown'
function classifyFreshness(item, now, opts) {
  now = now || new Date();
  item = item || {};
  var w = windowsFor(item.type, opts);
  var anchorIso = item.lastVerifiedAt || item.createdTime || null;
  var ageDays = ageInDays(anchorIso, now);

  var state;
  if (ageDays === null) state = 'unknown';
  else if (ageDays >= w.overdueDays) state = 'overdue';
  else if (ageDays >= w.reviewDays) state = 'review_due';
  else state = 'fresh';

  return {
    state: state,
    ageDays: ageDays,
    anchorIso: anchorIso,
    everVerified: !!item.lastVerifiedAt,
    windows: w
  };
}

// True when an item should appear in the review queue.
function isStale(state) {
  return state === 'review_due' || state === 'overdue';
}

// Classify a list and return only the stale ones, each annotated with its
// freshness result, sorted most-urgent first (overdue before review_due, then
// oldest first within each band). `items` carry their own id and display fields;
// we pass the whole item back through so callers keep their shape.
function selectStale(items, now, opts) {
  now = now || new Date();
  var out = [];
  (items || []).forEach(function(it) {
    var f = classifyFreshness(it, now, opts);
    if (isStale(f.state)) {
      out.push(Object.assign({}, it, {
        freshnessState: f.state,
        ageDays: f.ageDays,
        everVerified: f.everVerified
      }));
    }
  });
  out.sort(function(a, b) {
    // overdue (1) ranks above review_due (0)
    var rank = function(s) { return s === 'overdue' ? 1 : 0; };
    var dr = rank(b.freshnessState) - rank(a.freshnessState);
    if (dr !== 0) return dr;
    return (b.ageDays || 0) - (a.ageDays || 0); // oldest first
  });
  return out;
}

// Count a list by freshness state. Returns { fresh, review_due, overdue, unknown, stale }.
function summarise(items, now, opts) {
  now = now || new Date();
  var c = { fresh: 0, review_due: 0, overdue: 0, unknown: 0, stale: 0 };
  (items || []).forEach(function(it) {
    var s = classifyFreshness(it, now, opts).state;
    c[s] = (c[s] || 0) + 1;
    if (isStale(s)) c.stale += 1;
  });
  return c;
}

// Age distribution across a list, regardless of threshold. Lets a dashboard show
// "everything was last verified N days ago" even when nothing is past review yet.
// Returns { count, withAnchor, oldestDays, newestDays, avgDays }.
function ageStats(items, now) {
  now = now || new Date();
  var ages = [];
  (items || []).forEach(function(it) {
    var anchor = it.lastVerifiedAt || it.createdTime || null;
    var d = ageInDays(anchor, now);
    if (d !== null) ages.push(d);
  });
  if (!ages.length) {
    return { count: (items || []).length, withAnchor: 0, oldestDays: null, newestDays: null, avgDays: null };
  }
  var sum = ages.reduce(function(a, b) { return a + b; }, 0);
  return {
    count: (items || []).length,
    withAnchor: ages.length,
    oldestDays: Math.max.apply(null, ages),
    newestDays: Math.min.apply(null, ages),
    avgDays: Math.round(sum / ages.length)
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  TYPE_WINDOWS: TYPE_WINDOWS,
  ageInDays: ageInDays,
  windowsFor: windowsFor,
  classifyFreshness: classifyFreshness,
  isStale: isStale,
  selectStale: selectStale,
  summarise: summarise,
  ageStats: ageStats
};
