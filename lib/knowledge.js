// Luna Knowledge module
//
// Fetches per-client Knowledge items at message-time and injects them into the
// system prompt as authoritative facts. Also tracks usage so we know which
// items earn their keep.
//
// Used by: luna-chat.js (in the system-prompt build), conversation-quality.js
// (for retrospective gap detection).

const AT_BASE = 'app6Ot3eOb3DangkB';
const KNOWLEDGE_TABLE = 'tblstATJ3BSqtuTDU';
const GAPS_TABLE = 'tblLkRcdcMIgmHPFj';

// Field IDs (verified 14 May 2026 via list_tables_for_base)
const F = {
  // Knowledge
  question: 'fldEm65vQmagn5WfR',
  variants: 'fldHytgAlS9MvoHRb',
  answer: 'fldAVVG7qfl8mlMPe',
  client: 'fldj3YnhyNZhvRaj1',
  type: 'fldQQ4us6LUFCNznB',
  status: 'fldV7EF0zOrMQNnkX',
  source: 'fldfOrjAdGsOGJUb0',
  confidence: 'fldWpz8NFGiPtOhEG',
  keywords: 'fldgfrOwdHSyH6vdG',
  timesUsed: 'fld6T7FgQD7KkE3IC',
  lastUsedAt: 'fldA6cYYHcRz9q66w',
  createdAt: 'fldzpn7RAyPRFOXTk',
  // Gaps
  gapQuestion: 'fldVuEp4b2Ik4nZme',
  gapClient: 'fldD6aP3yiY23c6d2',
  gapOccurrences: 'fld15dDIWU8z5c664',
  gapFirstSeen: 'flddaMcROMY2em2Bq',
  gapLastSeen: 'fldAX39WnQCZGBfWT',
  gapStatus: 'fld8dVJjF6nL6oCBR',
  gapTopic: 'fldTZJUuMC9uIjaq5',
  gapSuggestedAction: 'fldAa9SE4INxSgmR2',
  gapSuggestedAnswer: 'fldPVaZzBbY3mV0P3',
  gapExampleConvId: 'fldDT5ENwPHejXKTF'
};

// Common stopwords we strip before keyword matching.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'could', 'may', 'might', 'must', 'can', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my',
  'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'and', 'but', 'or', 'so', 'if', 'then', 'than', 'in', 'on', 'at', 'to',
  'for', 'of', 'with', 'by', 'from', 'about', 'as', 'into', 'through',
  'how', 'what', 'when', 'where', 'why', 'who', 'which', 'whose',
  'tell', 'me', 'please', 'thanks', 'thank'
]);

/**
 * Extract content words from a visitor message for keyword matching.
 * Lowercase, strip punctuation, drop stopwords, dedupe.
 * Returns array of words (max 8 to keep filterByFormula compact).
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  var words = text.toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(function(w) {
      return w.length >= 3 && !STOPWORDS.has(w);
    });
  // Dedupe, preserve first-seen order
  var seen = {};
  var out = [];
  for (var i = 0; i < words.length && out.length < 8; i++) {
    if (!seen[words[i]]) { seen[words[i]] = 1; out.push(words[i]); }
  }
  return out;
}

/**
 * Build an Airtable filterByFormula that:
 *   - Filters Knowledge to records linked to this Client AND
 *   - Status = "Active" AND
 *   - At least one keyword appears in Question, QuestionVariants, Keywords, or Answer.
 *
 * Airtable's FIND() is case-sensitive on raw values, so we LOWER() everything.
 * SEARCH() is the case-insensitive variant in Airtable formulas.
 *
 * filterByFormula has practical length limits (~16k chars) so we cap keyword count.
 */
function buildKnowledgeFormula(clientRecordId, keywords) {
  if (!keywords.length) return null;
  // Match client: FIND() in the linked-field's text representation works
  // because singleSelect/linked fields stringify to their names in formulas.
  // We use the actual record ID via the special {Client} = "recXXX" via ARRAYJOIN.
  // Cleaner: use the Client field's name (since each link's display value is the client name).
  // Even cleaner: filter server-side by clientRecordId via the FIND on the linked record's id field.
  // The most reliable pattern is to use the linked record's primary cell value
  // (the Client field surfaces as a comma-separated list of names). To filter by
  // record ID we use RECORD_ID() on each link's lookup; not available without a
  // lookup field. So we'll pre-filter via the linked-field's text representation
  // and require an additional check downstream. For now, match by Status + keywords
  // and post-filter by client record ID in JS.

  // Keyword clauses: each keyword is OR'd across Question, QuestionVariants, Keywords, Answer.
  var clauses = keywords.map(function(kw) {
    // Escape any single-quotes in the keyword
    var safe = kw.replace(/'/g, "\\'");
    return "OR(" +
      "FIND('" + safe + "', LOWER({Question})) > 0," +
      "FIND('" + safe + "', LOWER({QuestionVariants})) > 0," +
      "FIND('" + safe + "', LOWER({Keywords})) > 0," +
      "FIND('" + safe + "', LOWER({Answer})) > 0" +
    ")";
  });

  // Combine all clauses with OR (any keyword match) — we'll rank by hit count downstream.
  var keywordExpr = clauses.length === 1 ? clauses[0] : "OR(" + clauses.join(",") + ")";

  // Top-level: Status = "Active" AND (keyword match)
  return "AND({Status} = 'Active', " + keywordExpr + ")";
}

/**
 * Score a Knowledge record against the visitor's query keywords.
 * Returns a number — higher is better. Used to rank candidates.
 */
function scoreRecord(rec, keywords) {
  var f = rec.fields || {};
  var q = (f.Question || '').toLowerCase();
  var v = (f.QuestionVariants || '').toLowerCase();
  var k = (f.Keywords || '').toLowerCase();
  var a = (f.Answer || '').toLowerCase();

  var score = 0;
  keywords.forEach(function(kw) {
    if (q.indexOf(kw) !== -1) score += 5;      // question match is strongest
    if (v.indexOf(kw) !== -1) score += 4;      // variant nearly as good
    if (k.indexOf(kw) !== -1) score += 3;      // keyword field is intentional
    if (a.indexOf(kw) !== -1) score += 1;      // answer match is weakest signal
  });
  // Boost by Confidence
  var conf = f.Confidence;
  var confName = typeof conf === 'object' ? (conf && conf.name) : conf;
  if (confName === 'Verified') score += 2;
  // Boost recently-used items slightly (mature, used knowledge)
  if (f.TimesUsed && f.TimesUsed > 5) score += 1;
  return score;
}

/**
 * Fetch top N Knowledge items for a client matching a query.
 * Returns an array of { id, question, answer, type, confidence, score }.
 * Returns [] if no Airtable key, no client ID, or no matches.
 */
async function fetchKnowledgeItems(atKey, clientRecordId, query, limit) {
  limit = limit || 5;
  if (!atKey || !clientRecordId || !query) return [];

  var keywords = extractKeywords(query);
  if (!keywords.length) return [];

  var formula = buildKnowledgeFormula(clientRecordId, keywords);
  if (!formula) return [];

  try {
    // Pull a generous candidate set, then score+filter+limit in JS.
    var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + KNOWLEDGE_TABLE
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&maxRecords=50'
      + '&pageSize=50';
    var r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + atKey }
    });
    if (!r.ok) {
      console.warn('[knowledge] fetch failed:', r.status);
      return [];
    }
    var data = await r.json();
    var records = data.records || [];

    // Post-filter by client record ID (the linked Client field contains record IDs)
    var filtered = records.filter(function(rec) {
      var links = rec.fields && rec.fields.Client;
      if (!Array.isArray(links)) return false;
      // Airtable returns linked records as array of {id, name} OR array of IDs depending on field shape
      return links.some(function(l) {
        var id = (typeof l === 'object' && l) ? l.id : l;
        return id === clientRecordId;
      });
    });

    // Score and rank
    var scored = filtered.map(function(rec) {
      return { rec: rec, score: scoreRecord(rec, keywords) };
    }).filter(function(s) { return s.score > 0; })
      .sort(function(a, b) { return b.score - a.score; })
      .slice(0, limit);

    // Shape for prompt injection
    return scored.map(function(s) {
      var f = s.rec.fields || {};
      var t = f.Type;
      var c = f.Confidence;
      return {
        id: s.rec.id,
        question: f.Question || '',
        answer: f.Answer || '',
        type: typeof t === 'object' ? (t && t.name) : t,
        confidence: typeof c === 'object' ? (c && c.name) : c,
        score: s.score
      };
    });
  } catch (err) {
    console.warn('[knowledge] fetch error:', err.message);
    return [];
  }
}

/**
 * Format Knowledge items for injection into Luna's system prompt.
 * Returns a string suitable for appending to the prompt (or empty if no items).
 */
function formatKnowledgeForPrompt(items) {
  if (!items || !items.length) return '';
  var lines = [
    '',
    '## APPROVED ANSWERS — HIGHEST AUTHORITY',
    'The business owner has authored the following authoritative answers to common questions. These are the OFFICIAL position of this business and OVERRIDE any general knowledge, website-scraped content, or training data you have.',
    '',
    'When the visitor\'s question relates to any approved item below:',
    '  - Use that item\'s answer as the basis of your reply. The wording matters because it reflects how this business actually communicates and what is legally accurate for them.',
    '  - You may rephrase to flow with the conversation, but the SUBSTANCE (numbers, policies, conditions, recommendations) must be preserved exactly.',
    '  - You MUST emit the [KNOWLEDGE:recXXX] marker for each item you use, on its own line at the very end of your reply (before any [BLOCK]). This marker is stripped before the visitor sees it. Always include it. Never invent record IDs — copy them exactly from the items below.',
    '  - Do not blend with conflicting information from elsewhere (e.g. website-scraped content). If website content contradicts an approved answer, the approved answer wins.',
    ''
  ];
  items.forEach(function(item, idx) {
    lines.push('### Approved Item ' + (idx + 1));
    lines.push('Record ID: ' + item.id + '   (use marker [KNOWLEDGE:' + item.id + '] when you use this)');
    if (item.type) lines.push('Type: ' + item.type);
    lines.push('Question: ' + item.question);
    lines.push('Answer: ' + item.answer);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Increment TimesUsed and update LastUsedAt for the given knowledge item IDs.
 * Batches to 10 per Airtable call. Fire-and-forget — does not block the response.
 */
async function trackKnowledgeUsage(atKey, knowledgeRecordIds) {
  if (!atKey || !Array.isArray(knowledgeRecordIds) || !knowledgeRecordIds.length) return;
  var now = new Date().toISOString();

  // We need current TimesUsed to increment, so fetch first.
  try {
    var idsParam = knowledgeRecordIds.slice(0, 50).map(function(id) {
      return "RECORD_ID()='" + id.replace(/'/g, "\\'") + "'";
    }).join(',');
    var formula = idsParam.length === 1 ? idsParam[0] : 'OR(' + idsParam + ')';

    var fetchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + KNOWLEDGE_TABLE
      + '?filterByFormula=' + encodeURIComponent(formula)
      + '&maxRecords=50';
    var r = await fetch(fetchUrl, {
      headers: { 'Authorization': 'Bearer ' + atKey }
    });
    if (!r.ok) {
      console.warn('[knowledge] usage fetch failed:', r.status);
      return;
    }
    var data = await r.json();
    var records = data.records || [];

    // Build update payload — batch of up to 10 at a time
    var updates = records.map(function(rec) {
      var current = (rec.fields && rec.fields.TimesUsed) || 0;
      return {
        id: rec.id,
        fields: {
          TimesUsed: current + 1,
          LastUsedAt: now
        }
      };
    });

    // PATCH in batches of 10
    for (var i = 0; i < updates.length; i += 10) {
      var batch = updates.slice(i, i + 10);
      var patchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + KNOWLEDGE_TABLE;
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + atKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ records: batch })
      });
    }
  } catch (err) {
    console.warn('[knowledge] usage tracking error:', err.message);
  }
}

/**
 * Extract [KNOWLEDGE:recXXX] markers from a Luna reply. Returns:
 *   { ids: [...], cleaned: "reply with markers stripped" }
 */
function extractKnowledgeMarkers(reply) {
  if (!reply || typeof reply !== 'string') return { ids: [], cleaned: reply || '' };
  var ids = [];
  // Match [KNOWLEDGE:recXXXXXXXXXXXXXXXX] (record IDs are 17 chars: "rec" + 14)
  var re = /\[KNOWLEDGE:(rec[A-Za-z0-9]{14})\]/g;
  var m;
  while ((m = re.exec(reply)) !== null) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  // Strip markers (and any trailing whitespace they left behind)
  var cleaned = reply.replace(/\s*\[KNOWLEDGE:rec[A-Za-z0-9]{14}\]\s*/g, '').trim();
  return { ids: ids, cleaned: cleaned };
}

/**
 * Upsert a Knowledge Gap row. Called when Luna couldn't answer or quality was low.
 *   - If a gap with similar topic exists for this client, increment Occurrences + LastSeenAt.
 *   - Otherwise create a new gap row.
 */
async function upsertKnowledgeGap(atKey, clientRecordId, question, topic, convId, suggestedAnswer) {
  if (!atKey || !clientRecordId || !question) return;
  var now = new Date().toISOString();
  try {
    // Look for an existing gap on the same topic (case-insensitive)
    var topicSafe = (topic || '').toLowerCase().replace(/'/g, "\\'");
    var existingUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + GAPS_TABLE
      + '?filterByFormula=' + encodeURIComponent(
          "AND(LOWER({Topic}) = '" + topicSafe + "', {Status} != 'Resolved')"
        )
      + '&maxRecords=10';
    var r = await fetch(existingUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    var data = r.ok ? await r.json() : { records: [] };
    var records = data.records || [];

    // Filter to this client
    var match = records.find(function(rec) {
      var links = rec.fields && rec.fields.Client;
      if (!Array.isArray(links)) return false;
      return links.some(function(l) {
        var id = (typeof l === 'object' && l) ? l.id : l;
        return id === clientRecordId;
      });
    });

    if (match) {
      // Increment
      var cur = (match.fields && match.fields.Occurrences) || 1;
      await fetch('https://api.airtable.com/v0/' + AT_BASE + '/' + GAPS_TABLE, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + atKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          records: [{
            id: match.id,
            fields: { Occurrences: cur + 1, LastSeenAt: now, ExampleConvId: convId || '' }
          }]
        })
      });
    } else {
      // Create
      await fetch('https://api.airtable.com/v0/' + AT_BASE + '/' + GAPS_TABLE, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + atKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          records: [{
            fields: {
              Question: question,
              Client: [clientRecordId],
              Occurrences: 1,
              FirstSeenAt: now,
              LastSeenAt: now,
              Status: 'Open',
              Topic: topic || question.slice(0, 80),
              SuggestedAction: 'Add Knowledge item',
              SuggestedAnswer: suggestedAnswer || '',
              ExampleConvId: convId || ''
            }
          }],
          typecast: true
        })
      });
    }
  } catch (err) {
    console.warn('[knowledge] gap upsert error:', err.message);
  }
}

/**
 * Extract distinctive tokens from a Knowledge Answer for similarity matching.
 * "Distinctive" means: tokens that are unlikely to appear in generic prose.
 *   - Numbers (14, 25, 100, etc.)
 *   - Proper nouns (capitalised words mid-sentence)
 *   - Domain-specific terms (longer words, not stopwords)
 */
function extractDistinctiveTokens(text) {
  if (!text) return [];
  var tokens = new Set();
  // Numbers (any digit string)
  var numberMatches = text.match(/\b\d+\b/g) || [];
  numberMatches.forEach(function(n){ tokens.add(n); });
  // Words 5+ chars (after lowercasing), not stopwords
  var wordMatches = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
  wordMatches.forEach(function(w){
    if (!STOPWORDS.has(w)) tokens.add(w);
  });
  return Array.from(tokens);
}

/**
 * Score how much of a candidate Answer's distinctive content appears in Luna's reply.
 * Returns a value 0..1 representing fraction matched.
 */
function similarityScore(replyText, candidateAnswer) {
  if (!replyText || !candidateAnswer) return 0;
  var candidateTokens = extractDistinctiveTokens(candidateAnswer);
  if (!candidateTokens.length) return 0;
  var replyLower = replyText.toLowerCase();
  var hits = 0;
  candidateTokens.forEach(function(t){
    // Word-boundary match for words, substring for numbers
    if (/^\d+$/.test(t)) {
      if (replyLower.indexOf(t) !== -1) hits++;
    } else {
      var re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(replyLower)) hits++;
    }
  });
  return hits / candidateTokens.length;
}

/**
 * Given Luna's reply and a list of candidate Knowledge items (those we injected
 * into the system prompt for this turn), figure out which items she actually used.
 * Strategy: prefer markers if she emitted any; otherwise use similarity score
 * with a conservative threshold (0.40 — at least 40% of distinctive tokens must match).
 *
 * Returns an array of record IDs.
 */
function inferUsedKnowledge(replyText, candidates, markerIds) {
  // If the model emitted markers, trust those (and validate against candidates).
  if (Array.isArray(markerIds) && markerIds.length > 0) {
    return markerIds.filter(function(id) {
      return candidates.some(function(c) { return c.id === id; });
    });
  }
  // Fall back to similarity. candidates is [{id, question, answer, ...}, ...]
  if (!Array.isArray(candidates) || !candidates.length) return [];
  var used = [];
  candidates.forEach(function(c) {
    var s = similarityScore(replyText, c.answer);
    if (s >= 0.40) used.push(c.id);
  });
  return used;
}

module.exports = {
  fetchKnowledgeItems: fetchKnowledgeItems,
  formatKnowledgeForPrompt: formatKnowledgeForPrompt,
  trackKnowledgeUsage: trackKnowledgeUsage,
  extractKnowledgeMarkers: extractKnowledgeMarkers,
  upsertKnowledgeGap: upsertKnowledgeGap,
  extractKeywords: extractKeywords,
  similarityScore: similarityScore,
  inferUsedKnowledge: inferUsedKnowledge
};
