// lib/wa-conversations.js
// Direct Airtable access to the Conversations table for the WhatsApp channel.
//
// WHY DIRECT (not via /api/conversation): the WhatsApp convId is `wa_<pnid>_<from>`,
// which api/conversation.js's isValidConvId deliberately rejects (it only allows
// the widget's `conv_`/`v_` ids). The brief's contract therefore writes this
// table directly, by FIELD ID, with returnFieldsByFieldId=true on read so we can
// inspect the current handler. (Verified against api/conversation.js +
// api/log-conversation.js — same base/table/field ids.)
//
// Upsert rules (from the build brief, §5):
//   • New row: ConversationID + StartedAt + Handler + Client link + History.
//   • Existing row: append "\n<role>: <text>" to History, bump UpdatedAt, and
//     ONLY re-open (Handler -> reopenHandler) if the current Handler is
//     Resolved/Closed — otherwise leave Handler untouched so we never yank an
//     active agent out of a live conversation.

const BASE = 'app6Ot3eOb3DangkB';
const TABLE = 'tblyin27D2J9ejHvf'; // Conversations
const F = {
  convId:    'fldgQj90mYwsVO4yK', // ConversationID
  visitor:   'fldqx6k7WvrqE8BW1', // VisitorName
  handler:   'fldYdZq59FCpKQ7Hf', // Handler (Bot/AI/Waiting/Agent/Closed/Resolved)
  startedAt: 'fldSoy7BMqyzVb5pp', // StartedAt
  updatedAt: 'fld1GghMiUnAmdtow', // UpdatedAt
  history:   'fldZ38GYN4XbHGl03', // History (long text; lines "role: text")
  client:    'flde1PCByneD05YyG'  // Client (LINK to Clients)
};
const MAX_HISTORY = 50000;

function authHeaders(atKey) {
  return { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };
}
function tableUrl() { return 'https://api.airtable.com/v0/' + BASE + '/' + TABLE; }

// convId is `wa_<digits>_<digits>` (no quotes/specials) so it is safe to embed.
async function getByConvId(atKey, convId) {
  var url = tableUrl()
    + '?filterByFormula=' + encodeURIComponent("{ConversationID}='" + convId + "'")
    + '&maxRecords=1&returnFieldsByFieldId=true';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Airtable search failed: ' + r.status);
  var d = await r.json();
  var rec = (d.records && d.records[0]) || null;
  if (!rec) return null;
  var f = rec.fields || {};
  var handler = f[F.handler];
  if (handler && typeof handler === 'object') handler = handler.name; // singleSelect can come back as {name}
  return { id: rec.id, handler: handler || '', history: f[F.history] || '' };
}

function clampHistory(s) {
  if (s.length <= MAX_HISTORY) return s;
  return s.slice(s.length - MAX_HISTORY);
}

async function createConversation(atKey, opts) {
  var now = new Date().toISOString();
  var fields = {};
  fields[F.convId] = opts.convId;
  fields[F.startedAt] = now;
  fields[F.updatedAt] = now;
  fields[F.handler] = opts.handler;
  if (opts.clientId) fields[F.client] = [opts.clientId];
  if (opts.visitorName) fields[F.visitor] = opts.visitorName;
  if (opts.historyLine) fields[F.history] = clampHistory(opts.historyLine);

  var r = await fetch(tableUrl(), {
    method: 'POST',
    headers: authHeaders(atKey),
    body: JSON.stringify({ records: [{ fields: fields }], typecast: true }),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) {
    var e = await r.text().catch(function () { return ''; });
    throw new Error('Airtable create failed: ' + r.status + ' ' + e.slice(0, 200));
  }
  var d = await r.json();
  return { id: d.records && d.records[0] && d.records[0].id };
}

// Patch handler / append a history line / set visitor name. UpdatedAt always bumps.
async function patchConversation(atKey, recordId, opts) {
  var fields = {};
  fields[F.updatedAt] = new Date().toISOString();
  if (opts.handler) fields[F.handler] = opts.handler;
  if (opts.visitorName) fields[F.visitor] = opts.visitorName;
  if (typeof opts.history === 'string') fields[F.history] = clampHistory(opts.history);

  var r = await fetch(tableUrl() + '/' + recordId, {
    method: 'PATCH',
    headers: authHeaders(atKey),
    body: JSON.stringify({ fields: fields, typecast: true }),
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) {
    var e = await r.text().catch(function () { return ''; });
    throw new Error('Airtable patch failed: ' + r.status + ' ' + e.slice(0, 200));
  }
  return true;
}

module.exports = {
  BASE: BASE, TABLE: TABLE, F: F, MAX_HISTORY: MAX_HISTORY,
  getByConvId: getByConvId,
  createConversation: createConversation,
  patchConversation: patchConversation,
  clampHistory: clampHistory
};
