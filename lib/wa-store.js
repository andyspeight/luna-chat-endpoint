// lib/wa-store.js
// Tiny key/value store for WhatsApp session + routing state, backed by the same
// Upstash Redis the rate limiter already uses. Self-contained (mirrors
// lib/ratelimit.js's fetch-based approach) so it adds zero dependencies.
//
// WHAT IT HOLDS (all keys are scoped so one client can never read another's):
//   wa:sess:{phoneNumberId}:{waId} -> convId           the customer's CURRENT
//                                                       conversation (TTL ~ the
//                                                       WhatsApp 24h window + slack)
//   wa:conv:{convId}               -> JSON state        { waId, phoneNumberId,
//                                                         clientId, clientName,
//                                                         name, handler, announced }
//   wa:hist:{convId}               -> JSON turns         [{role,content}, ...] fed to luna-chat
//   wa:script:{convId}             -> string transcript  human-readable, upserted to Airtable
//   wa:dedup:{messageId}           -> "1"                Meta delivers webhooks
//                                                        at-least-once; dedupe retries
//
// WHY Upstash and not Airtable for this: it is hot, ephemeral routing state read
// and written on every inbound message. Airtable stays the durable transcript
// store (api/conversation.js, api/log-conversation.js) exactly as for web chats.
//
// Fail behaviour: every call fails SOFT (returns null / false) so a Redis blip
// degrades WhatsApp gracefully instead of throwing inside the webhook. Callers
// treat "no state" as "fresh conversation, bot handles it".
//
// Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (both required; without
// them WhatsApp loses multi-turn memory + agent routing — see WHATSAPP-SETUP.md).

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function isConfigured() {
  return !!(URL_BASE && TOKEN);
}

// Run a single Redis command via Upstash's REST API. Upstash accepts a JSON
// array body (["SET","k","v","EX","60"]) and replies { "result": ... }.
async function cmd(command) {
  if (!isConfigured()) return null;
  try {
    var res = await fetch(URL_BASE, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) {
      console.warn('[wa-store] Upstash HTTP', res.status);
      return null;
    }
    var data = await res.json();
    return (data && typeof data === 'object' && 'result' in data) ? data.result : null;
  } catch (e) {
    console.warn('[wa-store] Upstash error:', e.name, e.message);
    return null;
  }
}

async function getStr(key) {
  var r = await cmd(['GET', key]);
  return (r === null || r === undefined) ? null : String(r);
}

async function setStr(key, val, ttlSecs) {
  var c = ['SET', key, String(val)];
  if (ttlSecs) { c.push('EX', String(ttlSecs)); }
  return (await cmd(c)) === 'OK';
}

async function getJson(key) {
  var r = await getStr(key);
  if (r === null) return null;
  try { return JSON.parse(r); } catch (e) { return null; }
}

async function setJson(key, obj, ttlSecs) {
  return setStr(key, JSON.stringify(obj), ttlSecs);
}

// SET key val NX EX ttl — returns true only if the key did NOT already exist.
// Used for idempotent dedupe of Meta's at-least-once webhook retries.
async function setIfAbsent(key, val, ttlSecs) {
  var c = ['SET', key, String(val), 'NX'];
  if (ttlSecs) { c.push('EX', String(ttlSecs)); }
  return (await cmd(c)) === 'OK';
}

async function del(key) {
  await cmd(['DEL', key]);
}

module.exports = {
  isConfigured: isConfigured,
  getStr: getStr,
  setStr: setStr,
  getJson: getJson,
  setJson: setJson,
  setIfAbsent: setIfAbsent,
  del: del
};
