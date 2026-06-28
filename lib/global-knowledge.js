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
var REVERIFICATION_TABLE = 'tblCimk9x32l3LRMK'; // anti-staleness re-verify queue
var TRANSPORT_TABLE = 'tbl8CRDV48QGjDx2a';     // unified Transport (airports/airlines/cruise)

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

// Normalise an Airtable cell to plain searchable text. Handles single-select
// objects ({name}) and multi-select / linked arrays defensively, so the index
// builders work whether a field is read as a string, an object, or an array.
function flatVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flatVal).join(' ');
  if (typeof v === 'object') return v.name || '';
  return String(v);
}

function joinIndex(parts) {
  return parts.map(flatVal).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// Build the Search Index for a Destinations row from its own fields (the field
// object as returned by the Airtable REST API). Deterministic, no LLM. Used by
// the backfill job and the admin "add destination" action so a hand-added row is
// instantly findable by the widget.
function buildDestinationSearchIndex(f) {
  f = f || {};
  return joinIndex([
    f['Name'], f['Type'], f['Country'], f['Parent'], f['Region'], f['ISO Code'],
    f['Currency'], f['Capital'], f['Languages'], f['Time Zone'], f['Dialling Code'],
    f['Emergency Number'], f['Driving Side'], f['Plug Type'], f['Voltage'],
    f['UK Visa Required'], f['Tap Water Safe'], f['FCDO Status'],
    f['Best Months to Visit'], f['Main Airport'], f['Resort Type'],
    f['Nearest Airport'], f['Transfer Time']
  ]);
}

// Build the Search Index for a Transport row (airport / airline / cruise line or
// port) from its own fields. Deterministic, no LLM.
function buildTransportSearchIndex(f) {
  f = f || {};
  return joinIndex([
    f['Name'], f['Type'], f['Code'], f['Country'], f['City'], f['Key Tips'],
    f['Info 1'], f['Info 2'], f['Info 3'], f['Info 4'], f['Info 5'], f['Info 6']
  ]);
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

function capConfidence(c) {
  var v = String(c || '').toLowerCase();
  return v === 'high' ? 'High' : (v === 'low' ? 'Low' : 'Medium');
}

// Map a deterministic connector draft (Ticketmaster / Foursquare) to live
// Knowledge fields for trusted-source auto-publish. These drafts are built by
// code straight from a trusted API (no LLM), so they bypass the human queue.
// category / relatedTo / seasonal are supplied by the caller; Search Index and
// Last Verified are built by suggestionToKnowledgeFields.
function connectorDraftToKnowledgeFields(draft, opts) {
  draft = draft || {}; opts = opts || {};
  return suggestionToKnowledgeFields({
    question: draft.question,
    consumerAnswer: draft.answer,
    category: opts.category || 'Other',
    relatedTo: opts.relatedTo || '',
    source: draft.sourceUrl || opts.source || '',
    confidence: capConfidence(draft.confidence),
    seasonal: opts.seasonal
  }, opts.now ? { now: opts.now } : undefined);
}

// Decide what to do with a connector draft given any existing live Knowledge row
// for the same (exact) question:
//   - no existing row            -> create (auto-publish).
//   - existing row this connector owns (its Source names the connector) -> update
//     (refresh, e.g. keep event listings current each rotation).
//   - existing row owned by something else (a human edit, another source) -> skip,
//     so connector auto-publish never clobbers curated/human content.
// connectorKey is a lowercase token expected in the owning Source URL, e.g.
// 'foursquare' or 'ticketmaster'.
function decidePublish(existing, connectorKey) {
  if (!existing || !existing.id) return { action: 'create' };
  var src = String(existing.source || '').toLowerCase();
  if (connectorKey && src.indexOf(connectorKey) !== -1) return { action: 'update', id: existing.id };
  return { action: 'skip', reason: 'owned_by_other_source', id: existing.id };
}

module.exports = {
  GLOBAL_BASE: GLOBAL_BASE,
  KNOWLEDGE_TABLE: KNOWLEDGE_TABLE,
  SUGGESTED_TABLE: SUGGESTED_TABLE,
  DISCOVERY_SOURCES_TABLE: DISCOVERY_SOURCES_TABLE,
  DESTINATIONS_TABLE: DESTINATIONS_TABLE,
  REVERIFICATION_TABLE: REVERIFICATION_TABLE,
  TRANSPORT_TABLE: TRANSPORT_TABLE,
  buildSearchIndex: buildSearchIndex,
  buildDestinationSearchIndex: buildDestinationSearchIndex,
  buildTransportSearchIndex: buildTransportSearchIndex,
  suggestionToKnowledgeFields: suggestionToKnowledgeFields,
  capConfidence: capConfidence,
  connectorDraftToKnowledgeFields: connectorDraftToKnowledgeFields,
  decidePublish: decidePublish
};
