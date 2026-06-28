// api/review-digest.js
// Daily review digest — emails the knowledge owner a short summary of everything
// waiting in the two review queues, with a one-click link to the dashboard.
//
// It reads (never writes) the global base and counts:
//   1. Suggested Knowledge (Status=Pending)  — discovery suggestions to approve.
//   2. Knowledge Reverification (Status=Pending) — re-verification verdicts,
//      split into "needs a decision" (changed) vs "flagged for a manual look"
//      (unverifiable / source_unreachable) vs "confirm to refresh" (confirmed).
// Then it sends a clean HTML email via SendGrid (same authenticated sender as the
// chat-transcript email) so the owner can skim and act in seconds.
//
// Sends EVERY day by default — including a short "all clear" when nothing is
// pending — so it doubles as a heartbeat that the overnight jobs ran. Set
// DIGEST_SKIP_WHEN_EMPTY=1 to suppress the all-clear and only email when there
// is something to review.
//
// Security: cron-only. CRON_SECRET as Bearer or ?secret=. ?dryRun=1 builds the
// digest and returns it as JSON WITHOUT sending. ?force=1 always sends.
//
// Env: CRON_SECRET, AIRTABLE_KEY, SENDGRID_API_KEY.
//   Optional: REVIEW_DIGEST_TO (recipient, default andy.speight@agendas.group),
//             REVIEW_DIGEST_FROM (default noreply@travelgenix.io),
//             REVIEW_DASHBOARD_URL (default the live global-brain page),
//             DIGEST_SKIP_WHEN_EMPTY=1 (skip the daily all-clear when nothing pending).

'use strict';

const gk = require('../lib/global-knowledge');

const DEFAULT_TO = process.env.REVIEW_DIGEST_TO || 'andy.speight@agendas.group';
const FROM_EMAIL = process.env.REVIEW_DIGEST_FROM || 'noreply@travelgenix.io';
const DASHBOARD_URL = process.env.REVIEW_DASHBOARD_URL || 'https://luna-chat-endpoint.vercel.app/global-brain.html';
const MAX_SAMPLE = 12; // most-recent items to list per section

const VERDICT_LABEL = {
  confirmed: 'Confirmed by source',
  changed: 'Source-grounded correction',
  unverifiable: 'Source did not cover it',
  source_unreachable: 'Source unreachable'
};

async function atFetch(path) {
  var r = await fetch('https://api.airtable.com/v0/' + gk.GLOBAL_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) {
    var e = await r.json().catch(function () { return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((e.error && e.error.message) || 'unknown'));
  }
  return r.json();
}

function valueOf(field) { return (field && typeof field === 'object' && field.name) ? field.name : (field || ''); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Page through every Pending row in a table (capped so a runaway table can never
// blow the function budget). Returns the raw records.
async function loadPending(table, cap) {
  cap = cap || 2000;
  var items = [], offset = null, pages = 0;
  do {
    var path = '/' + table + '?filterByFormula=' + encodeURIComponent("{Status}='Pending'") + '&pageSize=100';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    var data = await atFetch(path);
    (data.records || []).forEach(function (r) { items.push(r); });
    offset = data.offset || null; pages++;
  } while (offset && items.length < cap && pages < 25);
  return items;
}

// Tally occurrences of a key across records, returning a sorted [label,count] list.
function tally(records, getKey) {
  var counts = {};
  records.forEach(function (r) {
    var k = getKey(r) || 'Other';
    counts[k] = (counts[k] || 0) + 1;
  });
  return Object.keys(counts).map(function (k) { return [k, counts[k]]; })
    .sort(function (a, b) { return b[1] - a[1]; });
}

function sortByDateDesc(records, field) {
  return records.slice().sort(function (a, b) {
    var av = (a.fields && a.fields[field]) || a.createdTime || '';
    var bv = (b.fields && b.fields[field]) || b.createdTime || '';
    return (Date.parse(bv) || 0) - (Date.parse(av) || 0);
  });
}

// Build a digest model (counts + samples) from the two queues.
async function buildDigest() {
  var suggested = await loadPending(gk.SUGGESTED_TABLE);
  var reverify = await loadPending(gk.REVERIFICATION_TABLE);

  var verdictOf = function (r) { return valueOf(r.fields && r.fields['Verdict']) || 'unverifiable'; };
  var changed = reverify.filter(function (r) { return verdictOf(r) === 'changed'; });
  var confirmed = reverify.filter(function (r) { return verdictOf(r) === 'confirmed'; });
  var flagged = reverify.filter(function (r) {
    var v = verdictOf(r); return v === 'unverifiable' || v === 'source_unreachable';
  });

  return {
    suggested: {
      total: suggested.length,
      byOrigin: tally(suggested, function (r) { return valueOf(r.fields && r.fields['Origin']) || 'Unknown'; }),
      byCategory: tally(suggested, function (r) { return valueOf(r.fields && r.fields['Category']) || 'Other'; }),
      sample: sortByDateDesc(suggested, 'Suggested At').slice(0, MAX_SAMPLE).map(function (r) {
        var f = r.fields || {};
        return {
          question: f['Question'] || '(no question)',
          category: valueOf(f['Category']) || '',
          origin: valueOf(f['Origin']) || ''
        };
      })
    },
    reverify: {
      total: reverify.length,
      changed: changed.length,
      confirmed: confirmed.length,
      flagged: flagged.length,
      // Lead with the rows that need a human decision (changed first, then flagged).
      sample: sortByDateDesc(changed.concat(flagged), 'Checked At').slice(0, MAX_SAMPLE).map(function (r) {
        var f = r.fields || {};
        var target = valueOf(f['Target Table']) || 'Knowledge';
        return {
          question: f['Question'] || '(no question)',
          verdict: valueOf(f['Verdict']) || '',
          target: (target && target !== 'Knowledge') ? (target + (f['Target Field'] ? (' · ' + f['Target Field']) : '')) : (valueOf(f['Category']) || '')
        };
      })
    }
  };
}

function listHtml(rows, render) {
  if (!rows.length) return '';
  return '<ul style="margin:8px 0 0;padding-left:18px">' + rows.map(function (r) {
    return '<li style="font-size:13px;line-height:1.55;color:#0F1A3D;margin-bottom:5px">' + render(r) + '</li>';
  }).join('') + '</ul>';
}

function chip(text, bg, fg) {
  return '<span style="display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;background:' + bg + ';color:' + fg + ';margin-left:6px">' + esc(text) + '</span>';
}

function verdictChip(v) {
  if (v === 'changed') return chip('correction', '#FCEFC7', '#8A6D00');
  if (v === 'unverifiable' || v === 'source_unreachable') return chip('check by hand', '#FAD9D5', '#9B2C1E');
  return chip(v || 'review', '#E6EAF2', '#5A6B86');
}

function buildHtmlEmail(d) {
  var dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var brand = '#0F1A3D', teal = '#0E7C6B';
  var needsDecision = d.reverify.changed + d.reverify.flagged;
  var nothing = (d.suggested.total + d.reverify.total) === 0;

  var blocks = [];

  // Headline stat row.
  blocks.push(
    '<tr><td style="padding:24px 32px 4px 32px">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>' +
        '<td style="text-align:center;padding:10px;background:#FAFAF6;border-radius:10px">' +
          '<div style="font-size:26px;font-weight:700;color:' + brand + '">' + d.suggested.total + '</div>' +
          '<div style="font-size:11px;color:#5A6B86">discovery suggestions</div></td>' +
        '<td style="width:12px"></td>' +
        '<td style="text-align:center;padding:10px;background:#FAFAF6;border-radius:10px">' +
          '<div style="font-size:26px;font-weight:700;color:' + brand + '">' + d.reverify.total + '</div>' +
          '<div style="font-size:11px;color:#5A6B86">re-verifications</div></td>' +
        '<td style="width:12px"></td>' +
        '<td style="text-align:center;padding:10px;background:' + (needsDecision ? '#FFF6E6' : '#FAFAF6') + ';border-radius:10px">' +
          '<div style="font-size:26px;font-weight:700;color:' + (needsDecision ? '#8A6D00' : brand) + '">' + needsDecision + '</div>' +
          '<div style="font-size:11px;color:#5A6B86">need a decision</div></td>' +
      '</tr></table>' +
    '</td></tr>'
  );

  if (nothing) {
    blocks.push('<tr><td style="padding:18px 32px 8px 32px"><div style="font-size:14px;line-height:1.6;color:#5A6B86">Nothing is waiting for review today. The discovery and re-verification jobs ran and found nothing that needs your eyes. Enjoy the quiet.</div></td></tr>');
  }

  // Discovery suggestions section.
  if (d.suggested.total) {
    var originSummary = d.suggested.byOrigin.map(function (o) { return esc(o[0]) + ' (' + o[1] + ')'; }).join(', ');
    blocks.push(
      '<tr><td style="padding:20px 32px 0 32px">' +
        '<div style="font-size:15px;font-weight:700;color:' + brand + '">Discovery suggestions to approve</div>' +
        '<div style="font-size:12px;color:#5A6B86;margin-top:2px">By source: ' + esc(originSummary) + '</div>' +
        listHtml(d.suggested.sample, function (s) {
          return esc(s.question) + (s.category ? chip(s.category, '#DFF3EF', teal) : '') + (s.origin ? chip(s.origin, '#E6EAF2', '#5A6B86') : '');
        }) +
        (d.suggested.total > d.suggested.sample.length ? '<div style="font-size:12px;color:#8A92A0;margin-top:6px">+ ' + (d.suggested.total - d.suggested.sample.length) + ' more in the dashboard</div>' : '') +
      '</td></tr>'
    );
  }

  // Re-verification section.
  if (d.reverify.total) {
    var rvSummary = [];
    if (d.reverify.changed) rvSummary.push(d.reverify.changed + ' correction' + (d.reverify.changed > 1 ? 's' : '') + ' to approve');
    if (d.reverify.flagged) rvSummary.push(d.reverify.flagged + ' to check by hand');
    if (d.reverify.confirmed) rvSummary.push(d.reverify.confirmed + ' confirmed (refresh)');
    blocks.push(
      '<tr><td style="padding:20px 32px 0 32px">' +
        '<div style="font-size:15px;font-weight:700;color:' + brand + '">Re-verification queue</div>' +
        '<div style="font-size:12px;color:#5A6B86;margin-top:2px">' + esc(rvSummary.join(' · ')) + '</div>' +
        listHtml(d.reverify.sample, function (s) {
          return esc(s.question) + verdictChip(s.verdict) + (s.target ? chip(s.target, '#DFF3EF', teal) : '');
        }) +
      '</td></tr>'
    );
  }

  // CTA button.
  blocks.push(
    '<tr><td style="padding:26px 32px 28px 32px">' +
      '<a href="' + esc(DASHBOARD_URL) + '" style="display:inline-block;background:' + teal + ';color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px">Open the review dashboard →</a>' +
      '<div style="font-size:12px;color:#8A92A0;margin-top:10px">In the dashboard: <strong>Approve and make live</strong> or <strong>Dismiss</strong> each suggestion; <strong>Apply update</strong>, <strong>Confirm</strong> or <strong>Dismiss</strong> each re-verification. Nothing changes until you act.</div>' +
    '</td></tr>'
  );

  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Luna knowledge review</title></head>',
    '<body style="margin:0;padding:0;background:#FAFAF6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#0F1A3D">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAF6;padding:24px 12px"><tr><td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(15,26,61,0.06)">',
    '<tr><td style="background:' + brand + ';padding:26px 32px;text-align:left">',
    '<div style="color:#FFFFFF;font-size:21px;font-weight:600">Luna knowledge — daily review</div>',
    '<div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:6px">' + esc(dateStr) + '</div></td></tr>',
    blocks.join('\n'),
    '<tr><td style="background:#FAFAF6;padding:18px 32px;text-align:center;font-size:11px;color:#8A92A0;border-top:1px solid #EFEDE5">',
    'Automated review digest · Luna Brain · Travelgenix</td></tr>',
    '</table></td></tr></table></body></html>'
  ].join('\n');
}

function buildSubject(d) {
  var needsDecision = d.reverify.changed + d.reverify.flagged;
  var total = d.suggested.total + d.reverify.total;
  if (total === 0) return 'Luna knowledge review — all clear';
  var bits = [];
  if (d.suggested.total) bits.push(d.suggested.total + ' to approve');
  if (needsDecision) bits.push(needsDecision + ' to decide');
  return 'Luna knowledge review — ' + (bits.join(', ') || (total + ' pending'));
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  var auth = req.headers['authorization'] || '';
  var qSecret = (req.query && req.query.secret) || '';
  if (!secret || (auth !== 'Bearer ' + secret && qSecret !== secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Server not configured (AIRTABLE_KEY)' });

  var dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  var force = req.query && (req.query.force === '1' || req.query.force === 'true');
  // Send daily by default (heartbeat). Only skip an empty digest if explicitly
  // opted out via DIGEST_SKIP_WHEN_EMPTY, and never skip when ?force=1.
  var skipWhenEmpty = !force && process.env.DIGEST_SKIP_WHEN_EMPTY === '1';

  try {
    var digest = await buildDigest();
    var pendingTotal = digest.suggested.total + digest.reverify.total;
    var subject = buildSubject(digest);
    var to = (req.query && req.query.to) || DEFAULT_TO;

    if (dryRun) {
      return res.status(200).json({ ok: true, dryRun: true, to: to, subject: subject, pendingTotal: pendingTotal, digest: digest });
    }

    if (pendingTotal === 0 && skipWhenEmpty) {
      return res.status(200).json({ ok: true, sent: false, reason: 'nothing pending and DIGEST_SKIP_WHEN_EMPTY=1', pendingTotal: 0 });
    }

    var sgKey = process.env.SENDGRID_API_KEY;
    if (!sgKey) return res.status(500).json({ error: 'Email service not configured (SENDGRID_API_KEY)', pendingTotal: pendingTotal });

    var sgMail;
    try { sgMail = require('@sendgrid/mail'); }
    catch (e) { return res.status(500).json({ error: 'Email service unavailable (@sendgrid/mail not installed)' }); }
    sgMail.setApiKey(sgKey);

    var html = buildHtmlEmail(digest);
    var result = await sgMail.send({
      to: to,
      from: { name: 'Luna Brain', email: FROM_EMAIL },
      subject: subject,
      html: html,
      trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } },
      categories: ['knowledge-review-digest']
    });
    var messageId = (result && result[0] && result[0].headers && result[0].headers['x-message-id']) || null;

    return res.status(200).json({ ok: true, sent: true, to: to, subject: subject, pendingTotal: pendingTotal, messageId: messageId });
  } catch (e) {
    console.error('[review-digest] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

// Exposed for offline tests (pure render helpers; no network/email side effects).
module.exports._test = { buildHtmlEmail: buildHtmlEmail, buildSubject: buildSubject, tally: tally };
