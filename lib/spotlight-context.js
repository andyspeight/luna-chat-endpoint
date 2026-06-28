// lib/spotlight-context.js
// Grounding for the Destination Spotlight card. Pulls VERIFIED facts for the
// page's destination from the global knowledge base (the same auto-published
// things-to-do + destination facts + Q&A that power Luna), so the card names
// only real places, not whatever the model remembers. Pure helpers are exported
// for tests; the fetch is fail-safe (never throws -> card falls back to generic).

'use strict';

var GLOBAL_BASE = 'appPKx77relfeiqmq';
var KNOWLEDGE_TABLE = 'tblgdLszaPmquxQ7O';
var DESTINATIONS_TABLE = 'tblirr0vJuQcTLuH2';

var STOP = { the: 1, and: 1, for: 1, with: 1, your: 1, you: 1, our: 1, holidays: 1, holiday: 1,
  holidaytypes: 1, destinations: 1, destination: 1, guide: 1, guides: 1, travel: 1, page: 1,
  home: 1, deals: 1, offers: 1, book: 1, booking: 1, best: 1, top: 1, things: 1, what: 1,
  where: 1, when: 1, how: 1, from: 1, all: 1, more: 1, about: 1 };

function cleanWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length > 2 && !STOP[w]; });
}

// Derive a search query + a best-guess display name from the page context.
// Prefers the title, then the last path segment.
function deriveQuery(pageContext) {
  pageContext = pageContext || {};
  var title = pageContext.title || '';
  var seg = String(pageContext.path || '').split('/').filter(Boolean).pop() || '';
  seg = seg.replace(/[-_]+/g, ' ');
  var words = cleanWords(title).concat(cleanWords(seg));
  // de-dupe, keep order, cap to the most useful few terms
  var seen = {}, terms = [];
  words.forEach(function (w) { if (!seen[w]) { seen[w] = 1; terms.push(w); } });
  var name = (title || seg).trim();
  return { name: name.slice(0, 80), query: terms.slice(0, 4).join(' '), terms: terms };
}

function valueOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueOf).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.name || '';
  return String(v);
}

// Split matched Knowledge rows into things-to-do, events and general Q&A using
// the Category, so the evidence block can present them clearly.
function classifyKnowledge(rows) {
  var thingsToDo = [], events = [], qa = [];
  (rows || []).forEach(function (f) {
    if (!f) return;
    var cat = valueOf(f['Category']).toLowerCase();
    var answer = (f['Consumer Answer'] || f['Agent Answer'] || '').trim();
    var q = (f['Question'] || '').trim();
    if (!answer && !q) return;
    if (cat.indexOf('things to do') !== -1) thingsToDo.push(answer || q);
    else if (cat.indexOf('event') !== -1) events.push(answer || q);
    else if (q) qa.push({ q: q, a: answer });
  });
  return { thingsToDo: thingsToDo, events: events, qa: qa };
}

// Pull a few evergreen facts from a Destinations row.
function summariseFacts(destFields) {
  var f = destFields || {};
  var out = {};
  ['Region', 'Country', 'Best Months to Visit', 'Currency', 'Type'].forEach(function (k) {
    var v = valueOf(f[k]); if (v) out[k] = v;
  });
  return out;
}

// Build a compact, grounded evidence block for the card prompt. Returns '' when
// there is nothing verified (caller then composes a safe, generic card).
function buildEvidenceText(ctx) {
  ctx = ctx || {};
  var lines = [];
  var facts = ctx.facts || {};
  var factBits = [];
  if (facts['Region']) factBits.push('Region: ' + facts['Region']);
  if (facts['Country']) factBits.push('Country: ' + facts['Country']);
  if (facts['Best Months to Visit']) factBits.push('Best months: ' + facts['Best Months to Visit']);
  if (factBits.length) lines.push(factBits.join(' | '));

  if (ctx.thingsToDo && ctx.thingsToDo.length) {
    lines.push('Real things to do and places (use ONLY these for specific names): ' + ctx.thingsToDo.slice(0, 4).join(' '));
  }
  if (ctx.events && ctx.events.length) {
    lines.push('What is on (venues are real; do NOT include specific dates in the card): ' + ctx.events.slice(0, 2).join(' '));
  }
  if (ctx.qa && ctx.qa.length) {
    ctx.qa.slice(0, 4).forEach(function (item) { lines.push('Q: ' + item.q + ' A: ' + (item.a || '').slice(0, 240)); });
  }
  return lines.join('\n').slice(0, 3500);
}

function sanitizeLiteral(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'); }

async function atSearch(table, query, atKey, pageSize) {
  var url = 'https://api.airtable.com/v0/' + GLOBAL_BASE + '/' + table
    + '?pageSize=' + (pageSize || 6)
    + '&filterByFormula=' + encodeURIComponent('SEARCH("' + sanitizeLiteral(query) + '", {Search Index})');
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey }, signal: AbortSignal.timeout(3500) });
  if (!r.ok) return [];
  var d = await r.json();
  return (d.records || []).map(function (rec) { return rec.fields || {}; });
}

// Fetch verified context for the page. Never throws; returns
// { found, name, query, facts, thingsToDo, events, qa, evidence }.
async function fetchVerifiedContext(pageContext, atKey, opts) {
  opts = opts || {};
  var dq = deriveQuery(pageContext);
  var empty = { found: false, name: dq.name, query: dq.query, facts: {}, thingsToDo: [], events: [], qa: [], evidence: '' };
  if (!atKey || !dq.query) return empty;
  try {
    var both = await Promise.all([
      atSearch(KNOWLEDGE_TABLE, dq.query, atKey, opts.knowledgeSize || 8).catch(function () { return []; }),
      atSearch(DESTINATIONS_TABLE, dq.query, atKey, 1).catch(function () { return []; })
    ]);
    var classified = classifyKnowledge(both[0]);
    var facts = summariseFacts(both[1][0]);
    var ctx = {
      found: false, name: dq.name, query: dq.query,
      facts: facts, thingsToDo: classified.thingsToDo, events: classified.events, qa: classified.qa
    };
    ctx.evidence = buildEvidenceText(ctx);
    ctx.found = !!ctx.evidence;
    return ctx;
  } catch (e) {
    return empty;
  }
}

module.exports = {
  deriveQuery: deriveQuery,
  classifyKnowledge: classifyKnowledge,
  summariseFacts: summariseFacts,
  buildEvidenceText: buildEvidenceText,
  fetchVerifiedContext: fetchVerifiedContext
};
