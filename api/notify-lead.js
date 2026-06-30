// api/notify-lead.js
// ───────────────────────────────────────────────────────────────────────────
// Emails the client when a website visitor leaves a message / becomes a lead,
// so out-of-hours enquiries aren't missed when no agent is watching the
// dashboard. Today the only notifications are in-dashboard (sound / desktop /
// title-flash), which require an agent to have the dashboard open; this closes
// that gap with a direct email to the client's ContactEmail.
//
// Called fire-and-forget by the widget (e.g. from the "leave a message" form).
// It must NEVER break the visitor's experience, so it always returns 200 and
// degrades to a no-op when email or a recipient isn't configured.
//
// Env: AIRTABLE_KEY, SENDGRID_API_KEY.
//   Optional: LEAD_NOTIFY_FROM (default REVIEW_DIGEST_FROM / noreply@travelgenix.io)

const ratelimit = require('../lib/ratelimit');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_CLIENTS = 'tbl6CZ7aVzq1wHF2v';
const FROM_EMAIL = process.env.LEAD_NOTIFY_FROM || process.env.REVIEW_DIGEST_FROM || 'noreply@travelgenix.io';
const DEFAULT_DASHBOARD = 'https://chat.travelify.io/dashboard.html';
const MAX = { name: 120, email: 200, message: 4000, page: 500 };

function clip(s, n) { return String(s == null ? '' : s).slice(0, n); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function safeHttpUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }
function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // embeddable widget; no credentials
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Modest rate limit — fires on human escalation / leave-a-message, not per message.
  try {
    var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'notify-lead', ipMax: 10, ipWindowSecs: 60 });
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });
  } catch (e) { /* limiter unavailable — fail open; this isn't security-critical */ }

  var body = req.body || {};
  var clientName = clip(body.clientName, 100).trim();
  var name = clip(body.name, MAX.name).trim();
  var email = clip(body.email, MAX.email).trim();
  var message = clip(body.message, MAX.message).trim();
  var page = safeHttpUrl(clip(body.page, MAX.page).trim());
  var type = body.type === 'left_message' ? 'left_message' : 'lead';

  if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });
  if (email && !isEmail(email)) email = '';        // ignore malformed; still notify with the message
  if (!email && !message) return res.status(400).json({ error: 'Nothing to notify' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(200).json({ ok: true, sent: false, reason: 'airtable not configured' });

  try {
    // Resolve the client's notification recipient (ContactEmail) by name.
    var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_CLIENTS
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var r = await fetch(url, { headers: { Authorization: 'Bearer ' + atKey } });
    var d = await r.json();
    if (!d.records || !d.records.length) return res.status(200).json({ ok: true, sent: false, reason: 'client not found' });

    var f = d.records[0].fields || {};
    var to = (f.ContactEmail || '').trim();
    if (!to || !isEmail(to)) return res.status(200).json({ ok: true, sent: false, reason: 'no ContactEmail set for client' });
    var dash = safeHttpUrl((f.DashboardURL || '').trim()) || DEFAULT_DASHBOARD;

    var sgKey = process.env.SENDGRID_API_KEY;
    if (!sgKey) return res.status(200).json({ ok: true, sent: false, reason: 'email not configured' });
    var sgMail;
    try { sgMail = require('@sendgrid/mail'); }
    catch (e) { return res.status(200).json({ ok: true, sent: false, reason: 'sendgrid not installed' }); }
    sgMail.setApiKey(sgKey);

    var who = name || 'A website visitor';
    var heading = type === 'left_message' ? 'Someone left you a message' : 'New enquiry from your website';
    var subHead = type === 'left_message'
      ? 'Captured by Luna while no agent was online.'
      : 'Captured by Luna on your website chat.';
    var subject = (type === 'left_message' ? 'New message from ' : 'New enquiry from ') + who + ' via your website chat';

    var rows = [];
    if (name) rows.push(['Name', esc(name)]);
    if (email) rows.push(['Email', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>']);
    if (page) rows.push(['Page', '<a href="' + esc(page) + '">' + esc(page) + '</a>']);

    var html = ''
      + '<div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0F1A3D">'
      +   '<h2 style="margin:0 0 4px;font-size:20px">' + esc(heading) + '</h2>'
      +   '<p style="color:#5A6B86;margin:0 0 16px;font-size:14px">' + esc(subHead) + '</p>'
      +   (rows.length
            ? '<table style="border-collapse:collapse;margin-bottom:16px">'
              + rows.map(function (kv) {
                  return '<tr><td style="padding:4px 16px 4px 0;color:#8A93A8;font-size:13px;vertical-align:top">'
                    + kv[0] + '</td><td style="padding:4px 0;font-size:14px">' + kv[1] + '</td></tr>';
                }).join('')
              + '</table>'
            : '')
      +   (message
            ? '<div style="background:#F4F6FB;border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.5;white-space:pre-wrap">'
              + esc(message) + '</div>'
            : '')
      +   '<p style="margin:20px 0 0"><a href="' + esc(dash)
      +     '" style="display:inline-block;background:#0F1A3D;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">Open your dashboard</a></p>'
      +   (email
            ? '<p style="color:#8A93A8;font-size:12.5px;margin-top:14px">Tip: just reply to this email to respond to '
              + esc(name || 'them') + ' directly.</p>'
            : '')
      + '</div>';

    var lines = [type === 'left_message' ? 'Someone left you a message via your website chat.' : 'New enquiry from your website chat.', ''];
    if (name) lines.push('Name: ' + name);
    if (email) lines.push('Email: ' + email);
    if (page) lines.push('Page: ' + page);
    if (message) { lines.push('', 'Message:', message); }
    lines.push('', 'Open your dashboard: ' + dash);
    var text = lines.join('\n');

    var msg = {
      to: to,
      from: { name: 'Luna', email: FROM_EMAIL },
      subject: subject,
      text: text,
      html: html,
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['lead-notification']
    };
    if (email) msg.replyTo = email; // client can reply straight to the visitor

    await sgMail.send(msg);
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.warn('[notify-lead] error:', e.message);
    // Never break the widget UX on a notification failure.
    return res.status(200).json({ ok: true, sent: false, reason: 'send_failed' });
  }
};
