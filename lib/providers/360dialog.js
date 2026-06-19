// lib/providers/360dialog.js
// 360dialog WhatsApp provider — a thin, Meta-NATIVE proxy. Request/response and
// webhook JSON are Meta's own Cloud API shapes; only host + auth + path differ.
// Migration to direct Meta: host waba-v2.360dialog.io -> graph.facebook.com/v{ver},
// D360-API-KEY -> Authorization: Bearer, and re-add /{PHONE_NUMBER_ID} to paths.
//
// Config (env WHATSAPP_NUMBER_MAP): { phone_number_id: "recXXX" } or
// { phone_number_id: { clientId, apiKey } }. Send keys may also come from
// WHATSAPP_D360_KEYS { phone_number_id: key } or WHATSAPP_D360_API_KEY.

const shared = require('./_shared');

const API_BASE = (process.env.WHATSAPP_API_BASE || 'https://waba-v2.360dialog.io').replace(/\/+$/, '');

function getNumberConfig(phoneNumberId) {
  if (!phoneNumberId) return null;
  var id = String(phoneNumberId);
  var map = shared.parseJsonEnv('WHATSAPP_NUMBER_MAP') || {};
  var entry = map[id];
  if (!entry) return null;

  var clientId, apiKey;
  if (typeof entry === 'string') { clientId = entry; }
  else if (entry && typeof entry === 'object') { clientId = entry.clientId || entry.recId; apiKey = entry.apiKey; }

  if (!apiKey) {
    var keys = shared.parseJsonEnv('WHATSAPP_D360_KEYS') || {};
    apiKey = keys[id] || process.env.WHATSAPP_D360_API_KEY || process.env.D360_API_KEY || '';
  }
  if (!clientId) return null;
  return { phoneNumberId: id, clientId: String(clientId), apiKey: String(apiKey || '') };
}

function getConfigByClientId(clientId) {
  if (!clientId) return null;
  var map = shared.parseJsonEnv('WHATSAPP_NUMBER_MAP') || {};
  var ids = Object.keys(map);
  for (var i = 0; i < ids.length; i++) {
    var cfg = getNumberConfig(ids[i]);
    if (cfg && cfg.clientId === String(clientId)) return cfg;
  }
  return null;
}

function verifyMetaSignature(rawBody, signatureHeader) {
  var crypto = require('crypto');
  var secret = process.env.META_APP_SECRET || '';
  if (!secret) return { ok: true, skipped: true };
  if (!signatureHeader || rawBody == null) return { ok: false };
  var expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  return { ok: shared.safeEqual(signatureHeader, expected) };
}

function extractText(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'text' && msg.text) return msg.text.body || '';
  if (msg.type === 'button' && msg.button) return msg.button.text || '';
  if (msg.type === 'interactive' && msg.interactive) {
    var it = msg.interactive;
    if (it.button_reply) return it.button_reply.title || it.button_reply.id || '';
    if (it.list_reply) return it.list_reply.title || it.list_reply.id || '';
  }
  return null;
}

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
      var nameByWa = {};
      (value.contacts || []).forEach(function (c) { if (c && c.wa_id) nameByWa[c.wa_id] = (c.profile && c.profile.name) || ''; });
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

async function sendText(cfg, to, text) {
  if (!cfg || !cfg.apiKey) throw new Error('360dialog send: missing D360-API-KEY for this number');
  var body = {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: String(to), type: 'text', text: { preview_url: true, body: String(text).slice(0, 4096) }
  };
  var res = await fetch(API_BASE + '/messages', {
    method: 'POST',
    headers: { 'D360-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    var err = new Error('360dialog send failed: ' + msg); err.status = res.status; err.detail = data; throw err;
  }
  return data; // Meta-native: { messages: [{ id }] }
}

module.exports = { API_BASE: API_BASE, getNumberConfig: getNumberConfig, getConfigByClientId: getConfigByClientId, verifyMetaSignature: verifyMetaSignature, parseInbound: parseInbound, sendText: sendText };
