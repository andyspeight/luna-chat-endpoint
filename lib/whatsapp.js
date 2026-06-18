// lib/whatsapp.js
// Meta WhatsApp Cloud API helpers + message formatting for Luna Chat.
//
// Responsibilities (kept in one place so the webhook + the agent-send endpoint
// behave identically):
//   - Resolve which Luna client a WhatsApp number belongs to (routing/config).
//   - Verify Meta's webhook signature (X-Hub-Signature-256).
//   - Send text messages back to the customer via the Cloud API.
//   - Convert Luna's rich reply (which can contain [BLOCK]{...}[/BLOCK] cards
//     meant for the web widget) into clean WhatsApp-friendly plain text.
//
// CONFIGURATION (use either or both):
//   1. WHATSAPP_NUMBERS — JSON array, one entry per business number (multi-tenant):
//        [{ "phoneNumberId":"123", "clientName":"Travelgenix",
//           "token":"EAAG...", "verifyToken":"my-verify" }]
//   2. Single-number fallback env vars:
//        WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_CLIENT_NAME,
//        WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN
//   Shared:
//        WHATSAPP_TOKEN        default access token if a number omits its own
//        WHATSAPP_VERIFY_TOKEN default webhook verify token
//        META_APP_SECRET       app secret used to verify request signatures
//        WHATSAPP_API_VERSION  Graph API version (default below)
//        WHATSAPP_AI_AUTOREPLY "false" to send straight to a human (default: AI answers)

const crypto = require('crypto');
const blockParser = require('./block-parser');

const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH_HOST = 'https://graph.facebook.com';
const WA_MAX_BODY = 4096; // Cloud API hard limit for a text body

// ── Configuration / routing ────────────────────────────────────────────────

function parseNumbers() {
  var list = [];
  var raw = process.env.WHATSAPP_NUMBERS;
  if (raw) {
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) list = arr;
      else console.warn('[whatsapp] WHATSAPP_NUMBERS must be a JSON array');
    } catch (e) {
      console.warn('[whatsapp] WHATSAPP_NUMBERS is not valid JSON:', e.message);
    }
  }
  // Single-number fallback (merged in if not already present).
  if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
    var id = String(process.env.WHATSAPP_PHONE_NUMBER_ID);
    if (!list.some(function (n) { return String(n.phoneNumberId) === id; })) {
      list.push({
        phoneNumberId: id,
        clientName: process.env.WHATSAPP_CLIENT_NAME || '',
        token: process.env.WHATSAPP_TOKEN || '',
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || ''
      });
    }
  }
  return list.map(function (n) {
    return {
      phoneNumberId: String(n.phoneNumberId || ''),
      clientName: String(n.clientName || ''),
      token: String(n.token || process.env.WHATSAPP_TOKEN || ''),
      verifyToken: String(n.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || '')
    };
  }).filter(function (n) { return n.phoneNumberId; });
}

// Which client owns the number that RECEIVED an inbound message.
function configByPhoneNumberId(id) {
  if (!id) return null;
  var list = parseNumbers();
  for (var i = 0; i < list.length; i++) {
    if (list[i].phoneNumberId === String(id)) return list[i];
  }
  return null;
}

// Which number an agent should reply FROM, given their Luna client name.
function configByClientName(name) {
  if (!name) return null;
  var lower = String(name).toLowerCase();
  var list = parseNumbers();
  for (var i = 0; i < list.length; i++) {
    if (list[i].clientName && list[i].clientName.toLowerCase() === lower) return list[i];
  }
  return null;
}

// GET webhook handshake: accept the global verify token OR any per-number one.
function verifyTokenMatches(token) {
  if (!token) return false;
  if (process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) return true;
  return parseNumbers().some(function (n) { return n.verifyToken && n.verifyToken === token; });
}

function appSecret() { return process.env.META_APP_SECRET || ''; }

function autoReplyEnabled() {
  return String(process.env.WHATSAPP_AI_AUTOREPLY || 'true').toLowerCase() !== 'false';
}

// A conversation id that satisfies the platform's strict pattern
// (/^conv_\d{10,16}_[a-z0-9]{4,12}$/i) so it flows through the existing Ably
// channels and api/conversation.js unchanged.
function newConvId() {
  var rnd = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 6);
  while (rnd.length < 6) { rnd += 'x'; }
  return 'conv_' + Date.now() + '_' + rnd;
}

// ── Signature verification ───────────────────────────────────────────────────
// Returns { ok, skipped? }. skipped:true means no app secret is configured, so
// verification could not run (caller decides whether to allow). Uses a
// constant-time compare to avoid leaking the expected digest.
function verifySignature(rawBody, signatureHeader) {
  var secret = appSecret();
  if (!secret) return { ok: true, skipped: true };
  if (!signatureHeader || rawBody === undefined || rawBody === null) return { ok: false };
  var expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
  try {
    var a = Buffer.from(String(signatureHeader));
    var b = Buffer.from(expected);
    if (a.length !== b.length) return { ok: false };
    return { ok: crypto.timingSafeEqual(a, b) };
  } catch (e) {
    return { ok: false };
  }
}

// ── Cloud API: send ──────────────────────────────────────────────────────────
async function sendText(cfg, to, text, apiVersion) {
  if (!cfg || !cfg.token || !cfg.phoneNumberId) {
    throw new Error('WhatsApp number not configured (missing token or phoneNumberId)');
  }
  var version = apiVersion || DEFAULT_API_VERSION;
  var url = GRAPH_HOST + '/' + version + '/' + encodeURIComponent(cfg.phoneNumberId) + '/messages';
  var body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to),
    type: 'text',
    text: { preview_url: true, body: String(text).slice(0, WA_MAX_BODY) }
  };
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    var err = new Error('WhatsApp send failed: ' + msg);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data; // { messages: [{ id }], ... }
}

// Long replies are split on paragraph boundaries and sent as sequential bubbles.
async function sendChunks(cfg, to, text, apiVersion) {
  var chunks = splitForWhatsApp(text);
  var out = [];
  for (var i = 0; i < chunks.length; i++) {
    out.push(await sendText(cfg, to, chunks[i], apiVersion));
  }
  return out;
}

// Best-effort blue-tick read receipt; never throws.
async function markRead(cfg, messageId, apiVersion) {
  if (!cfg || !cfg.token || !cfg.phoneNumberId || !messageId) return;
  var version = apiVersion || DEFAULT_API_VERSION;
  var url = GRAPH_HOST + '/' + version + '/' + encodeURIComponent(cfg.phoneNumberId) + '/messages';
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) { /* read receipts are best-effort */ }
}

// ── Formatting: Luna rich reply -> WhatsApp plain text ───────────────────────
// Luna can emit [BLOCK]{...}[/BLOCK] cards (destination/offer/handoff etc.) that
// only the web widget can render. On WhatsApp we keep the conversational prose
// and drop the card markup, then map the small markdown subset Luna uses onto
// WhatsApp's own formatting (*bold*, _italic_).
function toPlainText(reply) {
  if (typeof reply !== 'string' || !reply) return '';
  var prose = '';
  try {
    var items = blockParser.parseLunaResponse(reply);
    if (items && items.length) {
      prose = items
        .filter(function (i) { return i.type === 'prose'; })
        .map(function (i) { return i.text; })
        .join('\n\n');
    }
  } catch (e) { /* fall through to raw strip */ }
  // If the reply was ALL blocks (no prose extracted), strip markers from raw.
  if (!prose.trim()) {
    prose = reply.replace(/\[BLOCK\][\s\S]*?\[\/BLOCK\]/g, ' ');
  }
  return mdToWhatsApp(prose);
}

function mdToWhatsApp(s) {
  return String(s)
    // [text](url) -> text (url)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    // **bold** / __bold__ -> *bold* (WhatsApp bold is a single asterisk)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    // markdown headings -> bold line
    .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, '*$1*')
    // tidy excess blank lines / trailing spaces
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitForWhatsApp(text, max) {
  max = max || 3900; // leave headroom under the 4096 hard limit
  var s = String(text || '');
  if (s.length <= max) return [s || ''];
  var chunks = [];
  var paras = s.split('\n\n');
  var cur = '';
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (p.length > max) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (var j = 0; j < p.length; j += max) { chunks.push(p.slice(j, j + max)); }
      continue;
    }
    var candidate = cur ? (cur + '\n\n' + p) : p;
    if (candidate.length > max) { if (cur) chunks.push(cur); cur = p; }
    else { cur = candidate; }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [s.slice(0, max)];
}

module.exports = {
  DEFAULT_API_VERSION: DEFAULT_API_VERSION,
  parseNumbers: parseNumbers,
  configByPhoneNumberId: configByPhoneNumberId,
  configByClientName: configByClientName,
  verifyTokenMatches: verifyTokenMatches,
  appSecret: appSecret,
  autoReplyEnabled: autoReplyEnabled,
  newConvId: newConvId,
  verifySignature: verifySignature,
  sendText: sendText,
  sendChunks: sendChunks,
  markRead: markRead,
  toPlainText: toPlainText,
  mdToWhatsApp: mdToWhatsApp,
  splitForWhatsApp: splitForWhatsApp
};
