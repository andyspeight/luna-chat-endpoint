// api/luna-stats.js
// Server-side analytics for the dashboard Stats panel.
//
// Reads Conversations from Airtable and computes the metrics the dashboard
// renders. Replaces the localStorage-only client-side computation, which
// only saw conversations this browser personally handled — making the Stats
// panel mostly show zeros.
//
// Auth: a valid central session (tg_session cookie) entitled to the requested
// client is REQUIRED server-side — X-Client-Name alone is not trusted.

const auth = require('../lib/luna-auth');

const AT_BASE = 'app6Ot3eOb3DangkB';
const CONV_TABLE = 'tblyin27D2J9ejHvf';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';

// Dashboard origins allowed to make credentialed (cookie-bearing) requests.
const AGENT_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io',
  'https://luna-chat.travelify.io',
  'http://localhost:3000',
  'http://localhost:5173'
];

// Field IDs (verified against the schema today)
const F = {
  convId: 'fldgQj90mYwsVO4yK',
  visitorName: 'fldqx6k7WvrqE8BW1',
  pageUrl: 'fldz7B7qaRcZlbqxM',          // ClientWebsite — actually the page where chat happened
  startedAt: 'fldSoy7BMqyzVb5pp',
  lastMessageAt: 'fld1GghMiUnAmdtow',
  transcript: 'fld8fMjyXWmKcacoB',
  qualityScore: 'fld4mQMkFTccEE4T4',
  visitorRating: 'fldw186Uuq2CP4hIc',
  wasAnswered: 'fldvmBP6C6MBa95K6',
  wasEscalated: 'fld3JapxKxGsBxPCQ',
  topicTags: 'fldQNFhnyo3W2ngTZ',
  scoredAt: 'fldPm52hNNc4UhSRv',
  client: 'flde1PCByneD05YyG'
};

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && AGENT_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // dashboard sends tg_session
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function findClient(atKey, clientName) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CLIENTS_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ClientName}='" + clientName.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) ? d.records[0].id : null;
}

// Page over all Conversations for the client — uses ARRAYJOIN({Client}) by name
// (matches the pattern we proved works in luna-brain.js).
async function fetchAllConversations(atKey, clientName) {
  var safe = clientName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Exact match, not substring: FIND(...) > 0 also matched clients whose name is a
  // substring of another ("Sun Travel" leaking "Sun Travel Plus"). Each record links
  // exactly one client, so ARRAYJOIN({Client}) equals that client's name exactly.
  var formula = "ARRAYJOIN({Client}) = '" + safe + "'";
  var records = [];
  var offset = null;
  var pageCount = 0;
  do {
    var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&pageSize=100'
      + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
    if (!r.ok) {
      var err = await r.json().catch(function(){ return {}; });
      throw new Error('Airtable ' + r.status + ': ' + ((err.error && err.error.message) || 'unknown'));
    }
    var data = await r.json();
    records = records.concat(data.records || []);
    offset = data.offset || null;
    pageCount++;
    // Safety cap — avoid runaway loops
    if (pageCount > 20) break;
  } while (offset);
  return records;
}

// Count "messages" from a transcript by counting role-prefix occurrences.
// Approximate — close enough for Avg Messages stat without parsing block markers.
function countMessagesInTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return 0;
  var matches = transcript.match(/(?:^|[\s\.\?\!\)\]"'])(?:Visitor|Luna|Agent):/g);
  return matches ? matches.length : 0;
}

function shapeRecord(rec) {
  var f = rec.fields || {};
  var startedAt = f.StartedAt || null;
  var lastMessageAt = f.LastMessageAt || null;
  var durationMins = null;
  if (startedAt && lastMessageAt) {
    var diff = (new Date(lastMessageAt) - new Date(startedAt)) / 60000;
    if (!isNaN(diff) && diff >= 0 && diff < 24 * 60) durationMins = diff;
  }
  var tags = Array.isArray(f.TopicTags)
    ? f.TopicTags.map(function(t){ return typeof t === 'object' ? t.name : t; })
    : [];
  return {
    id: rec.id,
    convId: f.ConversationID || '',
    startedAt: startedAt,
    lastMessageAt: lastMessageAt,
    durationMins: durationMins,
    messageCount: countMessagesInTranscript(f.Transcript || ''),
    qualityScore: typeof f.QualityScore === 'number' ? f.QualityScore : null,
    visitorRating: typeof f.VisitorRating === 'number' ? f.VisitorRating : null,
    wasAnswered: !!f.WasAnswered,
    wasEscalated: !!f.WasEscalated,
    topicTags: tags,
    pageUrl: f.ClientWebsite || ''
  };
}

function computeMetrics(records) {
  var shaped = records.map(shapeRecord);
  var total = shaped.length;

  // Handler split
  var aiOnly = shaped.filter(function(r){ return !r.wasEscalated; }).length;
  var escalated = total - aiOnly;
  var aiPct = total > 0 ? Math.round((aiOnly / total) * 100) : 0;

  // Avg duration (mins)
  var durations = shaped.filter(function(r){ return r.durationMins != null; }).map(function(r){ return r.durationMins; });
  var avgDuration = durations.length > 0
    ? (durations.reduce(function(s,d){ return s + d; }, 0) / durations.length)
    : 0;

  // Avg messages per conversation
  var msgCounts = shaped.filter(function(r){ return r.messageCount > 0; }).map(function(r){ return r.messageCount; });
  var avgMessages = msgCounts.length > 0
    ? (msgCounts.reduce(function(s,n){ return s + n; }, 0) / msgCounts.length)
    : 0;

  // Visitor CSAT (1..5) from the real VisitorRating field (distinct from the AI QualityScore).
  var ratingDist = [0, 0, 0, 0, 0];
  var ratedCount = 0;
  var ratingSum = 0;
  shaped.forEach(function(r){
    if (r.visitorRating && r.visitorRating >= 1 && r.visitorRating <= 5) {
      ratingDist[r.visitorRating - 1]++;
      ratedCount++;
      ratingSum += r.visitorRating;
    }
  });
  var avgRating = ratedCount > 0 ? (ratingSum / ratedCount) : null;

  // Last 14 days — daily counts
  var dayCounts = new Array(14).fill(0);
  var dayLabels = [];
  for (var i = 13; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    dayLabels.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
  }
  shaped.forEach(function(r){
    if (!r.startedAt) return;
    var t = new Date(r.startedAt);
    if (isNaN(t.getTime())) return;
    var iso = new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString().slice(0, 10);
    var idx = dayLabels.indexOf(iso);
    if (idx !== -1) dayCounts[idx]++;
  });

  // Peak hour + hourly distribution
  var hourCounts = new Array(24).fill(0);
  shaped.forEach(function(r){
    if (!r.startedAt) return;
    var hr = new Date(r.startedAt).getHours();
    if (!isNaN(hr)) hourCounts[hr]++;
  });
  var peakHourIdx = 0;
  var peakHourMax = 0;
  for (var h = 0; h < 24; h++) {
    if (hourCounts[h] > peakHourMax) { peakHourMax = hourCounts[h]; peakHourIdx = h; }
  }
  var peakHourStr = peakHourMax > 0
    ? (String(peakHourIdx).padStart(2, '0') + ':00–' + String((peakHourIdx + 1) % 24).padStart(2, '0') + ':00')
    : null;

  // Top pages
  var pageCounts = {};
  shaped.forEach(function(r){
    var p = r.pageUrl || '';
    if (!p) return;
    // Normalise — strip protocol+host so we just get path
    var path = p.replace(/^https?:\/\/[^/]+/, '') || '/';
    pageCounts[path] = (pageCounts[path] || 0) + 1;
  });
  var topPages = Object.keys(pageCounts)
    .map(function(p){ return { path: p, count: pageCounts[p] }; })
    .sort(function(a, b){ return b.count - a.count; })
    .slice(0, 6);

  // Top topics (bonus — useful for the Stats panel even if not currently rendered)
  var topicCounts = {};
  shaped.forEach(function(r){
    (r.topicTags || []).forEach(function(t){
      topicCounts[t] = (topicCounts[t] || 0) + 1;
    });
  });
  var topTopics = Object.keys(topicCounts)
    .map(function(t){ return { topic: t, count: topicCounts[t] }; })
    .sort(function(a, b){ return b.count - a.count; })
    .slice(0, 8);

  return {
    total: total,
    aiOnly: aiOnly,
    escalated: escalated,
    aiPct: aiPct,
    avgDurationMins: Math.round(avgDuration * 10) / 10,
    avgMessages: Math.round(avgMessages * 10) / 10,
    avgRating: avgRating != null ? Math.round(avgRating * 10) / 10 : null,
    ratedCount: ratedCount,
    ratingDist: ratingDist,
    dayLabels: dayLabels,
    dayCounts: dayCounts,
    hourCounts: hourCounts,
    peakHourIdx: peakHourMax > 0 ? peakHourIdx : null,
    peakHourStr: peakHourStr,
    topPages: topPages,
    topTopics: topTopics
  };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  var clientName = (req.headers['x-client-name'] || req.query.client || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Missing client identifier' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  // ── AUTH (fail fast) ── Tenant analytics are private business intelligence.
  // Require a valid central session; client entitlement is checked below.
  var session = await auth.validateSession(req.headers.cookie || '');
  if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Not signed in' });

  try {
    var clientRecordId = await findClient(atKey, clientName);
    if (!clientRecordId) return res.status(404).json({ error: 'Client not found' });

    var entitled = await auth.resolveEntitledClient(atKey, session, clientRecordId);
    if (!entitled) return res.status(403).json({ error: 'Not entitled to this client' });

    var records = await fetchAllConversations(atKey, clientName);
    var metrics = computeMetrics(records);

    return res.status(200).json({
      success: true,
      clientName: clientName,
      generatedAt: new Date().toISOString(),
      metrics: metrics
    });
  } catch (err) {
    console.error('[luna-stats] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
