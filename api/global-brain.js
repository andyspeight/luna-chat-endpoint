// api/global-brain.js
// Backend for the GLOBAL knowledge review screen (admin only).
//
// The shared knowledge base (base appPKx77relfeiqmq) powers Luna and the widgets
// for every client. Discovery writes suggestions to the Suggested Knowledge
// staging table; this endpoint lets an admin review them and, on Approve, promote
// a suggestion into the live unified Knowledge table (with its Search Index
// built). Nothing reaches visitors until that explicit approval.
//
// Actions (?action=):
//   feed     GET  — pending suggestions, newest first
//   approve  POST — {id, question?, consumerAnswer?, category?} promote to Knowledge
//   dismiss  POST — {id} mark the suggestion Dismissed
//
// Auth: X-Admin-Pass header must equal ADMIN_PASSWORD (same gate as api/clients).

'use strict';

const crypto = require('crypto');
const gk = require('../lib/global-knowledge');
const freshness = require('../lib/freshness');

// No hardcoded fallback. If ADMIN_PASSWORD is unset, admin auth fails closed.
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; }
}
// Global knowledge is shared, high-traffic data, so it is re-checked more often
// than per-client knowledge. Tunable via env.
const GLOBAL_REVIEW_DAYS = parseInt(process.env.LUNA_GLOBAL_REVIEW_DAYS || '90', 10);
const GLOBAL_OVERDUE_DAYS = parseInt(process.env.LUNA_GLOBAL_OVERDUE_DAYS || '180', 10);

const SF = { // Suggested Knowledge field names
  question: 'Question', consumerAnswer: 'Consumer Answer', agentAnswer: 'Agent Answer',
  category: 'Category', relatedTo: 'Related To', source: 'Source', confidence: 'Confidence',
  status: 'Status', origin: 'Origin', suggestedAt: 'Suggested At', promotedId: 'Promoted Knowledge ID', notes: 'Notes'
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function atFetch(path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + gk.GLOBAL_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

function valueOf(field) {
  if (!field) return '';
  if (typeof field === 'object' && field.name) return field.name;
  return field;
}

// Read the live Knowledge table's verification dates and summarise its health,
// so the review screen can show how stale the shared brain is even when nothing
// is past the review threshold yet.
async function knowledgeHealth() {
  var items = [];
  var offset = null, pages = 0;
  do {
    var path = '/' + gk.KNOWLEDGE_TABLE + '?fields%5B%5D=Last%20Verified&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) {
      items.push({ lastVerifiedAt: (r.fields && r.fields['Last Verified']) || null, createdTime: r.createdTime });
    });
    offset = data.offset || null; pages++;
  } while (offset && pages < 12);
  var now = new Date();
  var stats = freshness.ageStats(items, now);
  var counts = freshness.summarise(items, now, { reviewDays: GLOBAL_REVIEW_DAYS, overdueDays: GLOBAL_OVERDUE_DAYS });
  return {
    total: items.length,
    oldestDays: stats.oldestDays,
    avgDays: stats.avgDays,
    pastReview: counts.stale,
    overdue: counts.overdue,
    reviewDays: GLOBAL_REVIEW_DAYS
  };
}

// Page through every record matching a query (the discovery backlog is now
// hundreds of rows, so the old maxRecords=200 silently hid most of them). Capped
// so a runaway table can never blow the function's memory/time budget.
async function loadAllRecords(table, query, cap) {
  cap = cap || 1000;
  var items = [], offset = null, pages = 0;
  do {
    var path = '/' + table + '?' + query + '&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) { items.push(r); });
    offset = data.offset || null; pages++;
  } while (offset && items.length < cap && pages < 12);
  return items;
}

async function actionFeed() {
  var healthP = knowledgeHealth().catch(function () { return null; });
  var records = await loadAllRecords(gk.SUGGESTED_TABLE,
    'filterByFormula=' + encodeURIComponent("{Status}='Pending'"), 1000);
  var items = records.map(function (rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      question: f[SF.question] || '',
      consumerAnswer: f[SF.consumerAnswer] || '',
      agentAnswer: f[SF.agentAnswer] || '',
      category: valueOf(f[SF.category]) || '',
      relatedTo: f[SF.relatedTo] || '',
      source: f[SF.source] || '',
      confidence: valueOf(f[SF.confidence]) || '',
      origin: valueOf(f[SF.origin]) || '',
      suggestedAt: f[SF.suggestedAt] || rec.createdTime || null,
      notes: f[SF.notes] || ''
    };
  }).sort(function (a, b) {
    return (Date.parse(b.suggestedAt) || 0) - (Date.parse(a.suggestedAt) || 0);
  });
  return { suggestions: items, pendingCount: items.length, knowledgeHealth: await healthP };
}

// Pending rows in the re-verification queue (anti-staleness loop). These are
// verdicts the cron could not auto-apply (non-authoritative source, or a
// "changed" needing a human eye), waiting for an admin to apply or dismiss.
async function actionReverifyFeed() {
  var records = await loadAllRecords(gk.REVERIFICATION_TABLE,
    'filterByFormula=' + encodeURIComponent("{Status}='Pending'"), 1000);
  var items = records.map(function (rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      question: f['Question'] || '',
      verdict: valueOf(f['Verdict']) || '',
      currentAnswer: f['Current Answer'] || '',
      suggestedAnswer: f['Suggested Answer'] || '',
      evidence: f['Evidence'] || '',
      sourceUrl: f['Source URL'] || '',
      category: valueOf(f['Category']) || '',
      knowledgeRecordId: f['Knowledge Record ID'] || '',
      targetTable: valueOf(f['Target Table']) || 'Knowledge',
      targetField: f['Target Field'] || '',
      checkedAt: f['Checked At'] || rec.createdTime || null
    };
  }).sort(function (a, b) {
    return (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0);
  });
  return { reverifications: items, reverifyPendingCount: items.length };
}

// Apply a re-verification verdict to the live Knowledge record, mirroring the
// cron's trusted-source auto-apply (lib api/reverify) but human-triggered:
//   confirmed -> reset Last Verified (source still supports the answer).
//   changed   -> write the source-grounded Suggested Answer + rebuilt Search
//                Index + reset Last Verified.
//   unverifiable / source_unreachable -> nothing to apply; must be dismissed or
//                handled by hand (never guess a value).
async function actionReverifyApply(body) {
  var id = (body.id || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new Error('Invalid id');
  var row = await atFetch('/' + gk.REVERIFICATION_TABLE + '/' + id);
  var f = row.fields || {};
  if (valueOf(f['Status']) !== 'Pending') throw new Error('Already ' + (valueOf(f['Status']) || 'resolved').toLowerCase());
  var verdict = valueOf(f['Verdict']) || '';
  var knowledgeId = (f['Knowledge Record ID'] || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(knowledgeId)) throw new Error('No valid linked Knowledge record');
  var today = new Date().toISOString().split('T')[0];

  // Structured re-verification (Destinations/Transport): apply the source-grounded
  // suggestion to that table's field and reset its Last Verified. The record id is
  // in 'Knowledge Record ID'. We do not rebuild that table's Search Index here (a
  // single field correction stays findable by the row's other terms, and the
  // corrected value is what the widget surfaces).
  var targetTable = valueOf(f['Target Table']) || 'Knowledge';
  if (targetTable === 'Destinations' || targetTable === 'Transport') {
    var targetField = (f['Target Field'] || '').trim();
    var sVal = (f['Suggested Answer'] || '').trim();
    if (!targetField) throw new Error('No target field to apply');
    if (!sVal) throw new Error('No suggested value to apply');
    var tId = targetTable === 'Transport' ? gk.TRANSPORT_TABLE : gk.DESTINATIONS_TABLE;
    var pf = { 'Last Verified': today };
    pf[targetField] = sVal;
    await atFetch('/' + tId + '/' + knowledgeId, { method: 'PATCH', body: { fields: pf, typecast: true } });
    await atFetch('/' + gk.REVERIFICATION_TABLE + '/' + id, { method: 'PATCH', body: { fields: { 'Status': 'Applied' }, typecast: true } });
    return { ok: true, id: id, verdict: verdict, target: targetTable + '.' + targetField, recordId: knowledgeId };
  }

  if (verdict === 'confirmed') {
    await atFetch('/' + gk.KNOWLEDGE_TABLE + '/' + knowledgeId, {
      method: 'PATCH', body: { fields: { 'Last Verified': today }, typecast: true }
    });
  } else if (verdict === 'changed') {
    var suggested = (f['Suggested Answer'] || '').trim();
    if (!suggested) throw new Error('No suggested answer to apply');
    // Rebuild the Search Index from the live record so retrieval stays findable.
    var krec = await atFetch('/' + gk.KNOWLEDGE_TABLE + '/' + knowledgeId);
    var kf = krec.fields || {};
    await atFetch('/' + gk.KNOWLEDGE_TABLE + '/' + knowledgeId, {
      method: 'PATCH', body: { fields: {
        'Consumer Answer': suggested,
        'Search Index': gk.buildSearchIndex({
          question: kf['Question'] || f['Question'] || '',
          altPhrasings: kf['Alt Phrasings'] || '',
          consumerAnswer: suggested,
          agentAnswer: kf['Agent Answer'] || '',
          category: valueOf(kf['Category']) || valueOf(f['Category']) || '',
          relatedTo: kf['Related To'] || '',
          tags: kf['Tags'] || ''
        }),
        'Last Verified': today
      }, typecast: true }
    });
  } else {
    throw new Error('Verdict "' + (verdict || 'unknown') + '" has nothing to apply; dismiss it or handle by hand');
  }

  await atFetch('/' + gk.REVERIFICATION_TABLE + '/' + id, {
    method: 'PATCH', body: { fields: { 'Status': 'Applied' }, typecast: true }
  });
  return { ok: true, id: id, verdict: verdict, knowledgeId: knowledgeId };
}

async function actionReverifyDismiss(body) {
  var id = (body.id || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new Error('Invalid id');
  await atFetch('/' + gk.REVERIFICATION_TABLE + '/' + id, {
    method: 'PATCH', body: { fields: { 'Status': 'Dismissed' }, typecast: true }
  });
  return { ok: true, id: id };
}

// Trim a string field from the request body, or '' if absent/blank.
function s(v) { return (typeof v === 'string') ? v.trim() : ''; }

// Add a Destinations row by hand (admin). Builds the Search Index from the row's
// own fields so it is instantly findable, stamps Last Verified, and leaves Last
// Discovered blank so the discovery crawler picks it up FIRST (auto-populating
// its things-to-do + events on the next run). Only Name + Country are required.
async function actionAddDestination(body) {
  body = body || {};
  var name = s(body.name);
  var country = s(body.country) || name; // country-type rows: Country == Name
  if (!name) throw new Error('Name is required');

  var map = {
    'Name': name, 'Type': s(body.type) || 'Country', 'Country': country,
    'Parent': s(body.parent), 'Region': s(body.region), 'ISO Code': s(body.isoCode),
    'Currency': s(body.currency), 'Capital': s(body.capital), 'Languages': s(body.languages),
    'Time Zone': s(body.timeZone), 'Dialling Code': s(body.diallingCode),
    'Emergency Number': s(body.emergencyNumber), 'Driving Side': s(body.drivingSide),
    'Plug Type': s(body.plugType), 'Voltage': s(body.voltage),
    'UK Visa Required': s(body.ukVisaRequired), 'Tap Water Safe': s(body.tapWaterSafe),
    'Best Months to Visit': s(body.bestMonths), 'Main Airport': s(body.mainAirport),
    'Resort Type': s(body.resortType), 'Nearest Airport': s(body.nearestAirport),
    'Transfer Time': s(body.transferTime)
  };
  var fields = {};
  Object.keys(map).forEach(function (k) { if (map[k]) fields[k] = map[k]; });
  fields['Search Index'] = gk.buildDestinationSearchIndex(fields);
  fields['Last Verified'] = new Date().toISOString().split('T')[0];

  var created = await atFetch('/' + gk.DESTINATIONS_TABLE, {
    method: 'POST', body: { records: [{ fields: fields }], typecast: true }
  });
  return { ok: true, id: created.records[0].id, name: name, table: 'Destinations' };
}

// Add a Transport row by hand (airport / airline / cruise line or port). Builds
// the Search Index from its own fields and stamps Last Verified. Not crawled by
// the connectors, so the facts entered here are what Luna serves. Name + Type req.
async function actionAddTransport(body) {
  body = body || {};
  var name = s(body.name);
  var type = s(body.type);
  if (!name) throw new Error('Name is required');
  if (!type) throw new Error('Type is required (Airport, Airline, Cruise Line or Cruise Port)');

  var map = {
    'Name': name, 'Type': type, 'Code': s(body.code), 'Country': s(body.country),
    'City': s(body.city), 'Key Tips': s(body.keyTips),
    'Info 1': s(body.info1), 'Info 2': s(body.info2), 'Info 3': s(body.info3),
    'Info 4': s(body.info4), 'Info 5': s(body.info5), 'Info 6': s(body.info6)
  };
  var fields = {};
  Object.keys(map).forEach(function (k) { if (map[k]) fields[k] = map[k]; });
  fields['Search Index'] = gk.buildTransportSearchIndex(fields);
  fields['Last Verified'] = new Date().toISOString().split('T')[0];

  var created = await atFetch('/' + gk.TRANSPORT_TABLE, {
    method: 'POST', body: { records: [{ fields: fields }], typecast: true }
  });
  return { ok: true, id: created.records[0].id, name: name, table: 'Transport' };
}

async function actionApprove(body) {
  var id = (body.id || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new Error('Invalid id');

  var data = await atFetch('/' + gk.SUGGESTED_TABLE + '/' + id);
  var f = data.fields || {};
  if (valueOf(f[SF.status]) === 'Approved') throw new Error('Already approved');

  // Allow inline edits at approval time; fall back to the suggestion's values.
  var suggestion = {
    question: (body.question != null ? body.question : f[SF.question]) || '',
    consumerAnswer: (body.consumerAnswer != null ? body.consumerAnswer : f[SF.consumerAnswer]) || '',
    agentAnswer: f[SF.agentAnswer] || '',
    category: (body.category != null ? body.category : valueOf(f[SF.category])) || 'Other',
    relatedTo: f[SF.relatedTo] || '',
    source: f[SF.source] || '',
    confidence: valueOf(f[SF.confidence]) || 'Medium'
  };
  if (!suggestion.question || !suggestion.consumerAnswer) throw new Error('Question and answer are required');

  // Promote into the live Knowledge table (with Search Index built).
  var fields = gk.suggestionToKnowledgeFields(suggestion);
  var created = await atFetch('/' + gk.KNOWLEDGE_TABLE, {
    method: 'POST',
    body: { records: [{ fields: fields }], typecast: true }
  });
  var knowledgeId = created.records[0].id;

  // Mark the suggestion Approved and record where it landed.
  await atFetch('/' + gk.SUGGESTED_TABLE + '/' + id, {
    method: 'PATCH',
    body: { fields: { Status: 'Approved', 'Promoted Knowledge ID': knowledgeId }, typecast: true }
  });

  return { ok: true, knowledgeId: knowledgeId, suggestionId: id };
}

async function actionDismiss(body) {
  var id = (body.id || '').trim();
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) throw new Error('Invalid id');
  await atFetch('/' + gk.SUGGESTED_TABLE + '/' + id, {
    method: 'PATCH',
    body: { fields: { Status: 'Dismissed' }, typecast: true }
  });
  return { ok: true, suggestionId: id };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ADMIN_PASS) {
    console.error('[global-brain] ADMIN_PASSWORD not configured — refusing admin request');
    return res.status(503).json({ error: 'Admin access not configured' });
  }
  if (!safeCompare(req.headers['x-admin-pass'] || '', ADMIN_PASS)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Server not configured' });

  var action = (req.query.action || '').trim();
  try {
    if (req.method === 'GET' && (action === 'feed' || action === '')) {
      return res.status(200).json(await actionFeed());
    }
    if (req.method === 'GET' && action === 'reverify-feed') {
      return res.status(200).json(await actionReverifyFeed());
    }
    if (req.method === 'POST') {
      var body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'Invalid body' }); }
      if (action === 'approve') return res.status(200).json(await actionApprove(body));
      if (action === 'dismiss') return res.status(200).json(await actionDismiss(body));
      if (action === 'reverify-apply') return res.status(200).json(await actionReverifyApply(body));
      if (action === 'reverify-dismiss') return res.status(200).json(await actionReverifyDismiss(body));
      if (action === 'add-destination') return res.status(200).json(await actionAddDestination(body));
      if (action === 'add-transport') return res.status(200).json(await actionAddTransport(body));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[global-brain] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
