// The health monitor must never fail silently.
//
// /api/monitor failed 24 runs in a row — every run for six hours — and sent no
// alert. Two faults, compounding:
//
//   1. The "Luna Chat is DOWN" Telegram only fires on the SECOND consecutive
//      failure, and the counter lives in Redis. With no Redis configured, every
//      run read fails:0, incremented to 1, and never reached 2. The alert could
//      never fire, however long the outage lasted.
//   2. The failure detail existed only in the HTTP response body, which nothing
//      reads. So a failing monitor was undiagnosable without the cron secret —
//      there was no way to see WHICH of the three checks had broken.
//
// A watchdog that fails silently is worse than none: it also tells you
// everything is fine.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'monitor.js'), 'utf8');

test('loadState reports whether the store was actually reachable', () => {
  // Previously an unreachable store was indistinguishable from "no failures
  // recorded yet" — which is precisely how the counter never advanced.
  assert.match(SRC, /if \(res === null\) return \{ state: \{ fails: 0, down: false \}, stored: false \};/);
  assert.match(SRC, /if \(res\[0\] == null\) return \{ state: \{ fails: 0, down: false \}, stored: true \};/,
    'a store that is up but empty is NOT the same as a store that is missing');
});

test('with no state store, the alert fires on the FIRST failure', () => {
  assert.match(SRC, /var shouldAlert = stateStored \? \(state\.fails >= 2 && !state\.down\) : true;/,
    'holding back for "two in a row" without a counter means never alerting at all');
});

test('the two-in-a-row blip suppression still applies when the store works', () => {
  assert.match(SRC, /state\.fails >= 2 && !state\.down/);
});

test('the alert says it will repeat, and how to stop it', () => {
  // An unexplained repeating alert gets muted, which recreates the silence.
  assert.match(SRC, /this will repeat every 15 minutes/);
  assert.match(SRC, /UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN/);
});

test('every run logs which check failed and why', () => {
  assert.match(SRC, /console\.error\('\[monitor\] UNHEALTHY'/);
  ['visitorToken', 'dashboardKey', 'aiGeneration'].forEach((k) => {
    assert.ok(SRC.includes("' | " + k + ": '"), k + ' must appear in the log line');
  });
});

test('an unavailable state store is logged loudly in its own right', () => {
  assert.match(SRC, /STATE STORE UNAVAILABLE/);
  assert.match(SRC, /stateStore=' \+ \(stateStored \? 'ok' : 'UNAVAILABLE'\)/,
    'it must be visible on healthy runs too, not only when something else breaks');
});

test('a healthy run is logged as well, so silence means "not running"', () => {
  assert.match(SRC, /console\.log\('\[monitor\] healthy/);
});

test('recovery messages are not claimed when the state cannot be trusted', () => {
  // Without a store, `down` is never truthfully remembered, so an "all clear"
  // would be invented.
  assert.match(SRC, /if \(state\.down && stateStored\) \{/);
});

test('it does not write state it could not read', () => {
  assert.match(SRC, /if \(stateStored\) await saveState\(state\);/);
});

test('the response reports the state-store status', () => {
  assert.match(SRC, /stateStore: stateStored \? 'ok' : 'unavailable'/);
});

test('the monitor still checks all three paths', () => {
  // Transport-only checks stayed green through a real outage where the model id
  // had been retired, which is why the AI check exists.
  assert.match(SRC, /checkVisitorToken\(host\), checkDashboardKey\(\), checkAiGeneration\(\)/);
});

// ── the visitor-token check must say WHAT came back ──
//
// The first useful log read: "visitorToken: token endpoint returned 401". But
// /api/ably-token contains exactly one 401 and it is on the agent branch, which
// a visitor-shaped request cannot reach. So a 401 there is somebody else
// answering — and a bare status code cannot tell you who.

test('a failing visitor-token check reports the URL it called', () => {
  assert.match(SRC, /' from ' \+ baseUrl/,
    'a self-call to the wrong host is a prime suspect; the log must name it');
});

test('it reports the response body, not just the status', () => {
  assert.match(SRC, /var peek = await r\.text\(\)/);
  assert.match(SRC, /\| body: '/);
});

test('the body is trimmed and bounded before it reaches the logs', () => {
  // An interception page is a whole HTML document.
  assert.match(SRC, /\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.slice\(0, 160\)/);
});

// ── the monitor must health-check the PUBLIC host ──
//
// It built its URL from req.headers.host. For a Vercel cron that is the
// immutable per-deployment URL, which sits behind Deployment Protection — so
// the self-call was answered by Vercel, not by us:
//
//   {"error":{"code":"401","message":"Protected deployment"},
//    "protection":{"vercel_auth_enabled":true,...}}
//
// Every run failed, for an address Vercel blocks by design, while real visitors
// on the public alias were fine.
//
// The dangerous part is not the noise. The monitor latches `down` after
// alerting, so a permanently-false alarm meant a GENUINE outage would have
// raised nothing — the watchdog had already used up its one bark.

test('the health check targets the public production host', () => {
  assert.match(SRC, /const PUBLIC_BASE = 'https:\/\/chat\.travelify\.io';/);
  assert.match(SRC, /var host = \(process\.env\.LUNA_BASE_URL \|\| PUBLIC_BASE\)/);
});

test('it NEVER derives the host from the incoming request', () => {
  // Comments are stripped: the note explaining this trap mentions the very
  // thing the code must not do.
  const code = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /req\.headers\['host'\]/,
    'a cron arrives on the per-deployment URL, which Vercel protects');
  assert.doesNotMatch(code, /req\.headers\.host/);
});

test('LUNA_BASE_URL can still override it', () => {
  // Needed to point the check at a staging deploy.
  assert.match(SRC, /process\.env\.LUNA_BASE_URL \|\| PUBLIC_BASE/);
});

test('the default host is one a real visitor actually uses', () => {
  // The old fallback was luna-chat-endpoint.vercel.app. Checking a host no
  // client is served from proves nothing about whether clients can chat.
  assert.match(SRC, /PUBLIC_BASE = 'https:\/\/chat\.travelify\.io'/);
  const at = SRC.indexOf('var host = (process.env.LUNA_BASE_URL');
  assert.doesNotMatch(SRC.slice(at, at + 200), /vercel\.app/);
});
