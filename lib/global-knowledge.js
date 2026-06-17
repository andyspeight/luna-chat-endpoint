// lib/global-knowledge.js
// Helpers for the global (shared) knowledge base that powers Luna and the
// widgets for every client: base appPKx77relfeiqmq.
//
// The widgets search the unified Knowledge table via its "Search Index" field
// with NO status filter, so any row there is instantly live. We therefore never
// write drafts into it: discovery writes to the Suggested Knowledge staging
// table, and only an explicit human Approve promotes a suggestion into Knowledge
// (with its Search Index built so it is findable, and Last Verified stamped).
//
// These functions are pure so the promotion logic can be unit-tested.

'use strict';

var GLOBAL_BASE = 'appPKx77relfeiqmq';
var KNOWLEDGE_TABLE = 'tblgdLszaPmquxQ7O';     // unified Knowledge (live, widget-searched)
var SUGGESTED_TABLE = 'tblazKYYAENwRUjyS';     // Suggested Knowledge (staging)
var DISCOVERY_SOURCES_TABLE = 'tblLq1NiTacsFDGsJ';
var DESTINATIONS_TABLE = 'tblirr0vJuQcTLuH2';  // unified Destinations (~230, widget-searched)

// Build the Search Index the widgets match against. The widget does a plain
// case-insensitive SEARCH() over this single field, so it simply needs to
// contain every term a visitor might use. We concatenate the human-meaningful
// fields, collapse whitespace, and cap length.
function buildSearchIndex(rec) {
  rec = rec || {};
  var parts = [rec.question, rec.altPhrasings, rec.consumerAnswer, rec.agentAnswer, rec.category, rec.relatedTo, rec.tags];
  var text = parts.map(function (p) { return p == null ? '' : String(p); })
    .filter(Boolean).join(' ')
    .replace(/\s+/g, ' ').trim();
  return text.slice(0, 4000);
}

// Map a staging suggestion to global Knowledge fields (by NAME; write with
// typecast:true so any new Category option, e.g. "Things To Do", is created).
function suggestionToKnowledgeFields(s, opts) {
  opts = opts || {};
  s = s || {};
  var consumer = (s.consumerAnswer || '').trim();
  var category = s.category || 'Other';
  var relatedTo = s.relatedTo || '';
  var fields = {
    'Question': (s.question || '').trim(),
    'Consumer Answer': consumer,
    'Category': category,
    'Related To': relatedTo,
    'Source': s.source || '',
    'Confidence': s.confidence || 'Medium',
    'Audience': s.audience || 'Both',
    'Last Verified': (opts.now ? new Date(opts.now) : new Date()).toISOString().split('T')[0]
  };
  if (s.agentAnswer) fields['Agent Answer'] = s.agentAnswer;
  if (s.altPhrasings) fields['Alt Phrasings'] = s.altPhrasings;
  if (s.seasonal != null) fields['Seasonal'] = !!s.seasonal;
  fields['Search Index'] = buildSearchIndex({
    question: fields['Question'], altPhrasings: s.altPhrasings, consumerAnswer: consumer,
    agentAnswer: s.agentAnswer, category: category, relatedTo: relatedTo, tags: s.tags
  });
  return fields;
}

module.exports = {
  GLOBAL_BASE: GLOBAL_BASE,
  KNOWLEDGE_TABLE: KNOWLEDGE_TABLE,
  SUGGESTED_TABLE: SUGGESTED_TABLE,
  DISCOVERY_SOURCES_TABLE: DISCOVERY_SOURCES_TABLE,
  DESTINATIONS_TABLE: DESTINATIONS_TABLE,
  buildSearchIndex: buildSearchIndex,
  suggestionToKnowledgeFields: suggestionToKnowledgeFields
};
