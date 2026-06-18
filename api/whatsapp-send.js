// Luna WhatsApp Send — deliver an AGENT's dashboard reply to WhatsApp (Phase 2),
// and the control plane for WhatsApp conversation state.
//
//   { text }              send a message to the customer (and take over the chat)
//   { control:'takeover'} mark the conversation human-handled (Luna stops replying)
//   { control:'resolve'} end the conversation
//
// AUTH NOTE (deliberate deviation from the build brief): the brief specified
// per-client auth against the Clients `DashboardPassword` field. The live
// dashboard has since moved to central session cookies (see api/ably-token.js
// agent mode — `CONFIG.PASSWORD` is no longer used). So this endpoint uses the
// SAME session-cookie + entitlement check as ably-token's agent path, which is
// stronger and consistent with the current dashboard. Flagged for review.
//
// The recipient is derived from the convId (`wa_<phoneNumberId>_<from>`), so no
// lookup is needed; the reply-FROM number/key is resolved server-side from the
// client config — a caller can never choose which number to send from.
//
// Body (POST): { clientId, convId, text?, control? }
// Env: AIRTABLE_KEY, WHATSAPP_NUMBER_MAP (+ send keys).

const auth = require('../lib/luna-auth');
const provider = require('../lib/whatsapp-provider');
const fmt = require('../lib/wa-format');
const convs = require('../lib/wa-conversations');
const wamsg = require('../lib/wa-messages');

const AGENT_ORIGINS = ['https://chat.travelify.io', 'https://lunachat.travelify.io', 'https://luna-chat.travelify.io', 'https://luna-chat-endpoint.vercel.app'];

function isValidRecordId(id) { return typeof id === 'string' && /^rec[A-Za-z0-9]{14}$/.test(id); }
function isValidConvId(id) { return typeof id === 'string' && /^wa_\d{6,}_\d{4,}$/.test(id) && id.length < 64; }

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  var origin = req.headers.origin || '';
  if (AGENT_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) { console.error('[whatsapp-send] Missing AIRTABLE_KEY'); return res.status(500).json({ error: 'Service misconfigured' }); }

  var body = req.body || {};
  var clientId = body.clientId;
  var convId = (body.convId || '').trim();
  var control = body.control || '';
  var text = typeof body.text === 'string' ? body.text.trim() : '';

  if (!isValidRecordId(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!isValidConvId(convId)) return res.status(400).json({ error: 'Invalid convId' });

  // ── Auth: signed-in agent entitled to this client (mirrors ably-token agent mode) ──
  var session;
  try { session = await auth.validateSession(req.headers.cookie || ''); }
  catch (e) { return res.status(502).json({ error: 'Auth check failed' }); }
  if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Unauthorised' });
  var agentName = (session && (session.name || session.displayName || session.email || session.username)) || '';

  var rec;
  try { rec = await auth.resolveEntitledClient(atKey, session, clientId); }
  catch (e) { console.error('[whatsapp-send] entitlement error:', e.message); return res.status(500).json({ error: 'Service unavailable' }); }
  if (!rec) return res.status(403).json({ error: 'Not entitled to this client' });

  var cfg = provider.getConfigByClientId(clientId);
  if (!cfg) return res.status(400).json({ error: 'No WhatsApp number configured for this client' });

  // Recipient + sending number are both implied by the convId; verify the convId
  // belongs to this client's number, then derive the recipient.
  var parts = convId.split('_'); // ['wa', <pnid digits>, <from digits>]
  if (parts[1] !== String(cfg.phoneNumberId).replace(/\D/g, '')) {
    return res.status(403).json({ error: 'Conversation does not belong to this client number' });
  }
  var to = parts[2];

  try {
    // ── Control actions ──
    if (control === 'takeover' || control === 'resolve') {
      var nextStatus = control === 'resolve' ? 'Closed' : 'Active';
      var existingC = await convs.getByConvId(atKey, convId);
      if (existingC) await convs.patchConversation(atKey, existingC.id, { handler: nextStatus });
      return res.status(200).json({ ok: true, handler: nextStatus });
    }

    // ── Send a message ──
    if (!text) return res.status(400).json({ error: 'Missing text' });
    if (text.length > fmt.WA_MAX_BODY) text = text.slice(0, fmt.WA_MAX_BODY);

    var chunks = fmt.splitForWhatsApp(text);
    var firstId = null;
    for (var i = 0; i < chunks.length; i++) {
      var r = await provider.sendText(cfg, to, chunks[i]);
      if (!firstId && r && r.messages && r.messages[0]) firstId = r.messages[0].id;
    }

    // An agent reply means a human now owns the chat: stop Luna + log the turn.
    var existing = await convs.getByConvId(atKey, convId);
    if (existing) {
      await convs.patchConversation(atKey, existing.id, {
        handler: 'Active',
        history: (existing.history || '') + '\nagent: ' + text
      });
      await wamsg.logMessage(atKey, { convRecordId: existing.id, sender: 'agent', content: text, messageId: firstId, agentName: agentName });
    }
    return res.status(200).json({ ok: true, sent: true, messageId: firstId });

  } catch (e) {
    console.error('[whatsapp-send] error:', e.message, e.status || '');
    return res.status(502).json({ error: 'WhatsApp delivery failed' });
  }
};
