// api/knowledge-freshness.js
// Luna Knowledge freshness digest.
//
// Runs on a daily Vercel cron. It scans every Active Knowledge item across all
// clients, classifies each by how long it has gone without a human re-check
// (see lib/freshness.js), and sends a short Telegram digest when items are due
// for review. It is ADVISORY only: it reads Airtable and never writes, and it
// never touches what Luna retrieves or says. The owner acts on it from Luna
// Brain via the one-tap "Mark verified" button.
//
// Anti-spam: state is held in Upstash Redis (same pattern as api/monitor.js).
// We only send when something is actually due, and we stay quiet day-to-day
// unless the overdue/review counts grow or a week has passed since the last
// nudge. So a steady backlog produces at most a weekly reminder, not a daily one.
//
// Security: cron-only. Requires CRON_SECRET (Vercel injects it as a Bearer token
// on cron invocations). Manual runs need ?secret=<CRON_SECRET>. Add ?dryRun=1 to
// compute and RETURN the digest as JSON without sending Telegram (safe to call
// in production for smoke testing).
//
// Required env: CRON_SECRET, AIRTABLE_KEY.
// Optional env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (alert delivery),
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (anti-spam state),
//   LUNA_FRESHNESS_REVIEW_DAYS, LUNA_FRESHNESS_OVERDUE_DAYS (tune windows).

'use strict';

const freshness = require('../lib/freshness');

const AT_BASE = 'app6Ot3eOb3DangkB';
const KNOWLEDGE_TABLE = 'tblstATJ3BSqtuTDU';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';
const STATE_KEY = 'freshness:digest:state';
const REMINDER_DAYS = 7; // weekly nudge cadence when a backlog persists unchanged

// ─── small helpers (mirror api/monitor.js) ──────────────────────────────────

async function tgSend(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.warn('[freshness] Telegram not configured; skipping send');
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
    console.error('[freshness] Telegram send failed:', e.message);
    return false;
  }
}

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
    console.warn('[freshness] Redis call failed:', e.message);
    return null;
  }
}

async function loadState() {
  var res = await redisPipeline([['GET', STATE_KEY]]);
  if (!res || res[0] == null) return { lastSentAt: null, lastOverdue: 0, lastReviewDue: 0 };
  try { return JSON.parse(res[0]); } catch (e) { return { lastSentAt: null, lastOverdue: 0, lastReviewDue: 0 }; }
}

async function saveState(state) {
  await redisPipeline([['SET', STATE_KEY, JSON.stringify(state)]]);
}

// ─── Airtable reads (no writes anywhere in this endpoint) ────────────────────

async function atGet(path) {
  var atKey = process.env.AIRTABLE_KEY;
  var r = await fetch('https://api.airtable.com/v0/' + AT_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + atKey },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('Airtable ' + r.status);
  return r.json();
}

// id -> ClientName, so the digest can name the agency an item belongs to.
async function loadClientNames() {
  var map = {};
  try {
    var data = await atGet('/' + CLIENTS_TABLE + '?fields%5B%5D=ClientName&maxRecords=500');
    (data.records || []).forEach(function (rec) {
      map[rec.id] = (rec.fields && rec.fields.ClientName) || '';
    });
  } catch (e) {
    console.warn('[freshness] client name load failed:', e.message);
  }
  return map;
}

// Fetch all Active knowledge, paging through Airtable's 100-record windows.
async function loadActiveKnowledge() {
  var items = [];
  var offset = null;
  var pages = 0;
  do {
    var path = '/' + KNOWLEDGE_TABLE
      + '?filterByFormula=' + encodeURIComponent("{Status} = 'Active'")
      + '&fields%5B%5D=Question&fields%5B%5D=Type&fields%5B%5D=LastVerifiedAt&fields%5B%5D=Client'
      + '&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atGet(path);
    (data.records || []).forEach(function (rec) {
      var f = rec.fields || {};
      var clientLink = Array.isArray(f.Client) && f.Client.length
        ? (typeof f.Client[0] === 'object' ? f.Client[0].id : f.Client[0])
        : null;
      items.push({
        id: rec.id,
        question: f.Question || '',
        type: typeof f.Type === 'object' ? (f.Type && f.Type.name) : (f.Type || ''),
        lastVerifiedAt: f.LastVerifiedAt || null,
        createdTime: rec.createdTime || null,
        clientId: clientLink
      });
    });
    offset = data.offset || null;
    pages++;
  } while (offset && pages < 20); // hard cap: 2000 items
  return items;
}

// ─── digest building (pure, unit-testable) ──────────────────────────────────

// Compose the digest from classified items. Returns counts, the most urgent
// items, and the message text (or null text when nothing is due).
function buildDigest(items, clientNameById, now, opts) {
  clientNameById = clientNameById || {};
  var counts = freshness.summarise(items, now, opts);
  var stale = freshness.selectStale(items, now, opts);

  var topOverdue = stale.slice(0, 8).map(function (it) {
    return {
      id: it.id,
      question: it.question,
      type: it.type,
      ageDays: it.ageDays,
      state: it.freshnessState,
      client: clientNameById[it.clientId] || 'Unknown client'
    };
  });

  var text = null;
  if (counts.stale > 0) {
    var lines = [];
    lines.push('Luna knowledge review');
    lines.push('');
    lines.push(counts.overdue + ' overdue, ' + counts.review_due + ' due for review, across ' + items.length + ' active answers.');
    lines.push('');
    topOverdue.forEach(function (it) {
      var tag = it.state === 'overdue' ? 'OVERDUE' : 'due';
      lines.push('- [' + tag + ' ' + it.ageDays + 'd] ' + it.client + ': ' + it.question);
    });
    if (stale.length > topOverdue.length) {
      lines.push('');
      lines.push('and ' + (stale.length - topOverdue.length) + ' more.');
    }
    lines.push('');
    lines.push('Review and mark verified in Luna Brain.');
    text = lines.join('\n');
  }

  return { counts: counts, topOverdue: topOverdue, staleTotal: stale.length, text: text };
}

// Decide whether to actually send, given prior state. Keeps a persistent backlog
// to a weekly reminder rather than a daily nag. Pure, unit-testable.
function shouldSend(digest, state, now) {
  if (!digest.text) return false;                 // nothing due
  var overdue = digest.counts.overdue;
  var reviewDue = digest.counts.review_due;
  if (overdue > (state.lastOverdue || 0)) return true;       // backlog grew (overdue)
  if (reviewDue > (state.lastReviewDue || 0)) return true;   // backlog grew (review)
  if (!state.lastSentAt) return true;                        // never sent before
  var days = (now.getTime() - Date.parse(state.lastSentAt)) / 86400000;
  return days >= REMINDER_DAYS;                              // weekly reminder
}

// ─── global base freshness ───────────────────────────────────────────────────
// The shared knowledge base (appPKx77relfeiqmq) powers Luna and the widgets for
// every client, so its staleness matters most. We scan the three unified tables
// the widgets search. Global data is re-checked more often than per-client.
var GLOBAL_BASE = 'appPKx77relfeiqmq';
var GLOBAL_TABLES = [
  { id: 'tblgdLszaPmquxQ7O', name: 'Knowledge' },
  { id: 'tblirr0vJuQcTLuH2', name: 'Destinations' },
  { id: 'tbl8CRDV48QGjDx2a', name: 'Transport' }
];
var GLOBAL_REVIEW_DAYS = parseInt(process.env.LUNA_GLOBAL_REVIEW_DAYS || '90', 10);
var GLOBAL_OVERDUE_DAYS = parseInt(process.env.LUNA_GLOBAL_OVERDUE_DAYS || '180', 10);

async function atGetGlobal(path) {
  var r = await fetch('https://api.airtable.com/v0/' + GLOBAL_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('Airtable ' + r.status);
  return r.json();
}

async function scanGlobal(now) {
  var opts = { reviewDays: GLOBAL_REVIEW_DAYS, overdueDays: GLOBAL_OVERDUE_DAYS };
  var out = [];
  for (var t = 0; t < GLOBAL_TABLES.length; t++) {
    var items = [], offset = null, pages = 0;
    do {
      var path = '/' + GLOBAL_TABLES[t].id + '?fields%5B%5D=Last%20Verified&pageSize=100';
      if (offset) path += '&offset=' + encodeURIComponent(offset);
      var data;
      try { data = await atGetGlobal(path); } catch (e) { data = { records: [] }; }
      (data.records || []).forEach(function (r) {
        items.push({ lastVerifiedAt: (r.fields && r.fields['Last Verified']) || null, createdTime: r.createdTime });
      });
      offset = data.offset || null; pages++;
    } while (offset && pages < 12);
    var counts = freshness.summarise(items, now, opts);
    var stats = freshness.ageStats(items, now);
    out.push({ table: GLOBAL_TABLES[t].name, total: items.length, reviewDue: counts.stale, overdue: counts.overdue, oldestDays: stats.oldestDays, avgDays: stats.avgDays });
  }
  return out;
}

// One-line digest of the global scan, plus a totalStale used to decide sending.
function globalDigest(globalScan) {
  if (!globalScan || !globalScan.length) return { totalStale: 0, line: null };
  var totalStale = globalScan.reduce(function (s, t) { return s + (t.reviewDue || 0); }, 0);
  var line = 'Global knowledge base: ' + globalScan.map(function (t) {
    return t.table + ' ' + t.total + ' (' + (t.oldestDays != null ? t.oldestDays + 'd oldest' : 'no dates') + ', ' + (t.reviewDue || 0) + ' due)';
  }).join('; ') + '.';
  return { totalStale: totalStale, line: line };
}

// ─── handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  var authed = secret && (auth === 'Bearer ' + secret || qSecret === secret);
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.AIRTABLE_KEY) {
    return res.status(500).json({ error: 'AIRTABLE_KEY not configured' });
  }

  var opts = {
    reviewDays: process.env.LUNA_FRESHNESS_REVIEW_DAYS ? parseInt(process.env.LUNA_FRESHNESS_REVIEW_DAYS, 10) : undefined,
    overdueDays: process.env.LUNA_FRESHNESS_OVERDUE_DAYS ? parseInt(process.env.LUNA_FRESHNESS_OVERDUE_DAYS, 10) : undefined
  };

  var now = new Date();
  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    var results = await Promise.all([loadActiveKnowledge(), loadClientNames()]);
    var items = results[0];
    var clientNames = results[1];

    var digest = buildDigest(items, clientNames, now, opts);

    // Global base freshness (the shared brain). Append its line to the digest
    // when something there is past review so the same alert covers both.
    var globalScan = await scanGlobal(now);
    var gd = globalDigest(globalScan);
    if (gd.totalStale > 0) {
      digest.text = (digest.text ? digest.text + '\n\n' : 'Luna knowledge review\n\n') + gd.line + '\n\nReview in the global knowledge screen.';
    }

    if (dryRun) {
      return res.status(200).json({
        dryRun: true,
        perClient: { activeKnowledge: items.length, counts: digest.counts, topOverdue: digest.topOverdue },
        global: globalScan,
        wouldSend: !!digest.text,
        message: digest.text
      });
    }

    var state = await loadState();
    var send = shouldSend(digest, state, now);
    var sent = false;
    if (send) {
      sent = await tgSend(digest.text);
      await saveState({
        lastSentAt: now.toISOString(),
        lastOverdue: digest.counts.overdue,
        lastReviewDue: digest.counts.review_due
      });
    }

    return res.status(200).json({
      activeKnowledge: items.length,
      counts: digest.counts,
      global: globalScan,
      sent: sent,
      checkedAt: now.toISOString()
    });
  } catch (e) {
    console.error('[freshness] run failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exposed for unit testing only; does not affect the Vercel handler contract.
module.exports.buildDigest = buildDigest;
module.exports.shouldSend = shouldSend;
