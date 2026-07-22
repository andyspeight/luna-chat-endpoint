// Tests for the pre-launch DoS / cost hardening.
//
// Covers: the anti-spoof client-IP extraction, and source guards proving the
// money-endpoint daily cap no longer fails open and the two previously
// unlimited endpoints now rate-limit.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ratelimit = require('../lib/ratelimit');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CHAT = read('api/luna-chat.js');
const LOGCONV = read('api/log-conversation.js');
const QUALITY = read('api/conversation-quality.js');
const RL = read('lib/ratelimit.js');

// ── getClientIp: prefer the unspoofable x-real-ip ──
function reqWith(headers) { return { headers, socket: { remoteAddress: '10.0.0.9' } }; }

test('getClientIp prefers x-real-ip over a client-supplied x-forwarded-for', () => {
  const ip = ratelimit.getClientIp(reqWith({
    'x-real-ip': '203.0.113.7',
    'x-forwarded-for': '1.2.3.4, 5.6.7.8'   // attacker-controlled left hop
  }));
  assert.equal(ip, '203.0.113.7', 'must not trust the forwarded-for left hop when x-real-ip is present');
});

test('getClientIp falls back to x-forwarded-for only when x-real-ip is absent', () => {
  assert.equal(ratelimit.getClientIp(reqWith({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8' })), '9.9.9.9');
});

test('getClientIp falls back to the socket address as a last resort', () => {
  assert.equal(ratelimit.getClientIp(reqWith({})), '10.0.0.9');
});

test('getClientIp ignores an empty x-real-ip and moves on', () => {
  assert.equal(ratelimit.getClientIp(reqWith({ 'x-real-ip': '   ', 'x-forwarded-for': '7.7.7.7' })), '7.7.7.7');
});

// ── Source guard: the daily spend cap must not fail open ──
test('GUARD: luna-chat daily cap falls back to a per-instance cap when the limiter is unreachable', () => {
  assert.match(CHAT, /function localDailyCapExceeded/, 'the per-instance fallback must exist');
  // When incrDaily returns null AND the limiter is configured, we must still block.
  assert.match(CHAT, /else if \(ratelimit\.isConfigured\(\)\)\s*\{[\s\S]*localDailyCapExceeded\(\)/,
    'a configured-but-unreachable limiter must engage the fallback, not skip the cap');
  // The old fail-open shape (null => allowed) must be gone.
  assert.doesNotMatch(CHAT, /dailyCount !== null && dailyCount > DAILY_CHAT_CAP/,
    'the fail-open guard must be replaced');
});

// ── Source guards: the two previously unlimited endpoints now rate-limit ──
test('GUARD: log-conversation rate-limits by IP and convId before doing work', () => {
  assert.match(LOGCONV, /require\('\.\.\/lib\/ratelimit'\)/, 'must import the limiter');
  assert.match(LOGCONV, /checkIpAndKey\(req,\s*\{[\s\S]*ipKey:\s*'log-conv'/, 'must apply an IP limit');
  assert.match(LOGCONV, /status\(429\)/, 'must 429 when over the limit');
});

test('GUARD: conversation-quality rate-limits by convId (not IP, since it is called internally)', () => {
  assert.match(QUALITY, /require\('\.\.\/lib\/ratelimit'\)/, 'must import the limiter');
  assert.match(QUALITY, /ratelimit\.check\('rl:conv-quality:' \+ convId/, 'must limit per convId');
});

// ── Source guard: the anti-spoof rationale is documented where it matters ──
test('GUARD: getClientIp documents why x-real-ip is preferred', () => {
  assert.match(RL, /x-real-ip/, 'x-real-ip must be read');
  assert.match(RL, /spoof/i, 'the spoofing rationale should be recorded so it is not "simplified" back');
});
