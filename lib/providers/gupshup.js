// lib/providers/gupshup.js
// Gupshup WhatsApp provider — the cheapest way to stand up a demo: no fixed
// platform fee and no per-number licence (pay-as-you-go wallet, ~$0.001/msg on
// top of Meta). Uses Gupshup's standard self-serve App API.
//
// NOTE — this is a PROPRIETARY API (not Meta-native): inbound is Gupshup's own
// JSON keyed by APP NAME (no Meta phone_number_id), and send is form-encoded.
// We normalise both onto the app's internal contract so the webhook/send code
// is unchanged: the business number's digits act as the routing key /
// `wa_<biz>_<customer>` convId, exactly like the Meta path. A later move to
// direct Meta is therefore still contained to the provider layer (though it's
// more work here than from 360dialog — Gupshup's optional Meta-format "v3
// passthrough" would shrink that gap when we build the multi-tenant Phase 3).
//
// Config (env WHATSAPP_NUMBER_MAP), keyed by Gupshup APP NAME:
//   { "MyGupshupApp": { "clientId": "recXXXXXXXXXXXXXX", "phone": "447700900000", "apiKey": "sk_..." } }
// `apiKey` may be omitted per-entry and supplied globally via GUPSHUP_API_KEY
// (Gupshup's apikey is account-level; the app name + source number select the tenant).

const shared = require('./_shared');

const API_BASE = (process.env.GUPSHUP_API_BASE || 'https://api.gupshup.io/wa/api/v1').replace(/\/+$/, '');

function digits(s) { return String(s || '').replace(/\D/g, ''); }

// Flatten WHATSAPP_NUMBER_MAP into [{ appName, phoneDigits, clientId, apiKey }].
function buildEntries() {
  var map = shared.parseJsonEnv('WHATSAPP_NUMBER_MAP') || {};
  var globalKey = process.env.GUPSHUP_API_KEY || process.env.GUPSHUP_APP_TOKEN || '';
  var out = [];
  Object.keys(map).forEach(function (appName) {
    var entry = map[appName];
    var clientId, phone, apiKey;
    if (typeof entry === 'string') { clientId = entry; }
    else if (entry && typeof entry === 'object') { clientId = entry.clientId || entry.recId; phone = entry.phone || entry.source; apiKey = entry.apiKey; }
    if (!clientId) return;
    out.push({
      appName: String(appName),
      phoneDigits: digits(phone),
      clientId: String(clientId),
      apiKey: String(apiKey || globalKey || '')
    });
  });
  return out;
}

function toConfig(e) {
  if (!e) return null;
  return { phoneNumberId: e.phoneDigits, clientId: e.clientId, apiKey: e.apiKey, appName: e.appName, sourcePhone: e.phoneDigits };
}

// Routing key is the business number's digits (so convId == wa_<biz>_<customer>).
function getNumberConfig(phoneNumberId) {
  if (!phoneNumberId) return null;
  var want = digits(phoneNumberId);
  var es = buildEntries();
  for (var i = 0; i < es.length; i++) { if (es[i].phoneDigits === want) return toConfig(es[i]); }
  return null;
}

function getConfigByClientId(clientId) {
  if (!clientId) return null;
  var es = buildEntries();
  for (var i = 0; i < es.length; i++) { if (es[i].clientId === String(clientId)) return toConfig(es[i]); }
  return null;
}

// Gupshup doesn't sign payloads (no Meta HMAC); inbound is protected by the
// shared ?token= secret on the callback URL. Stub kept for interface parity.
function verifyMetaSignature() { return { ok: true, skipped: true }; }

function extractText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  var c = msg.payload || {}; // Gupshup nests content under payload.payload
  switch (msg.type) {
    case 'text': return c.text || '';
    case 'button_reply': return c.title || c.id || '';
    case 'list_reply': return c.title || c.id || '';
    case 'quick_reply': return c.text || c.title || '';
    default: return null; // image/file/audio/video/location/contact -> placeholder upstream
  }
}

// Gupshup posts ONE event per request. Only inbound user messages
// (type === 'message') are surfaced; delivery/read/system events are ignored.
function parseInbound(body) {
  if (!body || typeof body !== 'object') return [];
  var events = Array.isArray(body) ? body : [body];
  var entries = buildEntries();
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var b = events[i] || {};
    if (b.type !== 'message') continue;
    var msg = b.payload || {};
    var appName = b.app || '';
    var match = null;
    for (var j = 0; j < entries.length; j++) { if (entries[j].appName === appName) { match = entries[j]; break; } }
    var phoneDigits = match ? match.phoneDigits : digits(msg.destination);
    out.push({
      phoneNumberId: phoneDigits,
      appName: appName,
      from: digits(msg.source || (msg.sender && msg.sender.phone) || ''),
      fromName: (msg.sender && msg.sender.name) || '',
      text: extractText(msg),
      messageId: msg.id || '',
      timestamp: b.timestamp ? String(b.timestamp) : '',
      type: msg.type || 'unknown'
    });
  }
  return out;
}

// Build the form body for a Gupshup text send (separated for testability).
function buildSendForm(cfg, to, text) {
  var params = new URLSearchParams();
  params.set('channel', 'whatsapp');
  params.set('source', String(cfg.sourcePhone || cfg.phoneNumberId));
  params.set('destination', digits(to));
  params.set('message', JSON.stringify({ type: 'text', text: String(text).slice(0, 4096) }));
  if (cfg.appName) params.set('src.name', cfg.appName);
  return params;
}

async function sendText(cfg, to, text) {
  if (!cfg || !cfg.apiKey) throw new Error('Gupshup send: missing apikey (set per-entry apiKey or GUPSHUP_API_KEY)');
  var res = await fetch(API_BASE + '/msg', {
    method: 'POST',
    headers: { 'apikey': cfg.apiKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: buildSendForm(cfg, to, text).toString(),
    signal: AbortSignal.timeout(10000)
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok || (data && data.status && data.status !== 'submitted')) {
    var m = (data && (data.message || data.reason || data.status)) || ('HTTP ' + res.status);
    var err = new Error('Gupshup send failed: ' + m); err.status = res.status; err.detail = data; throw err;
  }
  // Normalise to the Meta-shaped result the send endpoint expects.
  return { messages: [{ id: (data && data.messageId) || '' }], raw: data };
}

module.exports = {
  API_BASE: API_BASE,
  getNumberConfig: getNumberConfig,
  getConfigByClientId: getConfigByClientId,
  verifyMetaSignature: verifyMetaSignature,
  parseInbound: parseInbound,
  sendText: sendText,
  buildSendForm: buildSendForm
};
