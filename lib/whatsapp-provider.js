// lib/whatsapp-provider.js
//
// THE PROVIDER SEAM. Everything that knows we are talking to 360dialog (rather
// than to Meta's Cloud API directly) lives in THIS file and nowhere else. The
// webhook and the send endpoint import only these functions. Because 360dialog
// is a thin, Meta-NATIVE proxy, migrating to direct Meta later is essentially:
//   • base URL   waba-v2.360dialog.io      -> graph.facebook.com/v{ver}
//   • auth       D360-API-KEY: <key>       -> Authorization: Bearer <token>
//   • path       /messages                 -> /{PHONE_NUMBER_ID}/messages
//   • inbound    ?token= / x-webhook-token -> X-Hub-Signature-256 (verifyMetaSignature, stubbed below)
// The request/response/webhook JSON shapes are already Meta-native, so they do
// not change. Keep that promise: do not leak 360dialog specifics elsewhere.
//
// Exports:
//   verifyChallenge(req)        GET webhook verification handshake (hub.challenge)
//   verifyInbound(req)          POST shared-secret check (?token= or x-webhook-token), constant-time, FAIL-CLOSED
//   parseInbound(body)          Meta-native envelope -> [{ phoneNumberId, from, fromName, text, messageId, timestamp, type }]
//   sendText(cfg, to, text)     send a text via 360dialog (Meta-native body)
//   verifyMetaSignature(...)    STUB for the future direct-Meta cutover (HMAC over raw body)
//   getNumberConfig(phoneNumberId) / getConfigByClientId(clientId)   routing/config
//
// Env:
//   WHATSAPP_VERIFY_TOKEN   shared secret; used both for the GET handshake and the POST ?token=
//   WHATSAPP_NUMBER_MAP     JSON mapping phone_number_id -> client. Value may be either
//                             "recXXXXXXXXXXXXXX"                         (Phase-1 stopgap: client record id)
//                           or { "clientId":"recXXX", "apiKey":"D360..." } (adds the send key)
//   WHATSAPP_D360_KEYS      optional JSON { phone_number_id: d360_api_key } (alternative place for send keys)
//   WHATSAPP_D360_API_KEY   optional single global send key (single-number setups)
//   WHATSAPP_API_BASE       optional override (default https://waba-v2.360dialog.io)
//   META_APP_SECRET         only used by the (future) verifyMetaSignature path

const crypto = require('crypto');

const API_BASE = (process.env.WHATSAPP_API_BASE || 'https://waba-v2.360dialog.io').replace(/\/+$/, '');

// ── Configuration / routing ─────────────────────────────────────────────────
function parseJsonEnv(name) {
  var raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { console.warn('[whatsapp-provider] ' + name + ' is not valid JSON:', e.message); return null; }
}

// Normalise WHATSAPP_NUMBER_MAP into { phoneNumberId, clientId, apiKey }.
function getNumberConfig(phoneNumberId) {
  if (!phoneNumberId) return null;
  var id = String(phoneNumberId);
  var map = parseJsonEnv('WHATSAPP_NUMBER_MAP') || {};
  var entry = map[id];
  if (!entry) return null;

  var clientId, apiKey;
  if (typeof entry === 'string') { clientId = entry; }            // Phase-1 form: id -> recId
  else if (entry && typeof entry === 'object') { clientId = entry.clientId || entry.recId; apiKey = entry.apiKey; }

  if (!apiKey) {
    var keys = parseJsonEnv('WHATSAPP_D360_KEYS') || {};
    apiKey = keys[id] || process.env.WHATSAPP_D360_API_KEY || process.env.D360_API_KEY || '';
  }
  if (!clientId) return null;
  return { phoneNumberId: id, clientId: String(clientId), apiKey: String(apiKey || '') };
}

// Reverse lookup for the agent-send path: which number do we reply FROM for a client.
function getConfigByClientId(clientId) {
  if (!clientId) return null;
  var map = parseJsonEnv('WHATSAPP_NUMBER_MAP') || {};
  var ids = Object.keys(map);
  for (var i = 0; i < ids.length; i++) {
    var cfg = getNumberConfig(ids[i]);
    if (cfg && cfg.clientId === String(clientId)) return cfg;
  }
  return null;
}

// ── Inbound auth ─────────────────────────────────────────────────────────────
function safeEqual(a, b) {
  var ba = Buffer.from(String(a || ''));
  var bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

// GET handshake: Meta/360dialog style `hub.mode=subscribe&hub.verify_token=..&hub.challenge=..`.
// Returns the challenge string to echo, or null to reject (403).
function verifyChallenge(req) {
  var q = req.query || {};
  var token = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!token) return null; // fail closed if unconfigured
  if (q['hub.mode'] === 'subscribe' && safeEqual(q['hub.verify_token'], token)) {
    return typeof q['hub.challenge'] === 'undefined' ? '' : String(q['hub.challenge']);
  }
  return null;
}

// POST shared-secret check. 360dialog appends ?token=<secret> to the webhook URL
// we register; we also accept an x-webhook-token header. FAIL-CLOSED if the
// secret is not configured server-side.
function verifyInbound(req) {
  var expected = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!expected) { console.error('[whatsapp-provider] WHATSAPP_VERIFY_TOKEN not set; rejecting inbound'); return false; }
  var got = (req.query && req.query.token) || req.headers['x-webhook-token'] || req.headers['x-webhook-token'.toLowerCase()] || '';
  return safeEqual(got, expected);
}

// STUB — wire this when cutting over to DIRECT Meta (360dialog does not send
// X-Hub-Signature-256; Meta does). Verifies an HMAC-SHA256 over the RAW body
// using META_APP_SECRET. Left unused today on purpose.
function verifyMetaSignature(rawBody, signatureHeader) {
  var secret = process.env.META_APP_SECRET || '';
  if (!secret) return { ok: true, skipped: true };
  if (!signatureHeader || rawBody == null) return { ok: false };
  var expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  return { ok: safeEqual(signatureHeader, expected) };
}

// ── Inbound parsing (Meta-native envelope) ───────────────────────────────────
function extractText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'text' && msg.text) return msg.text.body || '';
  if (msg.type === 'button' && msg.button) return msg.button.text || '';
  if (msg.type === 'interactive' && msg.interactive) {
    var it = msg.interactive;
    if (it.button_reply) return it.button_reply.title || it.button_reply.id || '';
    if (it.list_reply) return it.list_reply.title || it.list_reply.id || '';
  }
  return null; // media/location/etc. — caller decides how to surface
}

// Returns a normalised list of inbound message events. Status callbacks
// (delivered/read) and anything without a message are ignored.
function parseInbound(body) {
  var out = [];
  if (!body || typeof body !== 'object') return out;
  var entries = Array.isArray(body.entry) ? body.entry : [];
  for (var ei = 0; ei < entries.length; ei++) {
    var changes = (entries[ei] && entries[ei].changes) || [];
    for (var ci = 0; ci < changes.length; ci++) {
      var change = changes[ci] || {};
      if (change.field && change.field !== 'messages') continue;
      var value = change.value || {};
      var meta = value.metadata || {};
      var phoneNumberId = meta.phone_number_id || meta.phoneNumberId || '';
      var contacts = value.contacts || [];
      var nameByWa = {};
      contacts.forEach(function (c) { if (c && c.wa_id) nameByWa[c.wa_id] = (c.profile && c.profile.name) || ''; });
      var messages = value.messages || [];
      for (var mi = 0; mi < messages.length; mi++) {
        var m = messages[mi] || {};
        out.push({
          phoneNumberId: String(phoneNumberId),
          from: String(m.from || ''),
          fromName: nameByWa[m.from] || '',
          text: extractText(m),
          messageId: m.id || '',
          timestamp: m.timestamp || '',
          type: m.type || 'unknown'
        });
      }
    }
  }
  return out;
}

// ── Outbound send (360dialog; Meta-native body, no phone_number_id in path) ──
async function sendText(cfg, to, text) {
  if (!cfg || !cfg.apiKey) throw new Error('WhatsApp send: missing D360-API-KEY for this number');
  var url = API_BASE + '/messages';
  var body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'text',
    text: { preview_url: true, body: String(text).slice(0, 4096) }
  };
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'D360-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || (data && data.meta && data.meta.developer_message) || ('HTTP ' + res.status);
    var err = new Error('WhatsApp send failed: ' + msg);
    err.status = res.status; err.detail = data;
    throw err;
  }
  return data; // Meta-native: { messages: [{ id }], ... }
}

module.exports = {
  API_BASE: API_BASE,
  getNumberConfig: getNumberConfig,
  getConfigByClientId: getConfigByClientId,
  verifyChallenge: verifyChallenge,
  verifyInbound: verifyInbound,
  verifyMetaSignature: verifyMetaSignature,
  parseInbound: parseInbound,
  sendText: sendText,
  safeEqual: safeEqual
};
