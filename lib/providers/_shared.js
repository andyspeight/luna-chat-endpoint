// lib/providers/_shared.js
// Bits shared by every WhatsApp provider implementation. Inbound auth is the
// same shape regardless of provider: a shared secret carried as ?token= on the
// callback URL we register (or an x-webhook-token header), checked constant-time
// and FAIL-CLOSED. (When we cut over to DIRECT Meta we'd swap this for
// X-Hub-Signature-256 — see each provider's verifyMetaSignature.)

const crypto = require('crypto');

function safeEqual(a, b) {
  var ba = Buffer.from(String(a || ''));
  var bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function parseJsonEnv(name) {
  var raw = process.env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { console.warn('[whatsapp] ' + name + ' is not valid JSON:', e.message); return null; }
}

// GET handshake (Meta/360dialog style). Gupshup doesn't use it, but it's
// harmless to support. Returns the challenge to echo, or null to reject (403).
function verifyChallenge(req) {
  var q = req.query || {};
  var token = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!token) return null;
  if (q['hub.mode'] === 'subscribe' && safeEqual(q['hub.verify_token'], token)) {
    return typeof q['hub.challenge'] === 'undefined' ? '' : String(q['hub.challenge']);
  }
  return null;
}

// POST shared-secret check. FAIL-CLOSED if the secret isn't configured.
function verifyInbound(req) {
  var expected = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!expected) { console.error('[whatsapp] WHATSAPP_VERIFY_TOKEN not set; rejecting inbound'); return false; }
  var got = (req.query && req.query.token) || req.headers['x-webhook-token'] || '';
  return safeEqual(got, expected);
}

module.exports = { safeEqual: safeEqual, parseJsonEnv: parseJsonEnv, verifyChallenge: verifyChallenge, verifyInbound: verifyInbound };
