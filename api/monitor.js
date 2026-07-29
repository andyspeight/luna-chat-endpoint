// api/monitor.js
// Luna Chat heartbeat monitor.
//
// Runs on a Vercel cron every 15 minutes. It verifies the two things that broke
// on 1 June 2026, so a silent outage can never go unnoticed again:
//
//   Check A — Visitor path: POST our own /api/ably-token exactly like a visitor
//             widget does. Catches a broken rate limiter (429 storm) or a dead
//             server signing key.
//   Check B — Dashboard path: read the Travelgenix dashboard's own Ably key from
//             Airtable (the same value auth-session serves to the browser) and
//             authenticate it directly against Ably. Catches a revoked/dead
//             dashboard key — the exact failure that took the dashboard down.
//   Check C — AI path: make a tiny real Anthropic call against EACH distinct
//             model Luna uses (same resolution as api/luna-chat.js). Catches a
//             retired/renamed model id, a bad API key, or an Anthropic outage —
//             the exact failure on 23 June 2026, which A and B both missed
//             because they only cover the realtime transport, not generation.
//
// Alerting policy (no crying wolf):
//   - Only alerts after TWO consecutive failed runs (~a 15-minute real outage).
//   - Sends a single "down" message, then stays quiet until recovery.
//   - Sends one "recovered" message when healthy again.
//   - State is held in Upstash Redis so "two in a row" survives between runs.
//
// Security:
//   - Cron-only. Requires CRON_SECRET (Vercel injects it as a Bearer token on
//     cron invocations). Manual runs need ?secret=<CRON_SECRET>.
//   - All secrets are server-side env vars. Nothing is returned to any browser.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (alert delivery)
//   CRON_SECRET                            (protects this endpoint)
//   AIRTABLE_KEY                           (already set — reads the dashboard key)
//   ANTHROPIC_API_KEY                      (already set — Check C calls the model)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (already set — strike state)
// Optional:
//   LUNA_BASE_URL  (override the base URL used for Check A; defaults to the
//                  PUBLIC production host — never the per-deployment URL)

const TG_BASE = 'app6Ot3eOb3DangkB';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';
const STATE_KEY = 'monitor:luna:state';

// The PUBLIC host to health-check, and never req.headers.host.
//
// A Vercel cron invokes the function on its immutable per-deployment URL
// (luna-chat-endpoint-<hash>-agendasgroup.vercel.app). Those URLs sit behind
// Vercel Deployment Protection, so a self-call to them is answered by Vercel,
// not by us:
//
//   {"error":{"code":"401","message":"Protected deployment"},
//    "protection":{"vercel_auth_enabled":true,...}}
//
// The visitor-token check therefore failed on every single run — it was testing
// an address Vercel blocks by design, while real visitors on the public alias
// were completely fine. Six hours of "Luna Chat appears DOWN" with nothing
// actually wrong.
//
// Worse than the noise: the monitor latches `down` after alerting, so a
// permanently-false alarm meant a REAL outage would have raised nothing at all.
// The watchdog was not just crying wolf, it had already used up its one bark.
const PUBLIC_BASE = 'https://chat.travelify.io';

// ─── small helpers ───────────────────────────────────────────────────────────

function ok(status) { return status >= 200 && status < 300; }

async function tgSend(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.warn('[monitor] Telegram not configured; skipping send');
    return false;
  }
  try {
    var r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    return r.ok;
  } catch (e) {
    console.error('[monitor] Telegram send failed:', e.message);
    return false;
  }
}

// Upstash Redis via the same REST pipeline pattern used by lib/ratelimit.js.
async function redisPipeline(commands) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  try {
    var r = await fetch(url + '/pipeline', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3000)
    });
    if (!r.ok) return null;
    var data = await r.json();
    if (!Array.isArray(data)) return null;
    return data.map(function (i) { return (i && typeof i === 'object' && 'result' in i) ? i.result : i; });
  } catch (e) {
    console.warn('[monitor] Redis call failed:', e.message);
    return null;
  }
}

// Returns the saved state AND whether the store was actually reachable.
//
// This distinction is the whole ballgame. The alert only fires on the SECOND
// consecutive failure, and the counter lives in Redis. With no Redis configured
// every run read `fails: 0`, incremented to 1, and never reached 2 — so the
// monitor could fail every fifteen minutes, for days, and never once tell
// anyone. It did exactly that: 24 consecutive failures with no alert.
//
// A watchdog that fails silently is worse than no watchdog, because it also
// tells you everything is fine.
async function loadState() {
  var res = await redisPipeline([['GET', STATE_KEY]]);
  if (res === null) return { state: { fails: 0, down: false }, stored: false };
  if (res[0] == null) return { state: { fails: 0, down: false }, stored: true };
  try { return { state: JSON.parse(res[0]), stored: true }; }
  catch (e) { return { state: { fails: 0, down: false }, stored: true }; }
}

async function saveState(state) {
  await redisPipeline([['SET', STATE_KEY, JSON.stringify(state)]]);
}

// ─── the two checks ──────────────────────────────────────────────────────────

// Check A: behave like a visitor widget and ask our token endpoint for a token.
async function checkVisitorToken(baseUrl) {
  var convId = 'conv_' + Date.now() + '_mon' + Math.random().toString(36).slice(2, 6);
  try {
    var r = await fetch(baseUrl + '/api/ably-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convId: convId, clientName: 'Travelgenix' }),
      signal: AbortSignal.timeout(8000)
    });
    if (r.status === 429) return { ok: false, detail: 'token endpoint rate-limited (429) — limiter may be stuck' };
    if (!ok(r.status)) {
      // Say WHAT came back, not just the number. /api/ably-token has exactly one
      // 401 in it and that is on the agent branch, which this visitor-shaped
      // request cannot reach — so a 401 here is somebody else answering, most
      // likely Vercel Deployment Protection intercepting a call the function
      // makes to its own host. The body settles it: our errors are JSON, an
      // intercept is an HTML challenge page.
      var peek = await r.text().catch(function () { return '(unreadable)'; });
      peek = String(peek).replace(/\s+/g, ' ').trim().slice(0, 160);
      return {
        ok: false,
        detail: 'token endpoint returned ' + r.status
          + ' from ' + baseUrl
          + ' | body: ' + (peek || '(empty)')
      };
    }
    var body = await r.json().catch(function () { return {}; });
    if (!body || !body.token) return { ok: false, detail: 'token endpoint 200 but no token in response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: 'token endpoint unreachable: ' + e.message };
  }
}

// Check B: read the dashboard's Ably key from Airtable and authenticate it
// directly against Ably (mirrors the dashboard's own credential).
async function checkDashboardKey() {
  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return { ok: false, detail: 'AIRTABLE_KEY not configured (cannot read dashboard key)' };

  var ablyKey;
  try {
    var url = 'https://api.airtable.com/v0/' + TG_BASE + '/' + CLIENTS_TABLE
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='travelgenix'")
      + '&maxRecords=1&fields%5B%5D=AblyKey';
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey }, signal: AbortSignal.timeout(8000) });
    if (!ok(r.status)) return { ok: false, detail: 'could not read dashboard key from Airtable (' + r.status + ')' };
    var data = await r.json();
    ablyKey = data.records && data.records[0] && data.records[0].fields && data.records[0].fields.AblyKey;
    if (!ablyKey) return { ok: false, detail: 'dashboard Ably key missing from the Travelgenix record' };
  } catch (e) {
    return { ok: false, detail: 'Airtable read failed: ' + e.message };
  }

  // Authenticate the key against Ably by requesting a short token with it.
  try {
    var keyName = String(ablyKey).split(':')[0];
    var tokenUrl = 'https://rest.ably.io/keys/' + encodeURIComponent(keyName) + '/requestToken';
    var ar = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(ablyKey).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ keyName: keyName, ttl: 60000, timestamp: Date.now() }),
      signal: AbortSignal.timeout(8000)
    });
    if (ar.status === 401) return { ok: false, detail: 'dashboard key REJECTED by Ably (401 — revoked or invalid)' };
    if (!ok(ar.status)) return { ok: false, detail: 'Ably returned ' + ar.status + ' for the dashboard key' };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: 'Ably auth check failed: ' + e.message };
  }
}

// Check C: exercise the actual AI generation path. Checks A and B only cover the
// realtime transport — they stayed GREEN throughout the 23 June outage when the
// configured model id had been retired and every reply 404'd. We mirror the model
// resolution in api/luna-chat.js and make a tiny real call against each DISTINCT
// model, so a retired/renamed model, a rejected API key, or an Anthropic outage
// trips the alert within ~15 minutes instead of going unnoticed for days.
async function checkAiGeneration() {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, detail: 'ANTHROPIC_API_KEY not configured' };

  // Same env vars + defaults luna-chat.js uses. Dedupe so we make the fewest
  // calls (short and haiku share a default).
  var models = [
    process.env.LUNA_MODEL || 'claude-sonnet-4-6',
    process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
    process.env.LUNA_SHORT_MODEL || 'claude-haiku-4-5-20251001'
  ].filter(function (m, i, arr) { return arr.indexOf(m) === i; });

  async function ping(model) {
    try {
      var r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(8000)
      });
      if (r.status === 404) return { ok: false, detail: model + ' → 404 not_found (model retired or renamed)' };
      if (r.status === 401) return { ok: false, detail: 'Anthropic rejected the API key (401)' };
      if (!ok(r.status)) return { ok: false, detail: model + ' → Anthropic returned ' + r.status };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: model + ' unreachable: ' + e.message };
    }
  }

  var results = await Promise.all(models.map(ping));
  var bad = results.filter(function (x) { return !x.ok; });
  if (bad.length) return { ok: false, detail: bad.map(function (x) { return x.detail; }).join('; ') };
  return { ok: true };
}

// ─── handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Auth: Vercel cron sends "Authorization: Bearer <CRON_SECRET>". Manual runs
  // may pass ?secret=<CRON_SECRET>. Anything else is denied.
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  var authed = secret && (auth === 'Bearer ' + secret || qSecret === secret);
  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Manual test hook: ?test=alert sends a one-off Telegram so wiring can be
  // confirmed without waiting for a real outage.
  if (req.query && req.query.test === 'alert') {
    var sent = await tgSend('🔔 Luna Monitor test alert. Wiring is good — this is the message you would get if the chat went down.');
    return res.status(200).json({ test: 'alert', telegramSent: sent });
  }

  var host = (process.env.LUNA_BASE_URL || PUBLIC_BASE).replace(/\/$/, '');

  // Run the three checks in parallel so the function stays well within its
  // 15s budget even when a check has to wait out its own timeout.
  var checks = await Promise.all([checkVisitorToken(host), checkDashboardKey(), checkAiGeneration()]);
  var a = checks[0], b = checks[1], c = checks[2];
  var healthy = a.ok && b.ok && c.ok;

  var loaded = await loadState();
  var state = loaded.state;
  var stateStored = loaded.stored;
  var actions = [];

  // ALWAYS log the outcome. The detail used to exist only in the HTTP response
  // body, which nothing reads — so a failing monitor was undiagnosable without
  // the cron secret. The logs now say which check broke and why.
  if (!healthy) {
    console.error('[monitor] UNHEALTHY'
      + ' | visitorToken: ' + (a.ok ? 'ok' : a.detail)
      + ' | dashboardKey: ' + (b.ok ? 'ok' : b.detail)
      + ' | aiGeneration: ' + (c.ok ? 'ok' : c.detail)
      + ' | stateStore=' + (stateStored ? 'ok' : 'UNAVAILABLE'));
  } else {
    console.log('[monitor] healthy | stateStore=' + (stateStored ? 'ok' : 'UNAVAILABLE'));
  }
  if (!stateStored) {
    console.error('[monitor] STATE STORE UNAVAILABLE (UPSTASH_REDIS_REST_* not set or unreachable). '
      + 'Falling back to alerting on the FIRST failure, because the two-in-a-row counter cannot persist. '
      + 'Expect a repeat alert every 15 minutes until the outage is fixed.');
  }

  if (healthy) {
    if (state.down && stateStored) {
      await tgSend('✅ Luna Chat is back up.\n\nRecovered at ' + new Date().toUTCString() + '. The visitor token path, the dashboard connection, and AI replies are all healthy again.');
      actions.push('sent recovery');
    }
    state = { fails: 0, down: false };
  } else {
    state.fails = (state.fails || 0) + 1;
    var reasons = [];
    if (!a.ok) reasons.push('• Visitor chat: ' + a.detail);
    if (!b.ok) reasons.push('• Agent dashboard: ' + b.detail);
    if (!c.ok) reasons.push('• AI replies: ' + c.detail);

    // Two-in-a-row suppresses a blip. That is only possible when the counter can
    // persist; without a state store, holding back the alert means never sending
    // it at all. A repeated alert is an annoyance, silence is an outage nobody
    // hears about.
    var shouldAlert = stateStored ? (state.fails >= 2 && !state.down) : true;

    if (shouldAlert) {
      await tgSend(
        '🚨 Luna Chat appears DOWN.\n\n' +
        (stateStored
          ? 'Failed two checks in a row (about 15 minutes).\n\n'
          : 'Failing health checks.\n\n') +
        reasons.join('\n') +
        (stateStored ? '' :
          '\n\n(No alert state store configured, so this will repeat every 15 minutes '
          + 'until it is fixed. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN '
          + 'to get one alert per outage instead.)') +
        '\n\nDashboard: chat.travelify.io/dashboard.html'
      );
      state.down = true;
      actions.push(stateStored ? 'sent down alert' : 'sent down alert (no state store — will repeat)');
    } else {
      actions.push('first failure — holding alert until the next check confirms');
    }
  }

  if (stateStored) await saveState(state);

  // Server-to-server response only; contains no secrets.
  return res.status(healthy ? 200 : 503).json({
    healthy: healthy,
    checks: {
      visitorToken: a.ok ? 'ok' : ('FAIL: ' + a.detail),
      dashboardKey: b.ok ? 'ok' : ('FAIL: ' + b.detail),
      aiGeneration: c.ok ? 'ok' : ('FAIL: ' + c.detail)
    },
    consecutiveFailures: state.fails,
    alerting: state.down,
    stateStore: stateStored ? 'ok' : 'unavailable',
    actions: actions,
    checkedAt: new Date().toISOString()
  });
};
