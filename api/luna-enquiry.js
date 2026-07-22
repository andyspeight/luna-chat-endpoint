// api/luna-enquiry.js
// ───────────────────────────────────────────────────────────────────────────
// Booking Assist — the agent bridge. When Luna has assembled a visitor's trip
// brief and the visitor taps "Get this priced", the widget POSTs the brief +
// contact details here. We:
//   1. verify the client exists (Clients table),
//   2. write a qualified enquiry to the Enquiries table — idempotent per
//      conversation: a re-submit updates the same row instead of duplicating,
//   3. best-effort email the client's ContactEmail so out-of-hours enquiries
//      aren't missed (same philosophy as notify-lead.js),
// and return the record id. The widget separately pings the agent dashboard
// over the existing Ably dashboard channel — no Ably key needed here.
//
// Called from the embeddable widget on client agency domains, so CORS is *
// (no credentials). The Airtable key and SendGrid key never leave the server.
//
// Env: AIRTABLE_KEY. Optional: SENDGRID_API_KEY, LEAD_NOTIFY_FROM.

const ratelimit = require('../lib/ratelimit');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_CLIENTS = 'tbl6CZ7aVzq1wHF2v';
const AT_ENQUIRIES = 'tblctVL7rzDR9JBJB';
const FROM_EMAIL = process.env.LEAD_NOTIFY_FROM || process.env.REVIEW_DIGEST_FROM || 'noreply@travelgenix.io';
const DASHBOARD_URL = 'https://chat.travelify.io/dashboard.html';

// Enquiries field IDs (stable against renames)
const F = {
  enquiryId: 'fldQfx9orPCqycFit',
  client: 'fldAVJZjjg6JzOYtH',
  conversationId: 'fldZQmqL7tBJ5VYlw',
  visitorId: 'fldAfxnGNuG5o0s5A',
  name: 'fld99avs6oKiO1gZa',
  email: 'fldFeGo5woCxdg94U',
  phone: 'fld5Y5sDGmOzQWx9U',
  status: 'fldDuEV2gD3Yfgn6K',
  destination: 'fld2y66pnPLHtRwjX',
  departureAirport: 'fld3thAJ1y1U3iENC',
  departureDate: 'fldehcH4Iop0Od4lF',
  returnDate: 'fld4qBe1p9XFbNuaw',
  nights: 'fld69wFcmgRmuN2Ul',
  dateFlexibility: 'fldzcQiKcGT3giFQd',
  adults: 'fld6uZzyJlgmllyPo',
  children: 'fldPzpIzp2ypwgnrz',
  childAges: 'fldsxVDRje1OQzTv6',
  board: 'fldeMFdvIV0RFwHbs',
  budget: 'fldFaLHdwjAUSXs54',
  holidayType: 'fldSzqYyU7ITrzwBZ',
  tripBriefJson: 'fldMOBvFWJdUN4fVt',
  searchUrl: 'fld9o8JVBQAZMgWWg',
  summary: 'fldQFx0qPfah7ozAM',
  source: 'fldo2ScRfwXr0MyvM',
  landingPage: 'fldXz6WvVrybt23lC',
  referrer: 'fldHo8iu3RtQX6NIi',
  createdAt: 'fldqx21yZX2OA9scs',
};

function clip(s, n) { return String(s == null ? '' : s).slice(0, n).trim(); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function toInt(v) {
  var x = parseInt(v, 10);
  return Number.isFinite(x) && x >= 0 && x <= 50 ? x : null;
}
function isoDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }

async function at(path, options) {
  var resp = await fetch('https://api.airtable.com/v0/' + AT_BASE + '/' + path, Object.assign({}, options, {
    headers: Object.assign({
      'Authorization': 'Bearer ' + process.env.AIRTABLE_KEY,
      'Content-Type': 'application/json',
    }, (options && options.headers) || {}),
  }));
  if (!resp.ok) {
    var detail = await resp.text().catch(function () { return ''; });
    throw new Error('Airtable ' + resp.status + ': ' + detail.slice(0, 300));
  }
  return resp.json();
}

// One-line summary the agent reads before picking up the phone.
function composeSummary(name, brief) {
  var bits = [];
  if (brief.destination) bits.push(brief.destination);
  if (brief.departureDate) bits.push('departing ' + brief.departureDate);
  else if (brief.dateFlexibility) bits.push(brief.dateFlexibility);
  if (brief.nights) bits.push(brief.nights + ' nights');
  var party = [];
  if (brief.adults) party.push(brief.adults + ' adult' + (brief.adults > 1 ? 's' : ''));
  if (brief.children) {
    party.push(brief.children + ' child' + (brief.children > 1 ? 'ren' : '')
      + (brief.childAges ? ' (' + brief.childAges + ')' : ''));
  }
  if (party.length) bits.push(party.join(' + '));
  if (brief.departureAirport) bits.push('from ' + brief.departureAirport);
  if (brief.board) bits.push(brief.board);
  if (brief.budget) bits.push('budget ' + brief.budget);
  return (name || 'Visitor') + ' — ' + (bits.join(', ') || 'details in chat transcript') + '.';
}

async function emailClient(clientFields, name, email, phone, summary) {
  var to = clientFields.ContactEmail;
  var key = process.env.SENDGRID_API_KEY;
  if (!to || !key) return; // degrade silently — the dashboard ping + Airtable row still land
  var html =
    '<p><strong>New qualified booking enquiry from Luna Chat</strong></p>'
    + '<p>' + esc(summary) + '</p>'
    + '<p>Contact: ' + esc(name) + (email ? ' · ' + esc(email) : '') + (phone ? ' · ' + esc(phone) : '') + '</p>'
    + '<p>The full trip brief is in your <a href="' + DASHBOARD_URL + '">Luna dashboard</a> and the Enquiries list.</p>';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: 'Luna Chat' },
      subject: 'New booking enquiry — ' + esc(name),
      content: [{ type: 'text/html', value: html }],
    }),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // embeddable widget; no credentials
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.AIRTABLE_KEY) return res.status(500).json({ error: 'Not configured' });

  // A human filling in a form — 10/hour/IP is generous, spam-resistant.
  try {
    var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'luna-enquiry', ipMax: 10, ipWindowSecs: 3600 });
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });
  } catch (e) { /* limiter unavailable — fail open */ }

  var body = req.body || {};
  var clientId = clip(body.clientId, 30);
  var name = clip(body.name, 120);
  var email = clip(body.email, 200);
  var phone = clip(body.phone, 40);
  var brief = (body.brief && typeof body.brief === 'object') ? body.brief : {};

  if (!/^rec[A-Za-z0-9]{14}$/.test(clientId)) return res.status(400).json({ error: 'Invalid clientId' });
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!email && !phone) return res.status(400).json({ error: 'An email or phone number is required' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  try {
    var client;
    try {
      client = await at(AT_CLIENTS + '/' + clientId);
    } catch (e) {
      return res.status(404).json({ error: 'Unknown client' });
    }

    // Idempotency: one enquiry per conversation.
    var conversationId = clip(body.conversationId, 60).replace(/'/g, '');
    var existingId = null;
    if (conversationId) {
      var q = await at(AT_ENQUIRIES + '?maxRecords=1&filterByFormula='
        + encodeURIComponent("{ConversationID}='" + conversationId + "'"));
      if (q.records && q.records.length) existingId = q.records[0].id;
    }

    var cleanBrief = {
      destination: clip(brief.destination, 120) || null,
      departureAirport: clip(brief.departureAirport, 80) || null,
      departureDate: isoDate(brief.departureDate),
      returnDate: isoDate(brief.returnDate),
      nights: toInt(brief.nights),
      dateFlexibility: clip(brief.dateFlexibility, 120) || null,
      adults: toInt(brief.adults),
      children: toInt(brief.children),
      childAges: clip(brief.childAges, 60) || null,
      board: clip(brief.board, 60) || null,
      budget: clip(brief.budget, 120) || null,
      holidayType: clip(brief.holidayType, 60) || null,
      notes: clip(brief.notes, 500) || null,
    };
    var summary = composeSummary(name, cleanBrief);

    var fields = {};
    fields[F.client] = [clientId];
    if (conversationId) fields[F.conversationId] = conversationId;
    var visitorId = clip(body.visitorId, 80);
    if (visitorId) fields[F.visitorId] = visitorId;
    fields[F.name] = name;
    if (email) fields[F.email] = email;
    if (phone) fields[F.phone] = phone;
    fields[F.status] = 'New';
    if (cleanBrief.destination) fields[F.destination] = cleanBrief.destination;
    if (cleanBrief.departureAirport) fields[F.departureAirport] = cleanBrief.departureAirport;
    if (cleanBrief.departureDate) fields[F.departureDate] = cleanBrief.departureDate;
    if (cleanBrief.returnDate) fields[F.returnDate] = cleanBrief.returnDate;
    if (cleanBrief.nights !== null) fields[F.nights] = cleanBrief.nights;
    if (cleanBrief.dateFlexibility) fields[F.dateFlexibility] = cleanBrief.dateFlexibility;
    if (cleanBrief.adults !== null) fields[F.adults] = cleanBrief.adults;
    if (cleanBrief.children !== null) fields[F.children] = cleanBrief.children;
    if (cleanBrief.childAges) fields[F.childAges] = cleanBrief.childAges;
    if (cleanBrief.board) fields[F.board] = cleanBrief.board;
    if (cleanBrief.budget) fields[F.budget] = cleanBrief.budget;
    if (cleanBrief.holidayType) fields[F.holidayType] = cleanBrief.holidayType;
    fields[F.tripBriefJson] = JSON.stringify(cleanBrief);
    var searchUrl = clip(body.searchUrl, 1000);
    if (/^https?:\/\//i.test(searchUrl)) fields[F.searchUrl] = searchUrl;
    // Attribution (best-effort, never required). Only accept http(s) URLs for the
    // landing page; the referrer can be blank (direct traffic) so it is optional.
    var landingPage = clip(body.landingPage, 1000);
    if (/^https?:\/\//i.test(landingPage)) fields[F.landingPage] = landingPage;
    var referrer = clip(body.referrer, 1000);
    if (/^https?:\/\//i.test(referrer)) fields[F.referrer] = referrer;
    fields[F.summary] = summary;
    fields[F.source] = 'Luna Chat';

    var record;
    if (existingId) {
      record = await at(AT_ENQUIRIES + '/' + existingId, {
        method: 'PATCH',
        body: JSON.stringify({ fields: fields, typecast: true }),
      });
    } else {
      fields[F.enquiryId] = 'enq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      fields[F.createdAt] = new Date().toISOString();
      record = await at(AT_ENQUIRIES, {
        method: 'POST',
        body: JSON.stringify({ fields: fields, typecast: true }),
      });
    }

    // Fire-and-forget email — never blocks or fails the visitor's confirmation.
    try { await emailClient(client.fields || {}, name, email, phone, summary); }
    catch (e) { console.warn('[luna-enquiry] email failed (non-fatal):', e.message); }

    return res.status(200).json({ ok: true, enquiryRecordId: record.id, updated: !!existingId, summary: summary });
  } catch (err) {
    console.error('[luna-enquiry] error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
