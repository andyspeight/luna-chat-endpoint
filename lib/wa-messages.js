// lib/wa-messages.js
// Per-message logging to the Messages table (tblGlvZLU8xub2LHK) — one row per
// inbound/outbound WhatsApp message, linked to its Conversations record. Field
// ids + the Sender singleSelect choices were read from the live base schema
// (visitor | bot | agent). The table had no `direction`/`deliveryStatus` fields,
// so we use what exists; delivery receipts can be added later if those fields
// are created.
//
// Best-effort: this is an audit/inbox convenience, never on the user's critical
// path, so it logs and swallows errors rather than throwing.

const BASE = 'app6Ot3eOb3DangkB';
const TABLE = 'tblGlvZLU8xub2LHK'; // Messages
const F = {
  messageId:    'fldySMydwTw90O5sE', // MessageID (primary, singleLineText)
  conversation: 'fldN7rILp10VGhYnY', // Conversation (link -> Conversations)
  sender:       'fldFxBpxtFqonBahg', // Sender (singleSelect: visitor | bot | agent)
  content:      'fldfWXmfyRV3hsP6T', // Content (multilineText)
  sentAt:       'fldq9iqrMkcbSO0KM', // SentAt (dateTime)
  agentName:    'fldlEgJ40X9rEDyeY'  // AgentName (singleLineText)
};
const SENDERS = { visitor: 1, bot: 1, agent: 1 };

// opts: { convRecordId, sender, content, messageId?, sentAt?, agentName? }
async function logMessage(atKey, opts) {
  try {
    if (!atKey || !opts || !opts.convRecordId) return null;
    var sender = SENDERS[opts.sender] ? opts.sender : 'bot';
    var fields = {};
    fields[F.conversation] = [opts.convRecordId];
    fields[F.sender] = sender;
    fields[F.content] = String(opts.content == null ? '' : opts.content).slice(0, 100000);
    fields[F.sentAt] = opts.sentAt || new Date().toISOString();
    // MessageID is the primary field; fall back to a synthetic id for outbound
    // messages where the provider didn't return one.
    fields[F.messageId] = opts.messageId || ('wa-' + sender + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    if (opts.agentName) fields[F.agentName] = String(opts.agentName).slice(0, 200);

    var r = await fetch('https://api.airtable.com/v0/' + BASE + '/' + TABLE, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: fields }], typecast: true }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      var e = await r.text().catch(function () { return ''; });
      console.warn('[wa-messages] log failed:', r.status, e.slice(0, 200));
      return null;
    }
    var d = await r.json();
    return (d.records && d.records[0] && d.records[0].id) || null;
  } catch (e) {
    console.warn('[wa-messages] log error:', e.message);
    return null;
  }
}

module.exports = { BASE: BASE, TABLE: TABLE, F: F, logMessage: logMessage };
