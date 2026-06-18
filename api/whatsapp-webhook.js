// Luna WhatsApp Webhook — Meta WhatsApp Cloud API → Luna inbox.
//
// This is the server-side equivalent of the web widget for WhatsApp. A WhatsApp
// customer has no widget and no Ably SDK, so THIS endpoint does everything the
// widget does, server-side:
//   • receives the customer's message from Meta,
//   • resolves which Luna client owns the business number,
//   • opens / continues a conversation (conv_… id, same format as the widget),
//   • lets Luna answer (by calling our own /api/luna-chat) unless a human has
//     taken over or auto-reply is disabled,
//   • sends Luna's reply back to the customer via the Cloud API,
//   • publishes the same Ably events the widget publishes
//     (new_conversation on luna-dashboard:{clientId}; message / handler_change
//      on luna-chat:{clientId}:{convId}) so the conversation shows up LIVE in
//     the agent dashboard inbox, tagged as a WhatsApp channel,
//   • persists the transcript to Airtable via /api/conversation (same as web).
//
// GET  = Meta webhook verification handshake (hub.challenge).
// POST = inbound messages + status callbacks.
//
// Routing/secrets live in lib/whatsapp.js (env-driven, multi-tenant ready).
// Hot session/routing state lives in Upstash via lib/wa-store.js. See
// WHATSAPP-SETUP.md for the Meta provisioning + env vars.
//
// Env: AIRTABLE_KEY, ABLY_ROOT_KEY, UPSTASH_REDIS_REST_*, plus the WhatsApp /
// META_* vars documented in lib/whatsapp.js. ANTHROPIC_API_KEY is used
// indirectly via /api/luna-chat.

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');
const wa = require('../lib/whatsapp');
const store = require('../lib/wa-store');
const ably = require('../lib/ably-rest');

const SESS_TTL = 60 * 60 * 26;       // 26h — covers the WhatsApp 24h service window + slack
const STATE_TTL = 60 * 60 * 24 * 30; // 30d — conversation routing/state
const HIST_MAX = 20;                 // recent turns fed back to Luna

function baseUrl(req) {
  return process.env.LUNA_BASE_URL || ('https://' + (req.headers.host || 'luna-chat-endpoint.vercel.app'));
}

function nowIso() { return new Date().toISOString(); }

function dashboardChannel(clientId) { return 'luna-dashboard:' + clientId; }
function chatChannel(clientId, convId) { return 'luna-chat:' + clientId + ':' + convId; }

// Read the raw request body so we can verify Meta's HMAC signature against the
// exact bytes. bodyParser is disabled (see config export) so req.body is empty
// and we consume the stream ourselves. { exact:false } means the original bytes
// were unavailable (bodyParser ran anyway) and signature enforcement is skipped.
function readRawBody(req) {
  if (typeof req.body === 'string') return Promise.resolve({ raw: req.body, exact: true });
  if (Buffer.isBuffer(req.body)) return Promise.resolve({ raw: req.body, exact: true });
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
    return Promise.resolve({ raw: JSON.stringify(req.body), exact: false });
  }
  return new Promise(function (resolve) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve({ raw: Buffer.concat(chunks), exact: true }); });
    req.on('error', function () { resolve({ raw: '', exact: false }); });
  });
}

// Pull readable text out of the supported inbound message shapes.
function extractText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'text' && msg.text) return msg.text.body || '';
  if (msg.type === 'button' && msg.button) return msg.button.text || '';
  if (msg.type === 'interactive' && msg.interactive) {
    var it = msg.interactive;
    if (it.button_reply) return it.button_reply.title || it.button_reply.id || '';
    if (it.list_reply) return it.list_reply.title || it.list_reply.id || '';
  }
  return null; // media / location / reactions etc. — unsupported for now
}

// Call our own Luna brain to generate a reply (full reuse of the web logic:
// knowledge, FCDO, escalation detection, etc.). Returns the JSON or null.
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
    if (!res.ok) {
      console.warn('[whatsapp-webhook] luna-chat HTTP', res.status);
      return null;
    }
    return await res.json().catch(function () { return null; });
  } catch (e) {
    console.warn('[whatsapp-webhook] luna-chat error:', e.message);
    return null;
  }
}

// Append to the running transcript (Upstash) and upsert it to Airtable through
// the same server proxy the widget uses, so WhatsApp chats get the same durable
// record + quality scoring as web chats.
async function recordTurn(base, clientName, convId, lines, handler, visitorName) {
  var key = 'wa:script:' + convId;
  var prev = (await store.getStr(key)) || '[Channel: WhatsApp]';
  var next = prev + '\n' + lines.join('\n');
  if (next.length > 45000) next = next.slice(next.length - 45000);
  await store.setStr(key, next, STATE_TTL);
  try {
    var body = { convId: convId, clientName: clientName, handler: handler, history: next };
    if (visitorName) body.visitorName = visitorName;
    await fetch(base + '/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) { /* durable record is best-effort here; never blocks the reply */ }
}

// Handle ONE inbound customer message end-to-end.
async function processInbound(ctx) {
  var base = ctx.base, atKey = ctx.atKey, cfg = ctx.cfg, clientId = ctx.clientId;
  var msg = ctx.msg, profileName = ctx.profileName;

  // Dedupe Meta's at-least-once retries (set the flag FIRST so a retry arriving
  // mid-processing can't trigger a second send).
  if (msg.id) {
    var first = await store.setIfAbsent('wa:dedup:' + msg.id, '1', 3600);
    if (!first && store.isConfigured()) return; // already handled
  }

  var waId = String(msg.from || '');
  if (!waId) return;
  var text = extractText(msg);

  // Best-effort read receipt.
  wa.markRead(cfg, msg.id).catch(function () {});

  // Resolve / continue the conversation.
  var sessKey = 'wa:sess:' + cfg.phoneNumberId + ':' + waId;
  var convId = await store.getStr(sessKey);
  var state = convId ? await store.getJson('wa:conv:' + convId) : null;
  if (convId && !state) { convId = null; } // lost state -> start fresh so the dashboard re-announces
  if (!convId) {
    convId = wa.newConvId();
    state = {
      waId: waId,
      phoneNumberId: cfg.phoneNumberId,
      clientId: clientId,
      clientName: cfg.clientName,
      name: profileName || '',
      handler: 'bot',
      announced: false,
      startedAt: nowIso()
    };
  }
  if (profileName && !state.name) state.name = profileName;
  await store.setStr(sessKey, convId, SESS_TTL);

  var displayName = state.name || ('WhatsApp ' + waId);

  // Unsupported message kind: keep the human in the loop with a clear note.
  if (text === null || text === '') {
    var note = '[' + (msg.type || 'unsupported') + ' message received on WhatsApp — open WhatsApp to view it]';
    var vNote = { from: 'visitor', text: note, lang: 'English', timestamp: nowIso(), channel: 'whatsapp' };
    await announceOrMessage(state, clientId, convId, [vNote], 'waiting', {
      name: displayName, waId: waId, phoneNumberId: cfg.phoneNumberId, startedAt: state.startedAt
    });
    state.handler = (state.handler === 'human') ? 'human' : 'waiting';
    await store.setJson('wa:conv:' + convId, state, STATE_TTL);
    await recordTurn(base, cfg.clientName, convId, ['Visitor: ' + note], state.handler === 'human' ? 'Agent' : 'Waiting', displayName);
    return;
  }

  var botShouldAnswer = wa.autoReplyEnabled() && state.handler !== 'human' && state.handler !== 'waiting';
  var ts = nowIso();
  var vMsg = { from: 'visitor', text: text, lang: 'English', timestamp: ts, channel: 'whatsapp' };

  if (!botShouldAnswer) {
    // A human owns this conversation (or auto-reply is off): just surface the
    // customer's message in the inbox; the agent replies via the dashboard.
    var humanHandler = (state.handler === 'human') ? 'human' : 'waiting';
    await announceOrMessage(state, clientId, convId, [vMsg], humanHandler, {
      name: displayName, waId: waId, phoneNumberId: cfg.phoneNumberId, startedAt: state.startedAt
    });
    await store.setJson('wa:conv:' + convId, state, STATE_TTL);
    await recordTurn(base, cfg.clientName, convId, ['Visitor: ' + text], humanHandler === 'human' ? 'Agent' : 'Waiting', displayName);
    return;
  }

  // ── Luna answers ──
  var history = (await store.getJson('wa:hist:' + convId)) || [];
  var reply = await lunaReply(base, {
    message: text, convId: convId, clientName: cfg.clientName, visitorName: displayName, history: history
  });

  var replyText, escalate, lang;
  if (reply && typeof reply.reply === 'string' && reply.reply.trim()) {
    replyText = wa.toPlainText(reply.reply);
    escalate = !!reply.escalate;
    lang = reply.detectedLanguage || 'English';
  } else {
    replyText = 'Thanks for your message — I\'m just getting a colleague to help. We\'ll be right with you.';
    escalate = true;
    lang = 'English';
  }
  if (!replyText.trim()) {
    replyText = 'Thanks for your message — one of our team will reply shortly.';
    escalate = true;
  }
  vMsg.lang = lang;
  var aiMsg = { from: 'ai', text: replyText, lang: lang, timestamp: nowIso() };

  // Send to the customer first (the user-visible action); realtime + persistence
  // follow and are best-effort.
  try {
    await wa.sendChunks(cfg, waId, replyText);
  } catch (e) {
    console.error('[whatsapp-webhook] send failed:', e.message, e.detail ? JSON.stringify(e.detail).slice(0, 300) : '');
  }

  var newHandler = escalate ? 'waiting' : 'ai';
  await announceOrMessage(state, clientId, convId, [vMsg, aiMsg], newHandler, {
    name: displayName, waId: waId, phoneNumberId: cfg.phoneNumberId, startedAt: state.startedAt
  });
  // If the dashboard already knew this conversation, flip its handler chip too.
  if (escalate && state.announced) {
    await ably.publish(chatChannel(clientId, convId), { name: 'handler_change', data: { handler: 'waiting' } });
  }

  state.handler = newHandler;
  await store.setJson('wa:conv:' + convId, state, STATE_TTL);

  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: replyText });
  if (history.length > HIST_MAX) history = history.slice(history.length - HIST_MAX);
  await store.setJson('wa:hist:' + convId, history, SESS_TTL);

  await recordTurn(base, cfg.clientName, convId, ['Visitor: ' + text, 'Luna: ' + replyText], escalate ? 'Waiting' : 'AI', displayName);
}

// Publish to the dashboard the same way the widget does: a brand-new
// conversation is announced (with its first messages embedded) on the dashboard
// channel — which is when the dashboard subscribes to the per-conversation
// channel — and every later message goes on the per-conversation channel.
async function announceOrMessage(state, clientId, convId, messages, handler, visitorMeta) {
  if (!state.announced) {
    await ably.publish(dashboardChannel(clientId), {
      name: 'new_conversation',
      data: {
        convId: convId,
        visitor: {
          name: visitorMeta.name,
          page: 'WhatsApp',
          phone: visitorMeta.waId,
          channel: 'whatsapp'
        },
        handler: handler,
        startedAt: visitorMeta.startedAt,
        source: 'whatsapp',
        contact: { waId: visitorMeta.waId, phoneNumberId: visitorMeta.phoneNumberId },
        messages: messages
      }
    });
    state.announced = true;
  } else {
    var items = messages.map(function (m) { return { name: 'message', data: m }; });
    await ably.publish(chatChannel(clientId, convId), items);
  }
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  // ── GET: Meta verification handshake ──
  if (req.method === 'GET') {
    var q = req.query || {};
    var mode = q['hub.mode'];
    var token = q['hub.verify_token'];
    var challenge = q['hub.challenge'];
    if (mode === 'subscribe' && wa.verifyTokenMatches(token)) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(typeof challenge === 'undefined' ? '' : String(challenge));
    }
    return res.status(403).json({ error: 'Verification failed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Generous IP limit — Meta fans out across many source IPs, and we already
  // dedupe by message id. This only stops pathological floods.
  var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'whatsapp-webhook', ipMax: 1200, ipWindowSecs: 60 });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    console.error('[whatsapp-webhook] Missing AIRTABLE_KEY');
    // Still 200 so Meta doesn't retry-storm a config error we must fix our side.
    return res.status(200).json({ ok: false });
  }

  // Read raw body + verify signature.
  var bodyInfo = await readRawBody(req);
  var sig = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature-256'.toLowerCase()];
  if (wa.appSecret()) {
    if (bodyInfo.exact) {
      var v = wa.verifySignature(bodyInfo.raw, sig);
      if (!v.ok) {
        console.warn('[whatsapp-webhook] signature verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else {
      console.warn('[whatsapp-webhook] raw body unavailable; skipping signature check');
    }
  }

  var body;
  try {
    var rawStr = Buffer.isBuffer(bodyInfo.raw) ? bodyInfo.raw.toString('utf8') : String(bodyInfo.raw || '');
    body = rawStr ? JSON.parse(rawStr) : (req.body || {});
  } catch (e) {
    console.warn('[whatsapp-webhook] bad JSON body');
    return res.status(200).json({ ok: false });
  }

  if (!body || body.object !== 'whatsapp_business_account') {
    return res.status(200).json({ ignored: true });
  }

  var base = baseUrl(req);
  var entries = Array.isArray(body.entry) ? body.entry : [];

  for (var ei = 0; ei < entries.length; ei++) {
    var changes = (entries[ei] && entries[ei].changes) || [];
    for (var ci = 0; ci < changes.length; ci++) {
      var change = changes[ci] || {};
      if (change.field !== 'messages') continue;
      var value = change.value || {};
      var metadata = value.metadata || {};

      var cfg = wa.configByPhoneNumberId(metadata.phone_number_id);
      if (!cfg) {
        console.warn('[whatsapp-webhook] no client configured for phone_number_id', metadata.phone_number_id);
        continue;
      }

      var messages = value.messages || [];
      if (!messages.length) continue; // statuses (delivered/read) etc. — nothing to surface

      var rec;
      try {
        rec = await auth.resolveClientByName(atKey, cfg.clientName);
      } catch (e) {
        console.error('[whatsapp-webhook] client resolve error:', e.message);
        continue;
      }
      if (!rec) {
        console.error('[whatsapp-webhook] unknown Luna client for WhatsApp number:', cfg.clientName);
        continue;
      }
      var clientId = rec.id;

      var contacts = value.contacts || [];
      var nameByWa = {};
      contacts.forEach(function (c) { if (c && c.wa_id) nameByWa[c.wa_id] = c.profile && c.profile.name; });

      for (var mi = 0; mi < messages.length; mi++) {
        try {
          await processInbound({
            base: base,
            atKey: atKey,
            cfg: cfg,
            clientId: clientId,
            msg: messages[mi],
            profileName: nameByWa[messages[mi].from]
          });
        } catch (e) {
          console.error('[whatsapp-webhook] processInbound error:', e.message);
        }
      }
    }
  }

  return res.status(200).json({ received: true });
}

module.exports = handler;
// Disable Vercel's body parser so we can verify Meta's HMAC over the raw bytes.
module.exports.config = { api: { bodyParser: false } };
