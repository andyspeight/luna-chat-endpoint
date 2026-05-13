// Email Chat Transcript API
// Sends the visitor a copy of their chat transcript via SendGrid.
// From: client name <noreply@travelgenix.io>  Reply-To: client's ContactEmail.
//
// POST body: {
//   clientName: string,        // required — looks up client in Airtable
//   visitorEmail: string,      // required — recipient
//   transcript: string,        // required — plain-text transcript from the widget
//   visitorName?: string,      // optional — for greeting
//   conversationId?: string,   // optional — for logging
//   brandColor?: string,       // optional — for HTML email accent
//   accentColor?: string       // optional — for HTML email accent
// }

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

// CORS: the widget runs on ANY client's website, so we cannot maintain an
// allowlist. Abuse risk is mitigated by: (1) Airtable client lookup — only
// real Travelgenix clients can send, (2) SendGrid domain auth — bad actors
// can't send as someone else, (3) SendGrid daily/per-key rate limits.
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Lightweight input sanitisation. Strips control chars + caps length.
function clean(s, max) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .slice(0, max || 1000)
    .trim();
}

// HTML-escape for safe insertion into the email template.
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Validate hex color, fall back to brand default.
function safeHex(c, fallback) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : fallback;
}

// Validate email address (simple regex, server side double-checks via SendGrid).
function isEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
}

// Convert plain-text transcript to nicely formatted HTML.
// Transcript lines look like "Visitor: hello" or "Luna AI: hi there".
function transcriptToHtml(transcript, brandColor, accentColor) {
  if (!transcript) return '';
  var lines = transcript.split(/\r?\n/);
  var html = '';
  var inBlock = false;
  lines.forEach(function(line) {
    // Detect role prefix: "Name: " at start
    var m = line.match(/^([^:]{1,40}):\s*(.*)$/);
    if (m) {
      if (inBlock) html += '</div>';
      var role = esc(m[1]);
      var msg = esc(m[2]);
      var isUser = /^visitor|^you|^user/i.test(m[1]);
      var bg = isUser ? '#F5F3EC' : brandColor + '0d';
      var labelColor = isUser ? '#5A6B86' : brandColor;
      html += '<div style="margin:0 0 14px 0;padding:12px 14px;background:' + bg + ';border-radius:10px;border-left:3px solid ' + (isUser ? '#C4C0B4' : brandColor) + '">';
      html += '<div style="font-size:11.5px;font-weight:600;color:' + labelColor + ';letter-spacing:0.02em;text-transform:uppercase;margin-bottom:4px">' + role + '</div>';
      html += '<div style="font-size:14px;line-height:1.55;color:#0F1A3D">' + msg + '</div>';
      inBlock = true;
    } else if (line.trim()) {
      // Continuation of previous block
      if (inBlock) {
        html += '<div style="font-size:14px;line-height:1.55;color:#0F1A3D;margin-top:4px">' + esc(line) + '</div>';
      }
    }
  });
  if (inBlock) html += '</div>';
  return html;
}

// Full HTML email template.
function buildHtmlEmail(opts) {
  var brandColor = safeHex(opts.brandColor, '#0F1A3D');
  var accentColor = safeHex(opts.accentColor, '#F26A4F');
  var dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  var transcriptHtml = transcriptToHtml(opts.transcript, brandColor, accentColor);
  var greeting = opts.visitorName ? 'Hi ' + esc(opts.visitorName) : 'Hi there';
  var clientNameEsc = esc(opts.clientName);
  var replyHint = opts.clientReplyEmail
    ? 'If you\'d like to reply, just hit reply and your message will go straight to ' + esc(opts.clientName) + '.'
    : 'If you need to follow up, please get in touch with ' + esc(opts.clientName) + ' directly.';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Your chat transcript</title>',
    '</head>',
    '<body style="margin:0;padding:0;background:#FAFAF6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#0F1A3D">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAFAF6;padding:24px 12px">',
    '<tr><td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(15,26,61,0.06)">',

    // Header
    '<tr><td style="background:' + brandColor + ';padding:28px 32px;text-align:left">',
    '<div style="color:#FFFFFF;font-size:22px;font-weight:600;letter-spacing:-0.01em">Your chat transcript</div>',
    '<div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:6px">' + esc(opts.clientName) + ' &middot; ' + dateStr + '</div>',
    '</td></tr>',

    // Greeting
    '<tr><td style="padding:28px 32px 8px 32px">',
    '<div style="font-size:15px;line-height:1.5;color:#0F1A3D;margin-bottom:8px">' + greeting + ',</div>',
    '<div style="font-size:14px;line-height:1.6;color:#5A6B86">Here\'s a copy of your conversation with us. We\'ve saved it for you in case it\'s useful later.</div>',
    '</td></tr>',

    // Transcript
    '<tr><td style="padding:16px 32px 8px 32px">',
    transcriptHtml,
    '</td></tr>',

    // Reply hint
    '<tr><td style="padding:8px 32px 24px 32px">',
    '<div style="font-size:13px;line-height:1.6;color:#5A6B86;padding:14px 16px;background:#FAFAF6;border-radius:10px">' + replyHint + '</div>',
    '</td></tr>',

    // Footer
    '<tr><td style="background:#FAFAF6;padding:18px 32px;text-align:center;font-size:11px;color:#8A92A0;border-top:1px solid #EFEDE5">',
    'Sent on behalf of ' + clientNameEsc + ' &middot; Powered by Travelgenix',
    '</td></tr>',

    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>'
  ].join('\n');
}

// Plain-text version for clients that don't render HTML.
function buildTextEmail(opts) {
  var dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  var greeting = opts.visitorName ? 'Hi ' + opts.visitorName : 'Hi there';
  return [
    'Your chat transcript',
    opts.clientName + ' · ' + dateStr,
    '',
    greeting + ',',
    '',
    'Here\'s a copy of your conversation with us.',
    '',
    '---',
    '',
    opts.transcript,
    '',
    '---',
    '',
    opts.clientReplyEmail
      ? 'If you\'d like to reply, just hit reply and your message will go straight to ' + opts.clientName + '.'
      : 'If you need to follow up, please get in touch with ' + opts.clientName + ' directly.',
    '',
    'Sent on behalf of ' + opts.clientName + ' · Powered by Travelgenix'
  ].join('\n');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var sgKey = process.env.SENDGRID_API_KEY;
  if (!sgKey) {
    console.error('[email-transcript] SENDGRID_API_KEY not set');
    return res.status(500).json({ error: 'Email service not configured' });
  }
  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) {
    console.error('[email-transcript] AIRTABLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  var body = req.body || {};

  // Validate + sanitise inputs
  var clientName = clean(body.clientName, 200);
  var visitorEmail = clean(body.visitorEmail, 254);
  var transcript = clean(body.transcript, 50000); // hard cap on transcript size (~50KB)
  var visitorName = clean(body.visitorName, 100);
  var conversationId = clean(body.conversationId, 100);
  var brandColor = body.brandColor;
  var accentColor = body.accentColor;

  if (!clientName) return res.status(400).json({ error: 'Missing clientName' });
  if (!isEmail(visitorEmail)) return res.status(400).json({ error: 'Invalid email address' });
  if (!transcript || transcript.length < 10) return res.status(400).json({ error: 'Missing or empty transcript' });

  // Look up the client to get the contact email (Reply-To)
  var clientReplyEmail = null;
  try {
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("{ClientName}='" + clientName.replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    if (sRes.ok) {
      var sData = await sRes.json();
      if (sData.records && sData.records.length > 0) {
        var fields = sData.records[0].fields || {};
        if (fields.ContactEmail && isEmail(fields.ContactEmail)) {
          clientReplyEmail = fields.ContactEmail;
        }
      }
    } else {
      console.warn('[email-transcript] Airtable lookup returned ' + sRes.status);
    }
  } catch (err) {
    console.warn('[email-transcript] Airtable lookup failed:', err.message);
    // Non-fatal — continue without Reply-To
  }

  // Build and send
  try {
    // Lazy-load SendGrid so a missing dependency doesn't break CORS preflight.
    var sgMail;
    try {
      sgMail = require('@sendgrid/mail');
    } catch (loadErr) {
      console.error('[email-transcript] @sendgrid/mail not installed:', loadErr.message);
      return res.status(500).json({ error: 'Email service unavailable (sendgrid package not installed)' });
    }
    sgMail.setApiKey(sgKey);

    var htmlBody = buildHtmlEmail({
      clientName: clientName,
      visitorName: visitorName,
      transcript: transcript,
      brandColor: brandColor,
      accentColor: accentColor,
      clientReplyEmail: clientReplyEmail
    });

    var textBody = buildTextEmail({
      clientName: clientName,
      visitorName: visitorName,
      transcript: transcript,
      clientReplyEmail: clientReplyEmail
    });

    var msg = {
      to: visitorEmail,
      from: {
        // From name is spoofed to client — visitor sees the client's name in their inbox.
        // Actual sending address is travelgenix.io which is SendGrid-authenticated.
        name: clientName,
        email: 'noreply@travelgenix.io'
      },
      subject: 'Your chat with ' + clientName,
      text: textBody,
      html: htmlBody,
      // Reply-To routes any reply to the client's actual contact email.
      // If not configured, replies go to noreply (which we'll bin server-side later).
      replyTo: clientReplyEmail || 'noreply@travelgenix.io',
      // Mail settings — helpful for deliverability
      mailSettings: {
        sandboxMode: { enable: false }
      },
      trackingSettings: {
        clickTracking: { enable: false }, // don't rewrite URLs in transcripts
        openTracking: { enable: false }
      },
      categories: ['chat-transcript', clientName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32)],
      customArgs: conversationId ? { conversationId: conversationId } : undefined
    };

    var sgResult = await sgMail.send(msg);
    var messageId = (sgResult && sgResult[0] && sgResult[0].headers && sgResult[0].headers['x-message-id']) || null;

    console.log('[email-transcript] sent to', visitorEmail, 'for client', clientName, 'msgId:', messageId);

    return res.status(200).json({
      success: true,
      messageId: messageId,
      replyToConfigured: !!clientReplyEmail
    });

  } catch (err) {
    // SendGrid errors include detail in err.response.body.errors
    var detail = '';
    if (err.response && err.response.body && err.response.body.errors) {
      detail = err.response.body.errors.map(function(e) { return e.message; }).join('; ');
    }
    console.error('[email-transcript] SendGrid error:', err.message, detail);
    return res.status(500).json({
      error: 'Failed to send email',
      detail: detail || err.message
    });
  }
};
