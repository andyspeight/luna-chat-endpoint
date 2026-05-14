// Luna Brain — agency owner's gap and quality dashboard backend
//
// One endpoint with three actions selected by ?action= query param:
//   - feed          (GET)  — returns gaps + low-quality conversations + top knowledge
//   - approve-gap   (POST) — creates Knowledge item from gap's SuggestedAnswer, marks Resolved
//   - update-gap    (POST) — change gap status (Resolved, WontFix, In Progress)
//   - dismiss-conv  (POST) — flag a low-quality conversation as reviewed (raises QualityScore manually)
//
// Auth: X-Client-Name header set by tg-auth-gate session (same pattern as /api/profile).

const AT_BASE = 'app6Ot3eOb3DangkB';
const KNOWLEDGE_TABLE = 'tblstATJ3BSqtuTDU';
const GAPS_TABLE = 'tblLkRcdcMIgmHPFj';
const CONV_TABLE = 'tblyin27D2J9ejHvf';
const CLIENTS_TABLE = 'tbl6CZ7aVzq1wHF2v';

const F = {
  // Knowledge
  kQuestion: 'fldEm65vQmagn5WfR',
  kVariants: 'fldHytgAlS9MvoHRb',
  kAnswer: 'fldAVVG7qfl8mlMPe',
  kClient: 'fldj3YnhyNZhvRaj1',
  kType: 'fldQQ4us6LUFCNznB',
  kStatus: 'fldV7EF0zOrMQNnkX',
  kSource: 'fldfOrjAdGsOGJUb0',
  kConfidence: 'fldWpz8NFGiPtOhEG',
  kTimesUsed: 'fld6T7FgQD7KkE3IC',
  kLastUsedAt: 'fldA6cYYHcRz9q66w',
  // Gaps
  gQuestion: 'fldVuEp4b2Ik4nZme',
  gClient: 'fldD6aP3yiY23c6d2',
  gOccurrences: 'fld15dDIWU8z5c664',
  gFirstSeen: 'flddaMcROMY2em2Bq',
  gLastSeen: 'fldAX39WnQCZGBfWT',
  gStatus: 'fld8dVJjF6nL6oCBR',
  gTopic: 'fldTZJUuMC9uIjaq5',
  gSuggestedAction: 'fldAa9SE4INxSgmR2',
  gSuggestedAnswer: 'fldPVaZzBbY3mV0P3',
  gLinkedKnowledge: 'fldo9ZCeRgs93HJXc',
  // Conversations
  cId: 'fldgQj90mYwsVO4yK',
  cTranscript: 'fld8fMjyXWmKcacoB',
  cQualityScore: 'fld4mQMkFTccEE4T4',
  cQualityReason: 'fldpf3QmfDuvnRMwo',
  cWasAnswered: 'fldvmBP6C6MBa95K6',
  cTopicTags: 'fldQNFhnyo3W2ngTZ',
  cKnowledgeGap: 'fldZUDZXrtFCGUQUu',
  cScoredAt: 'fldPm52hNNc4UhSRv',
  cClient: 'flde1PCByneD05YyG',
  cStartedAt: 'fldSoy7BMqyzVb5pp'
};

const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io',
  'https://luna-chat.travelify.io',
  'https://widgets.travelify.io',
  'http://localhost:3000',
  'http://localhost:5173'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name, X-Client-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function findClient(atKey, clientName) {
  var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + CLIENTS_TABLE
    + '?filterByFormula=' + encodeURIComponent("{ClientName}='" + clientName.replace(/'/g, "\\'") + "'")
    + '&maxRecords=1';
  var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + atKey } });
  if (!r.ok) return null;
  var d = await r.json();
  return (d.records && d.records[0]) ? d.records[0].id : null;
}

async function atFetch(atKey, path, opts) {
  opts = opts || {};
  var headers = { 'Authorization': 'Bearer ' + atKey };
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  var r = await fetch('https://api.airtable.com/v0/' + AT_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    var err = await r.json().catch(function(){ return {}; });
    throw new Error('Airtable ' + r.status + ': ' + ((err.error && err.error.message) || 'unknown'));
  }
  return r.json();
}

function valueOf(field) {
  if (!field) return '';
  if (typeof field === 'object' && field.name) return field.name;
  return field;
}

async function actionFeed(atKey, clientRecordId, clientName) {
  // Filter conversations / gaps / knowledge by the linked-client name.
  // Airtable's ARRAYJOIN() on a linked record field returns the linked records'
  // display names, not their IDs. So we match by name (which is unique per client).
  var safeName = (clientName || '').replace(/'/g, "\\'");
  var clientLinkFilter = "FIND('" + safeName + "', ARRAYJOIN({Client})) > 0";

  var gapsP = atFetch(atKey,
    '/' + GAPS_TABLE
    + '?filterByFormula=' + encodeURIComponent("AND(" + clientLinkFilter + ", {Status} != 'Resolved', {Status} != 'WontFix')")
    + '&sort[0][field]=Occurrences&sort[0][direction]=desc'
    + '&maxRecords=50'
  );

  var lowQualP = atFetch(atKey,
    '/' + CONV_TABLE
    + '?filterByFormula=' + encodeURIComponent("AND(" + clientLinkFilter + ", {QualityScore} > 0, {QualityScore} <= 2)")
    + '&sort[0][field]=ScoredAt&sort[0][direction]=desc'
    + '&maxRecords=20'
  );

  var topKnowP = atFetch(atKey,
    '/' + KNOWLEDGE_TABLE
    + '?filterByFormula=' + encodeURIComponent("AND(" + clientLinkFilter + ", {Status} = 'Active')")
    + '&sort[0][field]=TimesUsed&sort[0][direction]=desc'
    + '&maxRecords=20'
  );

  var summaryP = atFetch(atKey,
    '/' + CONV_TABLE
    + '?filterByFormula=' + encodeURIComponent("AND(" + clientLinkFilter + ", DATETIME_DIFF(NOW(), {ScoredAt}, 'days') <= 7)")
    + '&fields[]=QualityScore&fields[]=WasAnswered'
    + '&maxRecords=500'
  );

  var results = await Promise.all([gapsP, lowQualP, topKnowP, summaryP]);
  var gapsData = results[0];
  var lowQualData = results[1];
  var topKnowData = results[2];
  var summaryData = results[3];

  // Shape gaps
  var gaps = (gapsData.records || []).map(function(rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      question: f.Question || '',
      topic: f.Topic || '',
      occurrences: f.Occurrences || 1,
      firstSeenAt: f.FirstSeenAt || null,
      lastSeenAt: f.LastSeenAt || null,
      status: valueOf(f.Status) || 'Open',
      suggestedAction: valueOf(f.SuggestedAction) || '',
      suggestedAnswer: f.SuggestedAnswer || ''
    };
  });

  // Shape low-quality conversations
  var lowQual = (lowQualData.records || []).map(function(rec) {
    var f = rec.fields || {};
    var tags = Array.isArray(f.TopicTags) ? f.TopicTags.map(function(t){ return typeof t === 'object' ? t.name : t; }) : [];
    return {
      id: rec.id,
      convId: f.ConversationID || '',
      score: f.QualityScore || 0,
      reason: f.QualityReason || '',
      wasAnswered: !!f.WasAnswered,
      topicTags: tags,
      knowledgeGap: f.KnowledgeGap || '',
      transcript: (f.Transcript || '').slice(0, 1200),
      scoredAt: f.ScoredAt || null,
      startedAt: f.StartedAt || null
    };
  });

  // Shape top knowledge
  var topKnow = (topKnowData.records || []).map(function(rec) {
    var f = rec.fields || {};
    return {
      id: rec.id,
      question: f.Question || '',
      answer: f.Answer || '',
      type: valueOf(f.Type) || '',
      status: valueOf(f.Status) || 'Active',
      confidence: valueOf(f.Confidence) || '',
      source: valueOf(f.Source) || '',
      timesUsed: f.TimesUsed || 0,
      lastUsedAt: f.LastUsedAt || null
    };
  });

  // Summary stats — last 7 days
  var allConvs = summaryData.records || [];
  var totalConvs = allConvs.length;
  var scoredConvs = allConvs.filter(function(r){ return r.fields && typeof r.fields.QualityScore === 'number'; });
  var avgScore = scoredConvs.length
    ? (scoredConvs.reduce(function(sum, r){ return sum + r.fields.QualityScore; }, 0) / scoredConvs.length)
    : 0;
  var answeredCount = allConvs.filter(function(r){ return r.fields && r.fields.WasAnswered; }).length;
  var answerRate = totalConvs ? (answeredCount / totalConvs) : 0;

  return {
    summary: {
      conversations7d: totalConvs,
      avgQualityScore: Math.round(avgScore * 10) / 10,
      answerRate: Math.round(answerRate * 100),
      openGaps: gaps.length,
      lowQualityCount: lowQual.length
    },
    gaps: gaps,
    lowQualityConversations: lowQual,
    topKnowledge: topKnow
  };
}

async function actionApproveGap(atKey, clientRecordId, body) {
  var gapId = (body.gapId || '').trim();
  if (!gapId || !/^rec[A-Za-z0-9]{14}$/.test(gapId)) {
    throw new Error('Invalid gapId');
  }
  // Allow caller to override the suggested answer (edit-then-approve flow)
  var question = (body.question || '').trim();
  var answer = (body.answer || '').trim();
  var type = (body.type || 'FAQ').trim();

  // Fetch the gap to confirm it exists and belongs to this client
  var gapData = await atFetch(atKey, '/' + GAPS_TABLE + '/' + gapId);
  var gapFields = gapData.fields || {};
  var gapClient = (gapFields.Client && gapFields.Client[0]) ? (typeof gapFields.Client[0] === 'object' ? gapFields.Client[0].id : gapFields.Client[0]) : null;
  if (gapClient !== clientRecordId) {
    throw new Error('Gap belongs to a different client');
  }
  if (!question) question = gapFields.Question || 'Untitled';
  if (!answer) answer = gapFields.SuggestedAnswer || '';
  if (!answer) throw new Error('No answer provided');

  // Create Knowledge item
  var nowIso = new Date().toISOString();
  var newKnowledge = await atFetch(atKey, '/' + KNOWLEDGE_TABLE, {
    method: 'POST',
    body: {
      records: [{
        fields: {
          Question: question,
          Answer: answer,
          Client: [clientRecordId],
          Type: type,
          Status: 'Active',
          Source: 'From Escalation',
          Confidence: 'Needs Review',
          CreatedAt: nowIso,
          TimesUsed: 0
        }
      }],
      typecast: true
    }
  });

  var newKnowledgeId = newKnowledge.records[0].id;

  // Mark gap Resolved and link it to the new Knowledge item
  await atFetch(atKey, '/' + GAPS_TABLE + '/' + gapId, {
    method: 'PATCH',
    body: {
      fields: {
        Status: 'Resolved',
        LinkedKnowledge: [newKnowledgeId]
      },
      typecast: true
    }
  });

  return { ok: true, knowledgeId: newKnowledgeId, gapId: gapId };
}

async function actionUpdateGap(atKey, clientRecordId, body) {
  var gapId = (body.gapId || '').trim();
  var newStatus = (body.status || '').trim();
  var validStatuses = ['Open', 'In Progress', 'Resolved', 'WontFix'];
  if (!gapId || !/^rec[A-Za-z0-9]{14}$/.test(gapId)) throw new Error('Invalid gapId');
  if (validStatuses.indexOf(newStatus) === -1) throw new Error('Invalid status');

  // Verify ownership
  var gapData = await atFetch(atKey, '/' + GAPS_TABLE + '/' + gapId);
  var gapFields = gapData.fields || {};
  var gapClient = (gapFields.Client && gapFields.Client[0]) ? (typeof gapFields.Client[0] === 'object' ? gapFields.Client[0].id : gapFields.Client[0]) : null;
  if (gapClient !== clientRecordId) throw new Error('Gap belongs to a different client');

  await atFetch(atKey, '/' + GAPS_TABLE + '/' + gapId, {
    method: 'PATCH',
    body: { fields: { Status: newStatus }, typecast: true }
  });
  return { ok: true, gapId: gapId, status: newStatus };
}

async function actionUpdateKnowledge(atKey, clientRecordId, body) {
  // Inline-edit a Knowledge item from the dashboard.
  var knowledgeId = (body.knowledgeId || '').trim();
  if (!knowledgeId || !/^rec[A-Za-z0-9]{14}$/.test(knowledgeId)) throw new Error('Invalid knowledgeId');
  var data = await atFetch(atKey, '/' + KNOWLEDGE_TABLE + '/' + knowledgeId);
  var f = data.fields || {};
  var fClient = (f.Client && f.Client[0]) ? (typeof f.Client[0] === 'object' ? f.Client[0].id : f.Client[0]) : null;
  if (fClient !== clientRecordId) throw new Error('Item belongs to a different client');

  var update = {};
  if (typeof body.question === 'string') update.Question = body.question.slice(0, 500);
  if (typeof body.answer === 'string') update.Answer = body.answer.slice(0, 5000);
  if (typeof body.status === 'string' && ['Active','Draft','Archived'].indexOf(body.status) !== -1) update.Status = body.status;
  if (Object.keys(update).length === 0) throw new Error('No fields to update');

  await atFetch(atKey, '/' + KNOWLEDGE_TABLE + '/' + knowledgeId, {
    method: 'PATCH',
    body: { fields: update, typecast: true }
  });
  return { ok: true, knowledgeId: knowledgeId };
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  var clientName = (req.headers['x-client-name'] || req.query.client || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Missing client identifier' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var action = (req.query.action || '').trim();

  try {
    var clientRecordId = await findClient(atKey, clientName);
    if (!clientRecordId) return res.status(404).json({ error: 'Client not found' });

    if (req.method === 'GET' && (action === 'feed' || action === '')) {
      var data = await actionFeed(atKey, clientRecordId, clientName);
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      var body;
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      } catch (e) {
        return res.status(400).json({ error: 'Invalid body' });
      }

      if (action === 'approve-gap') {
        return res.status(200).json(await actionApproveGap(atKey, clientRecordId, body));
      }
      if (action === 'update-gap') {
        return res.status(200).json(await actionUpdateGap(atKey, clientRecordId, body));
      }
      if (action === 'update-knowledge') {
        return res.status(200).json(await actionUpdateKnowledge(atKey, clientRecordId, body));
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[luna-brain] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
