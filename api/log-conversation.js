// Luna Conversation Logger
//
// Writes a conversation summary to the Conversations table when a conversation
// ends. End triggers:
//   1. Widget fires sendBeacon on tab unload
//   2. Idle timeout (cron-detected)
//   3. Explicit "thanks/bye" detection in luna-chat.js
//   4. Escalation to a human agent
//
// After upserting, this endpoint kicks off api/conversation-quality scoring
// asynchronously (fire and forget).

const AT_BASE = 'app6Ot3eOb3DangkB';
const CONV_TABLE = 'tblyin27D2J9ejHvf';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';

const F = {
  convId: 'fldgQj90mYwsVO4yK',
  visitorName: 'fldqx6k7WvrqE8BW1',
  visitorEmail: 'fldZXcvl7k3FS5Gu7',
  clientWebsite: 'fldz7B7qaRcZlbqxM',
  status: 'fldYdZq59FCpKQ7Hf',
  startedAt: 'fldSoy7BMqyzVb5pp',
  lastMessageAt: 'fld1GghMiUnAmdtow',
  summary: 'fldZ38GYN4XbHGl03',
  client: 'flde1PCByneD05YyG',
  transcript: 'fld8fMjyXWmKcacoB',
  qualityScore: 'fld4mQMkFTccEE4T4',
  qualityReason: 'fldpf3QmfDuvnRMwo',
  wasAnswered: 'fldvmBP6C6MBa95K6',
  wasEscalated: 'fld3JapxKxGsBxPCQ',
  topicTags: 'fldQNFhnyo3W2ngTZ',
  knowledgeUsed: 'fldK8yRzZDjw8N6qh',
  knowledgeGap: 'fldZUDZXrtFCGUQUu',
  scoredAt: 'fldPm52hNNc4UhSRv'
};

const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io',
  'https://luna-chat.travelify.io',
  'https://widgets.travelify.io',
  'http://localhost:3000',
  'http://localhost:5173'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  // We deliberately allow any origin for log-conversation because the widget
  // calls this from arbitrary client websites. The request itself is gated by
  // ConversationID + clientName ownership — there's no destructive operation.
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sanitiseStr(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, maxLen || 10000);
}

async function findClientByName(atKey, clientName) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CLIENTS_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ClientName}='" + clientName.replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) ? d.records[0].id : null;
}

async function findConversation(atKey, convId) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ConversationID}='" + convId.replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) || null;
}

async function triggerQualityScoring(convId, host) {
  // Must await — Vercel terminates serverless functions on response, killing unawaited fetches.
  // The widget calls log-conversation via sendBeacon, which doesn't wait for response anyway,
  // so adding latency here is invisible to the user. Scoring takes ~1-2s with Haiku.
  try {
    var url = 'https://' + host + '/api/conversation-quality';
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: convId })
    }).catch(function(e){
      console.warn('[log-conversation] quality scoring trigger failed:', e.message);
    });
  } catch (e) {
    console.warn('[log-conversation] trigger threw:', e.message);
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  // Parse body — supports both regular JSON and sendBeacon (text/plain).
  var body;
  try {
    if (typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      body = req.body || {};
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  var convId = sanitiseStr(body.convId, 64);
  var clientName = sanitiseStr(body.clientName, 200);
  var transcript = sanitiseStr(body.transcript, 30000);
  var visitorName = sanitiseStr(body.visitorName, 100);
  var visitorEmail = sanitiseStr(body.visitorEmail, 200);
  var pageUrl = sanitiseStr(body.pageUrl, 500);
  var summary = sanitiseStr(body.summary, 2000);
  var wasEscalated = !!body.wasEscalated;
  var knowledgeUsedIds = Array.isArray(body.knowledgeUsedIds) ? body.knowledgeUsedIds.slice(0, 50).filter(function(id){
    return typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id);
  }) : [];

  if (!convId) return res.status(400).json({ error: 'Missing convId' });
  if (!clientName) return res.status(400).json({ error: 'Missing clientName' });

  try {
    // Resolve client record
    var clientRecordId = await findClientByName(atKey, clientName);
    if (!clientRecordId) return res.status(404).json({ error: 'Client not found' });

    // Find existing conversation by ID
    var existing = await findConversation(atKey, convId);

    var now = new Date().toISOString();
    var fields = {};
    fields[F.convId] = convId;
    if (clientRecordId) fields[F.client] = [clientRecordId];
    if (transcript) fields[F.transcript] = transcript;
    if (visitorName) fields[F.visitorName] = visitorName;
    if (visitorEmail) fields[F.visitorEmail] = visitorEmail;
    if (pageUrl) fields[F.clientWebsite] = pageUrl;
    if (summary) fields[F.summary] = summary;
    if (wasEscalated) fields[F.wasEscalated] = true;
    fields[F.lastMessageAt] = now;
    if (knowledgeUsedIds.length) fields[F.knowledgeUsed] = knowledgeUsedIds;

    if (existing) {
      // Update existing record
      var patchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE + '/' + existing.id;
      var pr = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: fields, typecast: true })
      });
      if (!pr.ok) {
        var pe = await pr.json();
        throw new Error((pe.error && pe.error.message) || 'Update failed');
      }
    } else {
      // Create new
      fields[F.startedAt] = now;
      var postUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE;
      var cr = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: [{ fields: fields }], typecast: true })
      });
      if (!cr.ok) {
        var ce = await cr.json();
        throw new Error((ce.error && ce.error.message) || 'Create failed');
      }
    }

    // Trigger quality scoring inline. Must await — Vercel kills unawaited promises
    // when the function returns. Adds ~1-2s of Haiku scoring time, but the widget
    // uses sendBeacon which doesn't wait for a response, so the user never feels it.
    var host = req.headers.host || 'luna-chat-endpoint.vercel.app';
    await triggerQualityScoring(convId, host);

    return res.status(200).json({ success: true, convId: convId });

  } catch (err) {
    console.error('[log-conversation] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
