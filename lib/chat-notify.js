// Tell the client a real person chatted with them.
//
// Travelgenix had 36 conversations on their own site and heard about none of
// them. Four visitors clicked "Speak to our team" and nothing happened, because
// the only email Luna ever sent came from the "leave a message" form, which
// none of them used. Every other conversation existed solely as a row in
// Airtable and a notification inside a dashboard nobody had open. A third-party
// livechat had been emailing on every chat, which is the whole of the
// difference between "two leads a day" and "no leads at all".
//
// So: one email per conversation, when it is logged, carrying what was said.
// And a second, clearly marked, the moment a visitor asks for a human — that
// one is a person waiting, not a record for later.
//
// Deliberately NOT one per message. A chat is the unit a client can act on; a
// message is noise, and noise gets filtered to a folder nobody reads.

'use strict';

// Decide whether this write to the Conversations table is worth an email.
//
//   isNew            — the row was created by this call, not updated
//   escalated        — the visitor has asked for a human
//   wasEscalated     — they had already asked, on an earlier write
//   hasVisitorMessage— someone actually typed or tapped something
//
// The escalation email is allowed to follow the new-chat one: they say
// different things, and the second is the one that needs answering today.
function decideNotification(state) {
  var s = state || {};
  // A bot greeting with no reply is not a conversation. Emailing those is how
  // a useful alert becomes one the client mutes.
  if (!s.hasVisitorMessage) return { notify: false, urgent: false, reason: 'no visitor message' };
  if (s.escalated && !s.wasEscalated) return { notify: true, urgent: true, reason: 'asked for a human' };
  if (s.isNew) return { notify: true, urgent: false, reason: 'new conversation' };
  return { notify: false, urgent: false, reason: 'already notified' };
}

// Does this summary contain anything the visitor said?
// Summaries are stored as alternating "bot: ..." / "user: ..." lines.
function hasVisitorMessage(summary) {
  if (!summary) return false;
  return /^\s*user:\s*\S/m.test(String(summary));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Render the transcript summary as readable lines rather than one blob, with
// the visitor's own words emphasised — that is what the client is scanning for.
function transcriptHtml(summary) {
  var lines = String(summary || '').split('\n').filter(function (l) { return l.trim(); }).slice(0, 40);
  if (!lines.length) return '';
  return '<div style="margin:14px 0;padding:12px 14px;background:#F8FAFC;border-radius:8px;font-size:13px;line-height:1.6">'
    + lines.map(function (l) {
      var m = /^\s*(user|bot|agent)\s*:\s*([\s\S]*)$/i.exec(l);
      if (!m) return '<div>' + esc(l) + '</div>';
      var who = m[1].toLowerCase();
      var label = who === 'user' ? 'Visitor' : (who === 'agent' ? 'Agent' : 'Luna');
      var colour = who === 'user' ? '#0F172A' : '#64748B';
      var weight = who === 'user' ? '600' : '400';
      return '<div style="margin:2px 0;color:' + colour + ';font-weight:' + weight + '">'
        + '<span style="color:#94A3B8;font-weight:400">' + label + ':</span> ' + esc(m[2]) + '</div>';
    }).join('') + '</div>';
}

// Build the email. `urgent` changes the subject and adds the banner, because a
// handover request and a transcript-for-the-record want different urgency at a
// glance in an inbox.
function buildChatEmail(opts) {
  var o = opts || {};
  var who = String(o.visitorName || '').trim();
  // "Anonymous" is a placeholder we write ourselves, never a name a visitor gave.
  if (/^(anonymous|anon|guest|visitor|unknown)$/i.test(who)) who = '';

  var subject = o.urgent
    ? 'Someone wants to talk to you on ' + (o.clientName || 'your website')
    : 'New chat on ' + (o.clientName || 'your website') + (who ? ' — ' + who : '');

  var rows = [];
  if (who) rows.push(['Name', esc(who)]);
  if (o.visitorEmail) rows.push(['Email', '<a href="mailto:' + esc(o.visitorEmail) + '">' + esc(o.visitorEmail) + '</a>']);
  if (o.page) rows.push(['Page', esc(String(o.page).slice(0, 200))]);
  if (o.at) rows.push(['When', esc(o.at)]);

  var lead = o.urgent
    ? 'A visitor has asked to speak to a person. They were on your website just now.'
    : 'Someone chatted with Luna on your website. Here is what they said.';

  var html = '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0F172A;line-height:1.5">'
    + (o.urgent
      ? '<div style="background:#FEF2F2;border-left:3px solid #DC2626;padding:10px 14px;margin:0 0 14px;border-radius:4px;font-weight:600;color:#991B1B">Waiting to speak to someone</div>'
      : '')
    + '<p style="margin:0 0 12px">' + esc(lead) + '</p>'
    + (rows.length
      ? '<table style="border-collapse:collapse;font-size:13px;margin:0 0 4px">'
        + rows.map(function (r) {
          return '<tr><td style="padding:3px 12px 3px 0;color:#64748B;vertical-align:top">' + r[0]
            + '</td><td style="padding:3px 0"><b>' + r[1] + '</b></td></tr>';
        }).join('') + '</table>'
      : '')
    + transcriptHtml(o.summary)
    + (o.dashboardUrl
      ? '<p style="margin:14px 0 0"><a href="' + esc(o.dashboardUrl) + '" style="background:#0F172A;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;display:inline-block;font-weight:600">Open the conversation</a></p>'
      : '')
    + (o.visitorEmail
      ? ''
      : '<p style="margin:14px 0 0;color:#94A3B8;font-size:12px">This visitor did not leave contact details. Open the conversation to reply while they are still on the site.</p>')
    + '</div>';

  return { subject: subject, html: html };
}

module.exports = {
  decideNotification: decideNotification,
  hasVisitorMessage: hasVisitorMessage,
  buildChatEmail: buildChatEmail
};
