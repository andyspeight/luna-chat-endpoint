// api/visitor-recall.js
//
// Cross-device recall, behind a one-time code emailed to the address.
//
//   POST ?action=request  { clientName, email }         -> { ok: true }   ALWAYS
//   POST ?action=verify   { clientName, email, code }   -> { ok, found, name?, lastSeen?, count?, summary? }
//
// BACKGROUND. /api/visitor-history used to take an email and hand back that
// person's memory with nothing to prove the asker was them. clientName is
// public and the email was never verified, so it answered "has this person been
// talking to this travel agent, and what about" for anybody who asked. It was
// cut back to visitorId-only on 25 Aug 2026, which lost the feature: a visitor
// who chatted on their phone was a stranger on their laptop.
//
// This restores it by proving control of the address first. The rules that stop
// it becoming the same oracle are in lib/visitor-recall.js; the two that shape
// this file are:
//
//   - `request` returns an IDENTICAL response whether or not the address is
//     known. No count, no "sent", no timing tell worth the name. The only
//     signal is the mail itself, which reaches the real owner's inbox.
//   - a code is only ever mailed to an address that HAS chatted with this
//     client, so we cannot be pointed at strangers and used to post mail.
//
// Env: AIRTABLE_KEY, SENDGRID_API_KEY, Upstash (code store), and optionally
// LUNA_RECALL_SECRET.

const ratelimit = require('../lib/ratelimit');
const visitorName = require('../lib/visitor-name');
const auth = require('../lib/luna-auth');
const recall = require('../lib/visitor-recall');

const BASE = 'app6Ot3eOb3DangkB';
const TABLE = 'tblyin27D2J9ejHvf'; // Conversations
const F = {
  visitor:       'fldqx6k7WvrqE8BW1', // VisitorName
  email:         'fldZXcvl7k3FS5Gu7', // VisitorEmail
  summary:       'fldZ38GYN4XbHGl03', // Summary / running history
  lastMessageAt: 'fld1GghMiUnAmdtow', // LastMessageAt
  client:        'flde1PCByneD05YyG', // Client (link)
  topicTags:     'fldQNFhnyo3W2ngTZ'  // TopicTags
};

const ALLOWED_ORIGINS_ANY = '*'; // embeddable widget, no credentials sent

function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100
    && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}

function escFormula(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Every conversation this address has had with this client, newest first.
// The result NEVER reaches the caller of ?action=request — it only decides
// whether a code is worth mailing.
async function findConversations(atKey, clientRecId, email) {
  const formula = "LOWER({VisitorEmail})='" + escFormula(recall.normaliseEmail(email)) + "'";
  const url = 'https://api.airtable.com/v0/' + BASE + '/' + TABLE
    + '?filterByFormula=' + encodeURIComponent(formula)
    + '&maxRecords=50&returnFieldsByFieldId=true';
  const r = await fetch(url, {
    headers: { Authorization: 'Bearer ' + atKey },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error('Airtable search failed: ' + r.status);
  const d = await r.json();
  return (d.records || []).filter(function (rec) {
    const link = (rec.fields && rec.fields[F.client]) || [];
    return Array.isArray(link) && link.indexOf(clientRecId) !== -1;
  }).sort(function (a, b) {
    return new Date(b.fields[F.lastMessageAt] || 0) - new Date(a.fields[F.lastMessageAt] || 0);
  });
}

// Same compact shape /api/visitor-history returns: a name, when, how often and
// a short topic summary. Never a transcript, and never anything from another
// client.
function buildMemory(rows) {
  if (!rows.length) return { found: false };
  const recent = rows[0].fields;
  let name = '';
  for (let i = 0; i < rows.length && !name; i++) name = rows[i].fields[F.visitor] || '';

  const topics = [];
  rows.forEach(function (row) {
    const tags = row.fields[F.topicTags];
    if (Array.isArray(tags)) tags.forEach(function (t) {
      const n = (t && t.name) ? t.name : (typeof t === 'string' ? t : '');
      if (n && topics.indexOf(n) === -1) topics.push(n);
    });
  });

  const recentSummary = String(recent[F.summary] || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const parts = [];
  if (topics.length) parts.push("Topics they've discussed: " + topics.slice(0, 8).join(', '));
  if (recentSummary) parts.push('Most recent conversation: ' + recentSummary);

  return {
    found: true,
    name: visitorName.realName(name) || undefined,
    lastSeen: recent[F.lastMessageAt] || undefined,
    count: rows.length,
    summary: parts.join('. ') || undefined
  };
}

async function sendCodeEmail(clientName, email, code) {
  const sgKey = process.env.SENDGRID_API_KEY;
  if (!sgKey) { console.error('[visitor-recall] SENDGRID_API_KEY not configured'); return false; }
  let sgMail;
  try {
    sgMail = require('@sendgrid/mail');
  } catch (e) {
    console.error('[visitor-recall] @sendgrid/mail not installed:', e.message);
    return false;
  }
  sgMail.setApiKey(sgKey);

  const safeClient = String(clientName).replace(/[<>&"]/g, '');
  const text = 'Your code is ' + code + '\n\n'
    + 'Enter it in the chat to pick up where you left off with ' + safeClient + '.\n\n'
    + 'It expires in 10 minutes and can only be used once.\n\n'
    + 'If you did not ask for this, you can ignore this email. Nothing has changed.';
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;color:#0F172A">'
    + '<p>Your code is:</p>'
    + '<p style="font-size:30px;font-weight:700;letter-spacing:5px;margin:16px 0">' + code + '</p>'
    + '<p>Enter it in the chat to pick up where you left off with ' + safeClient + '.</p>'
    + '<p style="color:#64748B;font-size:14px">It expires in 10 minutes and can only be used once. '
    + 'If you did not ask for this, you can ignore this email. Nothing has changed.</p></div>';

  try {
    await sgMail.send({
      to: email,
      from: { name: safeClient || 'Luna', email: 'noreply@travelgenix.io' },
      subject: 'Your code: ' + code,
      text: text,
      html: html
    });
    return true;
  } catch (e) {
    console.error('[visitor-recall] send failed:', (e && e.message) || e);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS_ANY);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Service misconfigured' });

  const action = String((req.query && req.query.action) || '').trim();
  const body = req.body || {};
  const clientName = String(body.clientName || '').trim();
  const email = recall.normaliseEmail(body.email);

  if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });
  if (!recall.isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  const secret = recall.recallSecret();

  // ── request a code ───────────────────────────────────────────────────────
  if (action === 'request') {
    // Two limits. The per-IP one stops a machine walking an address list. The
    // per-address one stops us being used to flood one person's inbox — that
    // limit belongs to the RECIPIENT, not to the sender.
    const rl = await ratelimit.checkIpAndKey(req, {
      ipKey: 'recall-request', ipMax: 10, ipWindowSecs: 3600
    });
    const perEmail = await ratelimit.check(
      'rl:recall-request:email:' + recall.codeKey(secret, 'any', email), 3, 3600);
    // Note we do NOT tell the caller they were limited: a 429 here would be a
    // signal in itself. Fall through to the same answer as everyone else.
    const allowed = rl.allowed && perEmail.allowed;

    try {
      if (allowed) {
        const crec = await auth.resolveClientByName(atKey, clientName);
        if (crec) {
          const rows = await findConversations(atKey, crec.id, email);
          if (rows.length) {
            const code = recall.newCode();
            const key = recall.codeKey(secret, crec.id, email);
            await storeCode(key, recall.hashCode(secret, crec.id, email, code));
            const sent = await sendCodeEmail(clientName, email, code);
            console.log('[visitor-recall] code issued for client', crec.id, 'sent=' + sent);
          }
        }
      }
    } catch (e) {
      // Swallow. An upstream wobble must not change the shape of the answer,
      // because a different answer is exactly the leak this endpoint exists to
      // avoid. It is logged for us.
      console.error('[visitor-recall] request error:', (e && e.message) || e);
    }

    // IDENTICAL, always. Known address, unknown address, rate-limited, Airtable
    // down: one response.
    return res.status(200).json({ ok: true });
  }

  // ── verify a code ────────────────────────────────────────────────────────
  if (action === 'verify') {
    const code = String(body.code || '').trim();
    const rl = await ratelimit.checkIpAndKey(req, {
      ipKey: 'recall-verify', ipMax: 20, ipWindowSecs: 3600
    });
    if (!rl.allowed) return res.status(429).json({ ok: false, error: recall.GENERIC_FAILURE });
    if (!recall.isValidCode(code)) return res.status(400).json({ ok: false, error: recall.GENERIC_FAILURE });

    try {
      const crec = await auth.resolveClientByName(atKey, clientName);
      // Unknown client and wrong code look the same on the way out.
      if (!crec) return res.status(400).json({ ok: false, error: recall.GENERIC_FAILURE });

      const key = recall.codeKey(secret, crec.id, email);
      const stored = await readCode(key);
      if (!stored || !stored.hash) {
        return res.status(400).json({ ok: false, error: recall.GENERIC_FAILURE });
      }

      const attempts = await bumpAttempts(key);
      if (attempts > recall.MAX_ATTEMPTS) {
        await dropCode(key);
        return res.status(400).json({ ok: false, error: recall.GENERIC_FAILURE });
      }

      const supplied = recall.hashCode(secret, crec.id, email, code);
      if (!recall.codesMatch(stored.hash, supplied)) {
        return res.status(400).json({ ok: false, error: recall.GENERIC_FAILURE });
      }

      // Correct. Single use: burn it before answering, so a replay finds nothing.
      await dropCode(key);
      const rows = await findConversations(atKey, crec.id, email);
      const memory = buildMemory(rows);
      console.log('[visitor-recall] verified for client', crec.id, 'found=' + memory.found);
      return res.status(200).json(Object.assign({ ok: true }, memory));
    } catch (e) {
      console.error('[visitor-recall] verify error:', (e && e.message) || e);
      return res.status(500).json({ ok: false, error: 'Service unavailable' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
};

// ── code store (Upstash) ───────────────────────────────────────────────────
// Kept here rather than in the lib so the lib stays pure and unit-testable.

async function storeCode(key, hash) {
  await ratelimit.rawPipeline([
    ['SET', key, JSON.stringify({ hash: hash }), 'EX', String(recall.CODE_TTL_SECS)],
    ['DEL', key + ':n']
  ]);
}

async function readCode(key) {
  const raw = await ratelimit.rawSingle(['GET', key]);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

async function bumpAttempts(key) {
  const r = await ratelimit.rawPipeline([
    ['INCR', key + ':n'],
    ['EXPIRE', key + ':n', String(recall.CODE_TTL_SECS), 'NX']
  ]);
  const n = r && r[0] && parseInt(r[0].result, 10);
  return isNaN(n) ? 1 : n;
}

async function dropCode(key) {
  await ratelimit.rawPipeline([['DEL', key], ['DEL', key + ':n']]);
}
