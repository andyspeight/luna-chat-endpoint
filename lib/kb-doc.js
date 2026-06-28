// lib/kb-doc.js
// Pure helpers that turn an Airtable knowledge row into the document we embed +
// store for semantic search, plus the hybrid-merge used at query time. Kept pure
// so the indexer and the chat path share identical logic and it is unit-testable.

'use strict';

var crypto = require('crypto');
var gk = require('./global-knowledge');

function valueOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueOf).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.name || '';
  return String(v);
}
function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
// Like clip but preserves line breaks (collapses only intra-line whitespace), so
// the readable content block keeps its structure in Luna's prompt.
function clipBlock(s, n) {
  return String(s == null ? '' : s)
    .split('\n')
    .map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); })
    .filter(function (line) { return line.length; })
    .join('\n')
    .slice(0, n);
}

// Readable "Field: value" block from a curated field list (skips blanks / link arrays).
function labelled(fields, keys) {
  var lines = [];
  keys.forEach(function (k) {
    var v = fields[k];
    if (v == null) return;
    if (Array.isArray(v) && v.length && typeof v[0] === 'string' && v[0].indexOf('rec') === 0) return; // record links
    var text = valueOf(v);
    if (!text) return;
    lines.push(k + ': ' + clip(text, 500));
  });
  return lines.join('\n');
}

var DEST_CONTENT_FIELDS = ['Name', 'Type', 'Country', 'Parent', 'Region', 'Currency', 'Capital', 'Languages',
  'Time Zone', 'Dialling Code', 'Emergency Number', 'Driving Side', 'Plug Type', 'Voltage', 'UK Visa Required',
  'Tap Water Safe', 'FCDO Status', 'Best Months to Visit', 'Main Airport', 'Nearest Airport', 'Transfer Time'];
var TRANSPORT_CONTENT_FIELDS = ['Name', 'Type', 'Code', 'Country', 'City', 'Key Tips', 'Info 1', 'Info 2', 'Info 3', 'Info 4', 'Info 5', 'Info 6'];

// Build the embed document for a row, or null if there's nothing to index.
//   embedText: the text actually embedded (rich, term-heavy).
//   content:   the readable grounding block served into Luna's prompt.
function buildEmbedDoc(tableName, rec) {
  if (!rec || !rec.id) return null;
  var f = rec.fields || {};

  if (tableName === 'Knowledge') {
    var q = clip(f['Question'], 500);
    var a = clip(f['Consumer Answer'] || f['Agent Answer'], 3000);
    if (!q && !a) return null;
    var cat = valueOf(f['Category']);
    var related = clip(f['Related To'], 200);
    var embedText = [q, clip(f['Alt Phrasings'], 1000), a, cat, related].filter(Boolean).join(' ');
    var content = (q ? ('Q: ' + q + '\n') : '') + (a ? ('A: ' + a) : '');
    return { id: rec.id, table_name: 'Knowledge', name: q.slice(0, 200), question: q, content: clipBlock(content, 4000), source: f['Source'] || '', embedText: clip(embedText, 8000) };
  }

  if (tableName === 'Destinations') {
    var dn = clip(f['Name'], 200);
    if (!dn) return null;
    return { id: rec.id, table_name: 'Destinations', name: dn, question: '', content: clipBlock(labelled(f, DEST_CONTENT_FIELDS), 4000), source: '', embedText: clip(gk.buildDestinationSearchIndex(f), 8000) || dn };
  }

  if (tableName === 'Transport') {
    var tn = clip(f['Name'], 200);
    if (!tn) return null;
    return { id: rec.id, table_name: 'Transport', name: tn, question: '', content: clipBlock(labelled(f, TRANSPORT_CONTENT_FIELDS), 4000), source: '', embedText: clip(gk.buildTransportSearchIndex(f), 8000) || tn };
  }

  return null;
}

// Stable hash of the embed text, so the indexer re-embeds only changed rows.
function contentHash(embedText) {
  return crypto.createHash('sha1').update(String(embedText == null ? '' : embedText)).digest('hex');
}

// Merge semantic + keyword hits into one ordered, de-duplicated list (semantic
// first, since it is relevance-ranked), capped. Each input item must have an id.
// Pure: when one side is empty this is just the other side, deduped.
function mergeById(primary, secondary, cap) {
  cap = cap || 8;
  var seen = {}, out = [];
  function add(list) {
    (list || []).forEach(function (item) {
      if (!item || !item.id || seen[item.id]) return;
      seen[item.id] = 1; out.push(item);
    });
  }
  add(primary); add(secondary);
  return out.slice(0, cap);
}

module.exports = {
  buildEmbedDoc: buildEmbedDoc,
  contentHash: contentHash,
  mergeById: mergeById,
  _internal: { labelled: labelled, valueOf: valueOf, DEST_CONTENT_FIELDS: DEST_CONTENT_FIELDS, TRANSPORT_CONTENT_FIELDS: TRANSPORT_CONTENT_FIELDS }
};
