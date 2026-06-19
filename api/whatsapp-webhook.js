// Luna WhatsApp Webhook — inbound pipe (360dialog, Meta-native).
//
// A WhatsApp customer has no widget, so this endpoint does the widget's job
// server-side: receive the message, attribute it to the right Luna client, open
// or continue the conversation in Airtable, surface it LIVE in the agent inbox
// over the same Ably channels the web widget uses, let Luna answer (unless a
// human is handling it), and send Luna's reply back via 360dialog.
//
// Provider isolation: every 360dialog-specific detail lives in
// lib/whatsapp-provider.js. This file only deals in the normalised shapes that
// module returns, so a future cut-over to direct Meta touches the provider, not
// this orchestration.
//
//   GET  = webhook verification handshake (hub.challenge).
//   POST = inbound messages (?token= / x-webhook-token shared secret; fail-closed).
//
// Env: AIRTABLE_KEY, ABLY_ROOT_KEY, WHATSAPP_VERIFY_TOKEN, WHATSAPP_NUMBER_MAP
// (+ send keys), UPSTASH_REDIS_REST_* (optional: dedupe + AI memory),
// WHATSAPP_AI_AUTOREPLY (default on). ANTHROPIC_API_KEY via /api/luna-chat.

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');
const provider = require('../lib/whatsapp-provider');
const fmt = require('../lib/wa-format');
const convs = require('../lib/wa-conversations');
const store = require('../lib/wa-store');
const ably = require('../lib/ably-rest');
const wamsg = require('../lib/wa-messages');

const SESS_TTL = 60 * 60 * 26;   // AI memory window (~ WhatsApp 24h + slack)
const HIST_MAX = 20;             // recent turns fed back to Luna

function aiEnabled() { return String(process.env.WHATSAPP_AI_AUTOREPLY || 'true').toLowerCase() !== 'false'; }
function baseUrl(req) { return process.env.LUNA_BASE_URL || ('https://' + (req.headers.host || 'luna-chat-endpoint.vercel.app')); }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function dashboardChannel(clientId) { return 'luna-dashboard:' + clientId; }
function chatChannel(clientId, convId) { return 'luna-chat:' + clientId + ':' + convId; }

// Airtable Status (singleSelect: Bot|Waiting|Active|Closed) -> dashboard chip.
function mapHandlerToDash(h) {
  switch (h) {
    case 'Active': return 'human';
    case 'Waiting': return 'waiting';
    case 'Closed': return 'closed';
    default: return 'ai'; // Bot
  }
}

// Reuse the full web brain for the reply (knowledge, FCDO, escalation, etc.).
async function lunaReply(base, payload) {
  try {
    var res = await fetch(base + '/api/luna-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: payload.message,
        convId: payload.convId,
        clientName: payload.clientName,
        visitorName: payload.visitorName || '',
        history: payload.history || []
      }),
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) { console.warn('[whatsapp-webhook] luna-chat HTTP', res.status); return null; }
    return await res.json().catch(function () { return null; });
  } catch (e) {
    console.warn('[whatsapp-webhook] luna-chat error:', e.message);
    return null;
  }
}

// Publish a brand-new (or re-opened) conversation to the dashboard channel, with
// its first message(s) embedded — this is when the dashboard subscribes to the
// per-conversation channel, so later messages go there.
async function announce(clientId, convId, dashHandler, visitor, messages) {
  await ably.publish(dashboardChannel(clientId), {
    name: 'new_conversation',
    data: {
      convId: convId,
      visitor: visitor,
      handler: dashHandler,
      startedAt: new Date().toISOString(),
      channel: 'whatsapp',
      source: 'whatsapp',
      contact: { waId: visitor.phone, phoneNumberId: visitor.phoneNumberId },
      messages: messages || []
    }
  });
}

async function handleEvent(ctx, ev) {
  var base = ctx.base, atKey = ctx.atKey;

  // Only text-bearing messages flow into the inbox; media/etc. get a placeholder.
  var isText = typeof ev.text === 'string' && ev.text.length > 0;

  // Dedupe 360dialog/Meta at-least-once retries (only when Redis is available).
  if (ev.messageId && store.isConfigured()) {
    var first = await store.setIfAbsent('wa:dedup:' + ev.messageId, '1', 3600);
    if (!first) return;
  }

  var cfg = provider.getNumberConfig(ev.phoneNumberId);
  if (!cfg) { console.warn('[whatsapp-webhook] no client mapped for phone_number_id', ev.phoneNumberId); return; }

  // Validate the mapped client really exists (mirrors the brief's RECORD_ID check).
  var rec;
  try {
    var recs = await auth.fetchClients(atKey, "RECORD_ID()='" + auth.escFormula(cfg.clientId) + "'", 1);
    rec = recs && recs[0];
  } catch (e) { console.error('[whatsapp-webhook] client lookup error:', e.message); return; }
  if (!rec) { console.error('[whatsapp-webhook] mapped clientId not found:', cfg.clientId); return; }
  var clientId = rec.id;
  var clientName = (rec.fields && rec.fields.ClientName) || '';

  var convId = 'wa_' + digits(ev.phoneNumberId) + '_' + digits(ev.from);
  var displayName = ev.fromName || ('WhatsApp ' + ev.from);
  var text = isText ? ev.text : ('[' + (ev.type || 'unsupported') + ' message received on WhatsApp — open WhatsApp to view it]');

  // ── Upsert the Conversations row + decide the status ──
  // Status (Airtable singleSelect): Bot=Luna handling · Waiting=awaiting human ·
  // Active=human handling · Closed=ended. (Read from the live base schema.)
  var existing = await convs.getByConvId(atKey, convId);
  var reopen = existing && existing.handler === 'Closed';
  var newConvStatus = aiEnabled() ? 'Bot' : 'Waiting';
  var currentStatus, convRecordId, created = false, announced;

  if (!existing) {
    currentStatus = newConvStatus;
    var createdRec = await convs.createConversation(atKey, {
      convId: convId, clientId: clientId, visitorName: displayName,
      handler: currentStatus, historyLine: 'user: ' + text
    });
    convRecordId = createdRec && createdRec.id;
    created = true;
  } else if (reopen) {
    currentStatus = newConvStatus;
    convRecordId = existing.id;
    await convs.patchConversation(atKey, existing.id, {
      handler: currentStatus, visitorName: displayName,
      history: (existing.history || '') + '\nuser: ' + text
    });
  } else {
    currentStatus = existing.handler || 'Bot';
    convRecordId = existing.id;
    await convs.patchConversation(atKey, existing.id, {
      history: (existing.history || '') + '\nuser: ' + text
    });
  }
  announced = !(created || reopen); // already known to the inbox?

  // Per-message log (Messages table) — best-effort, never blocks the flow.
  await wamsg.logMessage(atKey, { convRecordId: convRecordId, sender: 'visitor', content: text, messageId: ev.messageId });

  var visitor = { name: displayName, page: 'WhatsApp', channel: 'whatsapp', phone: ev.from, phoneNumberId: ev.phoneNumberId };
  var ts = new Date().toISOString();
  var vMsg = { from: 'visitor', text: text, timestamp: ts, channel: 'whatsapp', messageId: ev.messageId };

  // ── Decide whether Luna answers ──
  var botShouldAnswer = isText && aiEnabled() && currentStatus === 'Bot';

  if (!botShouldAnswer) {
    // Human-handled, escalated, or non-text: just surface the message.
    if (!announced) await announce(clientId, convId, mapHandlerToDash(currentStatus), visitor, [vMsg]);
    else await ably.publish(chatChannel(clientId, convId), { name: 'message', data: vMsg });
    return;
  }

  // ── Luna answers ──
  var history = (await store.getJson('wa:hist:' + convId)) || [];
  var reply = await lunaReply(base, { message: text, convId: convId, clientName: clientName, visitorName: displayName, history: history });

  var replyText, escalate;
  if (reply && typeof reply.reply === 'string' && reply.reply.trim()) {
    replyText = fmt.toPlainText(reply.reply);
    escalate = !!reply.escalate;
  } else {
    replyText = 'Thanks for your message — I\'m just getting a colleague to help. We\'ll be right with you.';
    escalate = true;
  }
  if (!replyText.trim()) { replyText = 'Thanks for your message — one of our team will reply shortly.'; escalate = true; }

  var aiMsg = { from: 'ai', text: replyText, timestamp: new Date().toISOString(), channel: 'whatsapp' };

  // Send to the customer (the user-visible action); the rest is best-effort.
  var outId = '';
  try {
    var chunks = fmt.splitForWhatsApp(replyText);
    for (var i = 0; i < chunks.length; i++) {
      var sres = await provider.sendText(cfg, ev.from, chunks[i]);
      if (!outId && sres && sres.messages && sres.messages[0]) outId = sres.messages[0].id || '';
    }
  } catch (e) {
    console.error('[whatsapp-webhook] send failed:', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 300) : '');
  }

  // Log Luna's reply (Messages table) — best-effort.
  await wamsg.logMessage(atKey, { convRecordId: convRecordId, sender: 'bot', content: replyText, messageId: outId });

  // Realtime: announce the new conversation (visitor + AI embedded) OR push to chat channel.
  if (!announced) {
    await announce(clientId, convId, escalate ? 'waiting' : 'ai', visitor, [vMsg, aiMsg]);
  } else {
    await ably.publish(chatChannel(clientId, convId), [
      { name: 'message', data: vMsg },
      { name: 'message', data: aiMsg }
    ]);
    if (escalate) await ably.publish(chatChannel(clientId, convId), { name: 'handler_change', data: { handler: 'waiting' } });
  }

  // Persist the AI turn + (if escalating) flip status to Waiting so the bot steps back.
  var line = '\nluna: ' + replyText;
  var refreshed = await convs.getByConvId(atKey, convId);
  await convs.patchConversation(atKey, (refreshed && refreshed.id) || convRecordId, {
    handler: escalate ? 'Waiting' : undefined,
    history: ((refreshed && refreshed.history) || '') + line
  });

  // AI memory (best-effort).
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: replyText });
  if (history.length > HIST_MAX) history = history.slice(history.length - HIST_MAX);
  await store.setJson('wa:hist:' + convId, history, SESS_TTL);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  // ── GET: verification handshake ──
  if (req.method === 'GET') {
    var challenge = provider.verifyChallenge(req);
    if (challenge !== null) { res.setHeader('Content-Type', 'text/plain'); return res.status(200).send(challenge); }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret auth — FAIL CLOSED.
  if (!provider.verifyInbound(req)) return res.status(401).json({ error: 'Unauthorized' });

  // Rate limit the public endpoint (generous; dedupe handles retries).
  var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'wa-webhook', ipMax: 300, ipWindowSecs: 60 });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) { console.error('[whatsapp-webhook] Missing AIRTABLE_KEY'); return res.status(200).json({ ok: false }); }

  var events;
  try { events = provider.parseInbound(req.body || {}); }
  catch (e) { console.warn('[whatsapp-webhook] parse error:', e.message); return res.status(200).json({ ok: false }); }

  var ctx = { base: baseUrl(req), atKey: atKey };
  for (var i = 0; i < events.length; i++) {
    try { await handleEvent(ctx, events[i]); }
    catch (e) { console.error('[whatsapp-webhook] event error:', e.message); }
  }

  return res.status(200).json({ received: true });
};
