// Luna Conversation Quality Scorer
//
// Reads a conversation transcript, sends to Claude Haiku with a rubric, and
// writes back quality fields. If Luna couldn't answer well, also upserts a
// Knowledge Gap row so the gap surfaces in the Phase 2 dashboard.
//
// Called from api/log-conversation.js (fire-and-forget) when a conversation ends.

const Anthropic = require('@anthropic-ai/sdk');
const knowledge = require('../lib/knowledge');

const AT_BASE = 'app6Ot3eOb3DangkB';
const CONV_TABLE = 'tblyin27D2J9ejHvf';

const F = {
  convId: 'fldgQj90mYwsVO4yK',
  transcript: 'fld8fMjyXWmKcacoB',
  qualityScore: 'fld4mQMkFTccEE4T4',
  qualityReason: 'fldpf3QmfDuvnRMwo',
  wasAnswered: 'fldvmBP6C6MBa95K6',
  wasEscalated: 'fld3JapxKxGsBxPCQ',
  topicTags: 'fldQNFhnyo3W2ngTZ',
  knowledgeGap: 'fldZUDZXrtFCGUQUu',
  scoredAt: 'fldPm52hNNc4UhSRv',
  client: 'flde1PCByneD05YyG'
};

const RUBRIC_PROMPT = [
  'You are a conversation quality reviewer for a travel agency AI assistant called Luna.',
  'Read the transcript and rate Luna\'s performance.',
  '',
  'Return ONLY valid JSON, no other text. Schema:',
  '{',
  '  "score": 1-5 integer,',
  '  "reason": "one-sentence summary, max 200 chars",',
  '  "wasAnswered": true/false,',
  '  "topicTags": ["up", "to", "5", "short", "tags"],',
  '  "knowledgeGap": "if Luna stuck or hedged, what specific knowledge was missing? Otherwise empty string. Max 300 chars.",',
  '  "gapTopic": "if knowledgeGap is non-empty, a short topic label (e.g. \'Cancellation policy\', \'Albania destinations\'). Otherwise empty.",',
  '  "suggestedAnswer": "if there\'s a gap, draft a short answer Luna should have given. Otherwise empty. Max 500 chars."',
  '}',
  '',
  'Score guide:',
  '5 — Excellent. Visitor\'s question fully answered, accurate, warm, conversion-friendly.',
  '4 — Good. Answer was solid, only minor improvements possible.',
  '3 — Acceptable. Answered but could have been clearer or more helpful.',
  '2 — Weak. Hedged, deflected, or gave generic answer when specifics were needed.',
  '1 — Failed. Didn\'t answer, gave wrong info, or visitor likely left frustrated.',
  '',
  'wasAnswered: true if Luna gave a concrete on-topic answer. False if she said "I\'m not sure", "let me connect you", "I don\'t have that info", or only generic content.',
  '',
  'IMPORTANT — greetings and small talk are NOT failures and NOT knowledge gaps. If the visitor only greeted Luna or made small talk (e.g. "hi", "hello", "good morning", "thanks", "how are you") and never asked a real question, set wasAnswered to true, knowledgeGap to "", gapTopic to "", suggestedAnswer to "", and score at least 3. Never invent a knowledge gap for a greeting or pleasantry.',
  '',
  'topicTags examples: "destinations", "Crete", "cancellation policy", "pricing", "honeymoon", "all inclusive", "booking", "flights", "weather"',
  '',
  'knowledgeGap should be specific. Bad: "couldn\'t answer". Good: "didn\'t know if Jet2 fly to Faro from Manchester in winter".',
  ''
].join('\n');

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function findConversation(atKey, convId) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ConversationID}='" + convId.replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) || null;
}

function parseJsonFromReply(text) {
  if (!text) return null;
  // Tolerate wrapping fences or stray text — find first { and last }
  var first = text.indexOf('{');
  var last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  var candidate = text.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

// Pull out everything the visitor actually said from the stored transcript.
function visitorTextFrom(transcript) {
  var out = [];
  var re = /Visitor:\s*([\s\S]*?)(?=\n?\s*(?:Luna|Agent|Visitor):|$)/gi;
  var m;
  while ((m = re.exec(transcript)) !== null) {
    if (m[1] && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

// True when the visitor only greeted / made small talk and never asked a real
// question. Such conversations are not failures and must not create a gap.
// Deterministic and conservative: any "?" or any substantive word left after
// stripping greeting/pleasantry tokens means it is NOT trivial.
function isTrivialConversation(transcript) {
  var msgs = visitorTextFrom(transcript);
  if (!msgs.length) return true;                       // no visitor content at all
  var joined = msgs.join(' ').toLowerCase();
  if (joined.indexOf('?') !== -1) return false;        // a question was asked
  var stripped = joined
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(hi|hii|hiya|hey+|hello+|yo|hai|howdy|morning|afternoon|evening|night|good|day|how|are|is|was|you|u|ya|r|doing|thanks|thank|thankyou|ta|cheers|ok|okay|kk|kewl|cool|great|nice|yes|yeah|yep|yup|no|nope|nah|bye|goodbye|see|later|please|pls|test|testing|sup|greetings|hello there|welcome|here|there|just|looking|browsing|hm+|ah+|oh+|lol)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length < 4;                          // nothing substantive remains
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var atKey = process.env.AIRTABLE_KEY;
  var anKey = process.env.ANTHROPIC_API_KEY;
  if (!atKey || !anKey) return res.status(500).json({ error: 'Server not configured' });

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  var convId = (body.convId || '').toString().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 64);
  if (!convId) return res.status(400).json({ error: 'Missing convId' });

  try {
    var conv = await findConversation(atKey, convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    var fields = conv.fields || {};

    // Skip if already scored within last hour (idempotent re-runs from sendBeacon races)
    if (fields.QualityScore && fields.ScoredAt) {
      var lastScoredMs = Date.parse(fields.ScoredAt);
      if (lastScoredMs && Date.now() - lastScoredMs < 60 * 60 * 1000) {
        return res.status(200).json({ success: true, skipped: 'recently scored' });
      }
    }

    var transcript = fields.Transcript || '';
    if (!transcript || transcript.length < 30) {
      return res.status(200).json({ success: true, skipped: 'no transcript' });
    }

    // D3: a pure greeting / small-talk chat is not a failure and not a knowledge
    // gap. Detect it deterministically, write a neutral score with no gap, and
    // skip the model call entirely.
    if (isTrivialConversation(transcript)) {
      var trivialFields = {};
      trivialFields[F.qualityScore] = 3;
      trivialFields[F.qualityReason] = 'Greeting or small talk — no question was asked.';
      trivialFields[F.wasAnswered] = true;
      trivialFields[F.topicTags] = [];
      trivialFields[F.knowledgeGap] = '';
      trivialFields[F.scoredAt] = new Date().toISOString();
      try {
        await fetch('https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE + '/' + conv.id, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: trivialFields, typecast: true })
        });
      } catch (e) { console.warn('[quality] trivial write failed:', e.message); }
      return res.status(200).json({ success: true, skipped: 'greeting/small talk', score: 3 });
    }

    // Cap transcript size to keep scoring cheap (Haiku is fast, but huge contexts cost)
    if (transcript.length > 12000) transcript = transcript.slice(0, 12000) + '\n\n[transcript truncated]';

    var client = new Anthropic({ apiKey: anKey });
    var modelId = process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

    var resp;
    try {
      resp = await client.messages.create({
        model: modelId,
        max_tokens: 600,
        system: RUBRIC_PROMPT,
        messages: [{ role: 'user', content: 'Transcript:\n\n' + transcript + '\n\nReturn ONLY the JSON object.' }]
      });
    } catch (apiErr) {
      console.error('[quality] AI call failed:', apiErr.message);
      return res.status(500).json({ error: 'Scoring failed' });
    }

    var text = (resp.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
    var parsed = parseJsonFromReply(text);
    if (!parsed) {
      console.warn('[quality] could not parse JSON from Haiku output:', text.slice(0, 200));
      return res.status(200).json({ success: false, error: 'parse_failed' });
    }

    // Coerce shape
    var score = parseInt(parsed.score, 10);
    if (isNaN(score) || score < 1) score = 1;
    if (score > 5) score = 5;
    var reason = (typeof parsed.reason === 'string' ? parsed.reason : '').slice(0, 280);
    var wasAnswered = !!parsed.wasAnswered;
    var tags = Array.isArray(parsed.topicTags) ? parsed.topicTags
      .filter(function(t){ return typeof t === 'string' && t.length > 0 && t.length < 40; })
      .slice(0, 5) : [];
    var gap = (typeof parsed.knowledgeGap === 'string' ? parsed.knowledgeGap : '').slice(0, 400);
    var gapTopic = (typeof parsed.gapTopic === 'string' ? parsed.gapTopic : '').slice(0, 100);
    var suggestedAnswer = (typeof parsed.suggestedAnswer === 'string' ? parsed.suggestedAnswer : '').slice(0, 600);

    // Write back to Conversations
    var updateFields = {};
    updateFields[F.qualityScore] = score;
    updateFields[F.qualityReason] = reason;
    updateFields[F.wasAnswered] = wasAnswered;
    updateFields[F.topicTags] = tags;
    updateFields[F.knowledgeGap] = gap;
    updateFields[F.scoredAt] = new Date().toISOString();

    var patchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CONV_TABLE + '/' + conv.id;
    var pr = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: updateFields, typecast: true })
    });
    if (!pr.ok) {
      var pe = await pr.json();
      console.warn('[quality] update failed:', pe);
    }

    // If there's a gap, upsert a Knowledge Gap row for the dashboard
    if (gap && gapTopic) {
      var clientLinks = fields.Client;
      var clientRecordId = null;
      if (Array.isArray(clientLinks) && clientLinks.length > 0) {
        var first = clientLinks[0];
        clientRecordId = typeof first === 'object' ? first.id : first;
      }
      if (clientRecordId) {
        // Surface the original question — use the first visitor message in the transcript if possible
        // Extract the first visitor question. Stop at the next role boundary
        // (Luna:/Agent:) in case the transcript lacks proper newlines.
        var visitorMatch = transcript.match(/Visitor:\s*([\s\S]+?)(?=\s*(?:Luna|Agent):|$)/i);
        var visitorQ = (visitorMatch && visitorMatch[1] ? visitorMatch[1].trim() : '').slice(0, 200) || gapTopic;
        await knowledge.upsertKnowledgeGap(atKey, clientRecordId, visitorQ, gapTopic, convId, suggestedAnswer);
      }
    }

    return res.status(200).json({
      success: true,
      score: score,
      wasAnswered: wasAnswered,
      tags: tags,
      gapDetected: !!gap
    });

  } catch (err) {
    console.error('[quality] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
