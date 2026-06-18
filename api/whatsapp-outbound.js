// Luna WhatsApp Outbound — deliver an AGENT's dashboard reply to WhatsApp.
//
// On the web, an agent's reply is published to Ably and the visitor's widget
// renders it. A WhatsApp customer has no widget, so when an agent replies to a
// WhatsApp conversation the dashboard ALSO calls this endpoint, which pushes the
// text to the customer through the Meta Cloud API.
//
// It is also the control plane for WhatsApp conversation state:
//   { control: 'takeover' } — mark the conversation human-handled so the webhook
//                             STOPS auto-replying with Luna.
//   { control: 'resolve'  } — end the WhatsApp session.
//   { text: '...' }         — send a message (and implicitly take over).
//
// AUTH: identical posture to api/ably-token.js (agent mode). Requires a valid
// tg_session cookie AND entitlement to the clientId. The reply-from number is
// resolved SERVER-SIDE from the client's config (lib/whatsapp.js) — the caller
// can never choose which number to send from. The recipient is taken from
// server-side session state where possible, falling back to a caller-supplied
// hint that is validated as a bare phone number.
//
// Body (POST): { clientId, convId, text?, to?, control? }
// Env: AIRTABLE_KEY, UPSTASH_REDIS_REST_* (for recipient/state), WhatsApp vars.

const auth = require('../lib/luna-auth');
const wa = require('../lib/whatsapp');
const store = require('../lib/wa-store');

const STATE_TTL = 60 * 60 * 24 * 30;
const AGENT_ORIGINS = ['https://chat.travelify.io', 'https://luna-chat-endpoint.vercel.app'];

function isValidRecordId(id) { return typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id); }
function isValidConvId(id) { return typeof id === 'string' && /^(?:conv|v)_\d{10,16}_[a-z0-9]{4,12}$/i.test(id) && id.length < 64; }
function cleanPhone(v) { return String(v || '').replace(/[^\d]/g, ''); }

function baseUrl(req) {
  return process.env.LUNA_BASE_URL || ('https://' + (req.headers.host || 'luna-chat-endpoint.vercel.app'));
}

// Mirror the webhook's transcript append so an agent's WhatsApp replies land in
// the same Airtable record as the rest of the conversation.
async function recordAgentTurn(base, clientName, convId, text) {
  var key = 'wa:script:' + convId;
  var prev = (await store.getStr(key)) || '[Channel: WhatsApp]';
  var next = prev + '\nAgent: ' + text;
  if (next.length > 45000) next = next.slice(next.length - 45000);
  await store.setStr(key, next, STATE_TTL);
  try {
    await fetch(base + '/api/conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: convId, clientName: clientName, handler: 'Agent', history: next }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (e) { /* best-effort */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Credentialed agent request — echo the exact origin (never wildcard with
  // credentials), exactly as ably-token.js does for the agent path.
  var origin = req.headers.origin || '';
  if (AGENT_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    console.error('[whatsapp-outbound] Missing AIRTABLE_KEY');
    return res.status(500).json({ error: 'Service misconfigured' });
  }

  var body = req.body || {};
  var clientId = body.clientId;
  var convId = (body.convId || '').trim();
  var control = body.control || '';
  var text = typeof body.text === 'string' ? body.text.trim() : '';

  if (!isValidRecordId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!isValidConvId(convId)) return res.status(400).json({ error: 'Invalid convId' });

  // ── Auth: signed-in agent entitled to this client ──
  var session;
  try {
    session = await auth.validateSession(req.headers.cookie || '');
  } catch (e) {
    return res.status(502).json({ error: 'Auth check failed' });
  }
  if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Unauthorised' });

  var rec;
  try {
    rec = await auth.resolveEntitledClient(atKey, session, clientId);
  } catch (e) {
    console.error('[whatsapp-outbound] entitlement error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }
  if (!rec) return res.status(403).json({ error: 'Not entitled to this client' });

  var clientName = (rec.fields && rec.fields.ClientName) || '';
  if (!clientName) return res.status(500).json({ error: 'Client name unavailable' });

  var cfg = wa.configByClientName(clientName);
  if (!cfg) return res.status(400).json({ error: 'No WhatsApp number configured for this client' });

  // Load conversation routing state. The recipient is authoritative from server
  // state; a caller hint is only used as a fallback and validated as a phone.
  var state = await store.getJson('wa:conv:' + convId);
  if (state && state.clientId && state.clientId !== clientId) {
    return res.status(403).json({ error: 'Conversation does not belong to this client' });
  }
  var to = (state && state.waId) ? String(state.waId) : cleanPhone(body.to);
  if (!to || to.length < 6) return res.status(400).json({ error: 'No WhatsApp recipient for this conversation' });

  if (!state) {
    // State expired or running without Upstash — synthesise enough to operate.
    state = { waId: to, phoneNumberId: cfg.phoneNumberId, clientId: clientId, clientName: clientName, handler: 'human', announced: true, startedAt: new Date().toISOString() };
  }

  try {
    // ── Control actions ──
    if (control === 'takeover') {
      state.handler = 'human';
      await store.setJson('wa:conv:' + convId, state, STATE_TTL);
      return res.status(200).json({ ok: true, handler: 'human' });
    }
    if (control === 'resolve') {
      state.handler = 'resolved';
      await store.setJson('wa:conv:' + convId, state, STATE_TTL);
      await store.del('wa:sess:' + state.phoneNumberId + ':' + state.waId);
      return res.status(200).json({ ok: true, handler: 'resolved' });
    }

    // ── Send a message ──
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (text.length > 4096) text = text.slice(0, 4096);

    var result = await wa.sendChunks(cfg, to, text);

    // An agent replying means a human now owns the conversation: stop the bot.
    state.handler = 'human';
    await store.setJson('wa:conv:' + convId, state, STATE_TTL);
    await recordAgentTurn(baseUrl(req), clientName, convId, text);

    var firstId = (result && result[0] && result[0].messages && result[0].messages[0] && result[0].messages[0].id) || null;
    return res.status(200).json({ ok: true, sent: true, messageId: firstId });

  } catch (e) {
    console.error('[whatsapp-outbound] send error:', e.message, e.status || '');
    return res.status(502).json({ error: 'WhatsApp delivery failed' });
  }
};
