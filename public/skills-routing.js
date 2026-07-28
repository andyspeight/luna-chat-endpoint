// lib/skills-routing.js
// ─────────────────────────────────────────────────────────────────────────────
// Skills-based routing for live chats. When a conversation needs a human, we
// route it to the agents whose free-text specialisms match what the chat is
// about — and if none of those agents is available, it falls back to everyone
// (the "hard, but never leave a chat unanswered" rule the owner chose).
//
// This module is PURE (no I/O): given the conversation's detected terms and the
// agents' specialisms + online state, it decides who the chat routes to. The
// endpoint layer supplies presence and agent data; the dashboard applies the
// decision. Keeping the logic here makes it fully unit-testable.
//
// Matching is deliberately forgiving because agent tags are free text:
//   - case/space-insensitive, comma/newline/semicolon separated phrases
//   - phrase containment either direction ("maldives" ⊂ "the maldives")
//   - region roll-up: a chat about "Maldives" also counts as "Indian Ocean",
//     so an agent tagged only "Indian Ocean" still matches. This is what makes
//     the headline example work with free-text tags.

// UMD: works as a CommonJS module (node/tests: require) AND in the browser
// (dashboard/widget: window.SkillsRouting), so there is ONE source of truth.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SkillsRouting = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// Destination → region roll-up. Lowercase, normalised. Extend freely; unknown
// destinations simply don't roll up (they still match on the literal name).
var REGION_MAP = {
  'indian ocean': ['maldives', 'mauritius', 'seychelles', 'zanzibar', 'sri lanka', 'madagascar', 'reunion', 'la reunion', 'maldive'],
  'caribbean': ['barbados', 'antigua', 'jamaica', 'st lucia', 'saint lucia', 'dominican republic', 'punta cana', 'cuba', 'bahamas', 'grenada', 'aruba', 'turks and caicos', 'st kitts', 'saint kitts', 'tobago', 'trinidad', 'curacao', 'bermuda'],
  'mediterranean': ['greece', 'spain', 'italy', 'portugal', 'turkey', 'cyprus', 'croatia', 'malta', 'balearics', 'majorca', 'mallorca', 'menorca', 'ibiza', 'crete', 'rhodes', 'kos', 'corfu', 'zante', 'santorini', 'mykonos', 'sicily', 'sardinia', 'costa del sol', 'costa blanca', 'algarve', 'benidorm', 'marbella', 'lanzarote', 'tenerife', 'gran canaria', 'fuerteventura', 'canaries', 'canary islands'],
  'far east': ['thailand', 'bali', 'vietnam', 'singapore', 'malaysia', 'cambodia', 'japan', 'indonesia', 'philippines', 'phuket', 'koh samui', 'bangkok', 'hong kong', 'laos', 'south east asia', 'southeast asia'],
  'middle east': ['dubai', 'abu dhabi', 'oman', 'qatar', 'uae', 'united arab emirates', 'ras al khaimah', 'jordan'],
  'usa': ['florida', 'orlando', 'new york', 'las vegas', 'california', 'los angeles', 'san francisco', 'miami', 'hawaii', 'boston', 'washington'],
  'mexico': ['cancun', 'riviera maya', 'playa del carmen', 'tulum', 'cabo'],
  'safari': ['kenya', 'tanzania', 'south africa', 'botswana', 'namibia', 'zambia', 'zimbabwe', 'serengeti', 'masai mara', 'kruger'],
  'europe': ['paris', 'rome', 'barcelona', 'amsterdam', 'prague', 'lisbon', 'venice', 'budapest', 'vienna', 'berlin', 'iceland', 'reykjavik']
};

// Trip-type synonyms so an agent tagged e.g. "honeymoons" matches a chat flagged
// holidayType "honeymoon" or a message about a honeymoon.
var TYPE_SYNONYMS = {
  'honeymoon': ['honeymoons', 'honeymooners', 'romantic'],
  'cruise': ['cruises', 'cruising'],
  'ski': ['skiing', 'snowboard', 'winter sports', 'alps'],
  'luxury': ['5 star', 'five star', 'premium', 'high end'],
  'family': ['families', 'kids', 'children'],
  'all inclusive': ['all-inclusive', 'ai'],
  'adventure': ['trekking', 'expedition', 'active']
};

function normalise(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Split a free-text specialisms string into normalised phrases.
function splitTags(freeText) {
  return String(freeText == null ? '' : freeText)
    .split(/[,;\n|\/]+/)
    .map(normalise)
    .filter(function (p) { return p.length > 0; });
}

// Reverse lookup: for a destination term, which region(s) does it belong to.
function regionsForTerm(term) {
  var out = [];
  var t = normalise(term);
  if (!t) return out;
  Object.keys(REGION_MAP).forEach(function (region) {
    if (region === t) { out.push(region); return; }
    var members = REGION_MAP[region];
    for (var i = 0; i < members.length; i++) {
      // member appears as a whole phrase inside the term (or vice-versa)
      if (t === members[i] || t.indexOf(members[i]) !== -1) { out.push(region); return; }
    }
  });
  return out;
}

// Expand a raw term with its trip-type synonyms (both directions).
function typeExpansions(term) {
  var out = [];
  var t = normalise(term);
  Object.keys(TYPE_SYNONYMS).forEach(function (base) {
    if (t === base || t.indexOf(base) !== -1) { out.push(base); }
    var syns = TYPE_SYNONYMS[base];
    for (var i = 0; i < syns.length; i++) {
      if (t.indexOf(syns[i]) !== -1) { out.push(base); out.push(syns[i]); }
    }
  });
  return out;
}

// Build the set of normalised phrases that describe a conversation, from the
// signals we already capture: the trip-brief destination, topic tags, holiday
// type, and (optionally) free extracted keywords. Rolls destinations up to
// regions and expands trip types so free-text agent tags have something to hit.
function deriveConversationTerms(input) {
  input = input || {};
  var terms = new Set();
  var add = function (v) { var n = normalise(v); if (n) terms.add(n); };

  // Primary: destination (from the trip brief) — most reliable topic signal.
  if (input.destination) {
    add(input.destination);
    regionsForTerm(input.destination).forEach(add);
    typeExpansions(input.destination).forEach(add);
  }
  // Topic tags (from quality scoring / classification).
  (Array.isArray(input.topicTags) ? input.topicTags : []).forEach(function (tag) {
    add(tag);
    regionsForTerm(tag).forEach(add);
    typeExpansions(tag).forEach(add);
  });
  // Holiday type (beach / honeymoon / cruise / ski …).
  if (input.holidayType) { add(input.holidayType); typeExpansions(input.holidayType).forEach(add); }
  // Any extra free terms the caller wants to include (e.g. keywords).
  (Array.isArray(input.extraTerms) ? input.extraTerms : []).forEach(function (t) {
    add(t);
    regionsForTerm(t).forEach(add);
    typeExpansions(t).forEach(add);
  });

  return Array.from(terms);
}

// Does an agent's specialisms match any conversation term? Returns the matching
// term (for display) or null. Forgiving phrase containment either direction.
function agentMatch(specialisms, conversationTerms) {
  var tags = Array.isArray(specialisms) ? specialisms.map(normalise) : splitTags(specialisms);
  if (!tags.length || !conversationTerms || !conversationTerms.length) return null;
  for (var i = 0; i < tags.length; i++) {
    var tag = tags[i];
    if (!tag) continue;
    for (var j = 0; j < conversationTerms.length; j++) {
      var term = conversationTerms[j];
      if (!term) continue;
      // whole-phrase match either direction: "indian ocean" == "indian ocean",
      // "maldives" ⊂ "the maldives", "luxury" ⊂ "luxury honeymoons".
      if (tag === term || tag.indexOf(term) !== -1 || term.indexOf(tag) !== -1) {
        return { tag: tag, term: term };
      }
    }
  }
  return null;
}

// The routing decision. agents: [{ id, name, specialisms, online }]. Returns:
//   { routedTo: [agent...], matchedAgents: [{agent, on}], matchedSkill, fallbackUsed, terms }
// Rule (owner's choice): route to online agents whose specialisms match. If none
// match, fall back to ALL online agents so the chat is never left unanswered.
function routeConversation(opts) {
  opts = opts || {};
  var agents = Array.isArray(opts.agents) ? opts.agents : [];
  var terms = Array.isArray(opts.conversationTerms)
    ? opts.conversationTerms
    : deriveConversationTerms(opts.conversation || {});

  var online = agents.filter(function (a) { return a && a.online; });

  var matchedAgents = [];
  online.forEach(function (a) {
    var m = agentMatch(a.specialisms, terms);
    if (m) matchedAgents.push({ agent: a, on: m });
  });

  var fallbackUsed = matchedAgents.length === 0;
  var routedTo = fallbackUsed ? online.slice() : matchedAgents.map(function (x) { return x.agent; });
  // The single skill label to surface in the UI (first matched term).
  var matchedSkill = matchedAgents.length ? matchedAgents[0].on.term : null;

  return {
    routedTo: routedTo,
    matchedAgents: matchedAgents,
    matchedSkill: matchedSkill,
    fallbackUsed: fallbackUsed,
    terms: terms
  };
}

return {
  REGION_MAP: REGION_MAP,
  TYPE_SYNONYMS: TYPE_SYNONYMS,
  normalise: normalise,
  splitTags: splitTags,
  regionsForTerm: regionsForTerm,
  deriveConversationTerms: deriveConversationTerms,
  agentMatch: agentMatch,
  routeConversation: routeConversation
};
});
