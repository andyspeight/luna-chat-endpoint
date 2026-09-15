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

// Widgets identify themselves by clientName. A renamed client must keep
// resolving under the name already embedded on their site. Shared helper.
const { clientNameFormula } = require('../lib/luna-auth');

const ratelimit = require('../lib/ratelimit');
const chatNotify = require('../lib/chat-notify');
// Where this client's alerts go — their own NotificationEmail if they have set
// one in Settings, otherwise ContactEmail, exactly as before.
const notifyTo = require('../lib/notify-recipient');

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
  'https://lunachat.travelify.io',
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
  // Strip C0/C1 control chars EXCEPT tab (9), LF (10), and CR (13).
  // The transcript needs newlines for downstream regex matching.
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maxLen || 10000);
}

async function findClientByName(atKey, clientName) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CLIENTS_TABLE
    + '?filterByFormula=' + encodeURIComponent(clientNameFormula(clientName))
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  // The whole record, not just the id: the notification below needs the
  // client's ContactEmail, and this is the lookup that already has it.
  return (d.records && d.records[0]) || null;
}

async function findConversation(atKey, convId) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ConversationID}='" + convId.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) || null;
}

// Email the client's notification address. Degrades to a silent no-op whenever
// it cannot send — no recipient, no SendGrid key, no SendGrid module — because
// a missing notification must never cost anyone their conversation record.
async function sendChatNotification(o) {
  var f = (o.clientRecord && o.clientRecord.fields) || {};
  var to = notifyTo.recipients(f);
  if (!to.length) {
    console.log('[log-conversation] no notification address for ' + o.clientName + ' — not notifying');
    return;
  }
  var key = process.env.SENDGRID_API_KEY;
  var from = process.env.LEAD_NOTIFY_FROM || process.env.REVIEW_DIGEST_FROM || 'noreply@travelgenix.io';
  if (!key) return;
  var sgMail;
  try { sgMail = require('@sendgrid/mail'); } catch (e) { return; }
  sgMail.setApiKey(key);

  var mail = chatNotify.buildChatEmail({
    clientName: o.clientName,
    visitorName: o.visitorName,
    visitorEmail: o.visitorEmail,
    summary: o.summary,
    page: o.page,
    at: o.at,
    urgent: o.urgent,
    dashboardUrl: (f.DashboardURL || 'https://chat.travelify.io/dashboard.html')
  });
  await sgMail.send({ to: to, from: from, subject: mail.subject, html: mail.html });
  console.log('[log-conversation] notified ' + to.join(', ') + (o.urgent ? ' (handover requested)' : ' (new chat)'));
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

  // Rate limit — this endpoint is unauthenticated and fans out to ~5 Airtable
  // ops + an Anthropic quality-scoring call, so without a limit one client can
  // saturate the shared Airtable base (~5 req/s) and take down every tenant.
  // Called from the visitor's browser (real per-visitor IP), so IP keying works.
  try {
    var rl = await ratelimit.checkIpAndKey(req, {
      ipKey: 'log-conv', ipMax: 30, ipWindowSecs: 60,
      keyKey: 'log-conv:conv:' + convId, keyMax: 10, keyWindowSecs: 60
    });
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });
  } catch (e) { /* limiter unavailable — fail open (non-money endpoint) */ }

  try {
    // Resolve client record
    var clientRecord = await findClientByName(atKey, clientName);
    var clientRecordId = clientRecord ? clientRecord.id : null;
    if (!clientRecordId) return res.status(404).json({ error: 'Client not found' });

    // Find existing conversation by ID
    var existing = await findConversation(atKey, convId);

    // SECURITY: a conversation is located by ConversationID alone, and convIds
    // travel in Ably channel names. Do NOT reassign the Client link from request
    // input — that let anyone who knew a convId move another tenant's
    // conversation into their own client and overwrite its transcript/email.
    // If the row already belongs to a different client, refuse.
    var existingClient = (existing && existing.fields && existing.fields.Client) || [];
    if (Array.isArray(existingClient) && existingClient.length) {
      var ownerId = (typeof existingClient[0] === 'object' && existingClient[0]) ? existingClient[0].id : existingClient[0];
      if (ownerId !== clientRecordId) {
        return res.status(403).json({ error: 'Conversation belongs to another client' });
      }
    }

    var now = new Date().toISOString();
    var fields = {};
    fields[F.convId] = convId;
    // Only set the owner when the row does not already have one (create, or an
    // adoptable legacy row) — never reassign an owned row.
    if (!existingClient.length) fields[F.client] = [clientRecordId];
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

    // Tell the client someone chatted. AFTER the write, so a mail failure can
    // never cost us the conversation record, and awaited because Vercel kills
    // unawaited promises when the function returns.
    try {
      var decision = chatNotify.decideNotification({
        isNew: !existing,
        hasVisitorMessage: chatNotify.hasVisitorMessage(fields[F.summary] || (existing && existing.fields && existing.fields[F.summary])),
        escalated: !!fields[F.wasEscalated],
        wasEscalated: !!(existing && existing.fields && existing.fields[F.wasEscalated])
      });
      if (decision.notify) {
        await sendChatNotification({
          clientRecord: clientRecord,
          clientName: clientName,
          urgent: decision.urgent,
          visitorName: fields[F.visitorName] || (existing && existing.fields && existing.fields[F.visitorName]),
          visitorEmail: fields[F.visitorEmail] || (existing && existing.fields && existing.fields[F.visitorEmail]),
          summary: fields[F.summary] || (existing && existing.fields && existing.fields[F.summary]),
          page: fields[F.clientWebsite] || (existing && existing.fields && existing.fields[F.clientWebsite]),
          convId: convId,
          at: now
        });
      }
    } catch (notifyErr) {
      console.warn('[log-conversation] notify failed (non-fatal):', notifyErr && notifyErr.message);
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
