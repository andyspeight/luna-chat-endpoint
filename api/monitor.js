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
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (already set — strike state)
// Optional:
//   LUNA_BASE_URL  (override the base URL used for Check A; defaults to this host)

const TG_BASE = 'app6Ot3eOb3DangkB';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';
const STATE_KEY = 'monitor:luna:state';

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

async function loadState() {
  var res = await redisPipeline([['GET', STATE_KEY]]);
  if (!res || res[0] == null) return { fails: 0, down: false };
  try { return JSON.parse(res[0]); } catch (e) { return { fails: 0, down: false }; }
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
    if (!ok(r.status)) return { ok: false, detail: 'token endpoint returned ' + r.status };
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

  var host = (process.env.LUNA_BASE_URL || ('https://' + (req.headers['host'] || 'luna-chat-endpoint.vercel.app'))).replace(/\/$/, '');

  var a = await checkVisitorToken(host);
  var b = await checkDashboardKey();
  var healthy = a.ok && b.ok;

  var state = await loadState();
  var actions = [];

  if (healthy) {
    if (state.down) {
      await tgSend('✅ Luna Chat is back up.\n\nRecovered at ' + new Date().toUTCString() + '. Both the visitor token path and the dashboard connection are healthy again.');
      actions.push('sent recovery');
    }
    state = { fails: 0, down: false };
  } else {
    state.fails = (state.fails || 0) + 1;
    var reasons = [];
    if (!a.ok) reasons.push('• Visitor chat: ' + a.detail);
    if (!b.ok) reasons.push('• Agent dashboard: ' + b.detail);

    if (state.fails >= 2 && !state.down) {
      await tgSend(
        '🚨 Luna Chat appears DOWN.\n\n' +
        'Failed two checks in a row (about 15 minutes).\n\n' +
        reasons.join('\n') +
        '\n\nDashboard: chat.travelify.io/dashboard.html'
      );
      state.down = true;
      actions.push('sent down alert');
    } else if (state.fails < 2) {
      actions.push('first failure — holding alert until the next check confirms');
    }
  }

  await saveState(state);

  // Server-to-server response only; contains no secrets.
  return res.status(healthy ? 200 : 503).json({
    healthy: healthy,
    checks: {
      visitorToken: a.ok ? 'ok' : ('FAIL: ' + a.detail),
      dashboardKey: b.ok ? 'ok' : ('FAIL: ' + b.detail)
    },
    consecutiveFailures: state.fails,
    alerting: state.down,
    actions: actions,
    checkedAt: new Date().toISOString()
  });
};
