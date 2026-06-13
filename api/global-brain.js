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

const gk = require('../lib/global-knowledge');

const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'travelgenix2026';

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

async function actionFeed() {
  var data = await atFetch('/' + gk.SUGGESTED_TABLE
    + '?filterByFormula=' + encodeURIComponent("{Status}='Pending'")
    + '&maxRecords=200');
  var items = (data.records || []).map(function (rec) {
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
  return { suggestions: items, pendingCount: items.length };
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

  if ((req.headers['x-admin-pass'] || '') !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Server not configured' });

  var action = (req.query.action || '').trim();
  try {
    if (req.method === 'GET' && (action === 'feed' || action === '')) {
      return res.status(200).json(await actionFeed());
    }
    if (req.method === 'POST') {
      var body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
      catch (e) { return res.status(400).json({ error: 'Invalid body' }); }
      if (action === 'approve') return res.status(200).json(await actionApprove(body));
      if (action === 'dismiss') return res.status(200).json(await actionDismiss(body));
    }
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[global-brain] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
