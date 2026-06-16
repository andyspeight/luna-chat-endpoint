// lib/discover.js
// Turns scraped page text into candidate "what's new / things to do" knowledge
// items for a client. The actual LLM call lives in api/discover-scan.js; this
// module owns the pure, testable parts: building the extraction prompt, parsing
// and validating the model's JSON, and de-duplicating against existing knowledge.
//
// Anti-hallucination posture: candidates are EXTRACTION ONLY. The prompt forbids
// adding anything not present in the page text, every candidate is written back
// as Draft / Needs Review / Suggested by Luna, and a human approves it in Luna
// Brain before Luna will ever use it. Nothing here is auto-served as fact.

'use strict';

// Knowledge Type used for discovered items (exists in the Knowledge table schema).
var TARGET_TYPE = 'Destination Note';

var MAX_CANDIDATES = 6;

// Build the system + user prompt for the extraction model.
function buildExtractionPrompt(pageText, opts) {
  opts = opts || {};
  var destination = (opts.destination || '').trim();
  var sourceUrl = (opts.sourceUrl || '').trim();
  var existing = Array.isArray(opts.existingQuestions) ? opts.existingQuestions.slice(0, 40) : [];

  var system = [
    'You extract NEW, concrete, currently-useful travel knowledge from a single web page for a UK travel agency assistant called Luna.',
    'You are an extractor, not a writer. Use ONLY facts that are explicitly present in the page text below. Never add anything from your own general knowledge. If the page does not state it, do not include it.',
    '',
    'Focus on things a customer would find useful and that go stale: things to do, new attractions or openings, events and festivals with their dates, seasonal highlights, closures, changes to a resort or destination.',
    'Ignore navigation, marketing slogans, cookie notices, prices unless the page states them clearly, and anything not concrete.',
    '',
    'Output ONLY a JSON array (no prose, no code fences). Each element:',
    '{ "question": "<a natural question a visitor might ask, e.g. What is there to do in <place>?>",',
    '  "answer": "<1 to 2 sentences, naming the specific places, events or dates from the page>",',
    '  "confidence": "high" | "medium" }',
    '',
    'Rules:',
    '- At most ' + MAX_CANDIDATES + ' items. Fewer is fine. If nothing concrete and new is on the page, return [].',
    '- Each answer must be supported word-for-word by the page text. No embellishment.',
    '- UK English. No em-dashes (use commas or full stops). No Oxford commas. No marketing fluff.',
    '- Set confidence "medium" if the page is vague or the detail might be time-limited.',
    '- Do not repeat anything already covered by the EXISTING QUESTIONS list.',
    destination ? ('- This page is about: ' + destination + '.') : '',
    '',
    existing.length ? ('EXISTING QUESTIONS (do not duplicate):\n' + existing.map(function (q) { return '- ' + q; }).join('\n')) : 'EXISTING QUESTIONS: (none)'
  ].filter(Boolean).join('\n');

  var user = 'PAGE' + (sourceUrl ? (' (' + sourceUrl + ')') : '') + ':\n\n' + String(pageText || '').slice(0, 12000) + '\n\nExtract the JSON array now.';

  return { system: system, user: user };
}

// Parse the model's reply into a raw candidate array. Tolerant of code fences
// and surrounding prose. Returns [] on any parse failure (never throws).
function parseCandidates(text) {
  if (!text || typeof text !== 'string') return [];
  var t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  var first = t.indexOf('[');
  var last = t.lastIndexOf(']');
  if (first === -1 || last <= first) return [];
  var slice = t.slice(first, last + 1);
  try {
    var arr = JSON.parse(slice);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function clampText(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Validate + normalise one candidate. Returns a clean object or null.
function validateCandidate(raw, opts) {
  opts = opts || {};
  if (!raw || typeof raw !== 'object') return null;
  var question = clampText(raw.question, 150);
  var answer = clampText(raw.answer, 600);
  if (question.length < 8 || answer.length < 20) return null;
  // No em-dashes allowed in either field (house style).
  question = question.replace(/\s*—\s*/g, ', ');
  answer = answer.replace(/\s*—\s*/g, ', ');
  var conf = (raw.confidence === 'high') ? 'high' : 'medium';
  return {
    question: question,
    answer: answer,
    confidence: conf,                 // model's self-rating, NOT the stored Confidence
    type: TARGET_TYPE,
    sourceUrl: clampText(opts.sourceUrl || '', 500)
  };
}

// Local, uncapped, lightly-stemmed tokeniser for dedup. Deliberately separate
// from knowledge.extractKeywords (which caps at 8 tokens for Airtable formulas).
// Light stemming lets "open" match "opened" and "beach" match "beaches".
var DEDUP_STOP = new Set(('a an the is are was were be been being have has had do does did will would shall ' +
  'should could may might must can i you he she it we they me him her us them my your his its our their ' +
  'this that these those and but or so if then than in on at to for of with by from about as into through ' +
  'how what when where why who which whose tell please thanks thank there here your you new old many much more').split(' '));

function stem(w) {
  return w.replace(/(ing|ed|es|s)$/, '');
}

function tokenSet(text) {
  var set = new Set();
  if (!text) return set;
  String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(function (w) {
    if (w.length >= 3 && !DEDUP_STOP.has(w)) {
      var s = stem(w);
      if (s.length >= 3) set.add(s);
    }
  });
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  var inter = 0;
  a.forEach(function (x) { if (b.has(x)) inter++; });
  return inter / (a.size + b.size - inter);
}

function overlapsAny(tokens, sets, threshold) {
  threshold = threshold == null ? 0.5 : threshold;
  if (!tokens.size) return false;
  for (var i = 0; i < sets.length; i++) {
    if (jaccard(tokens, sets[i]) >= threshold) return true;
  }
  return false;
}

// True when a candidate question substantially overlaps any existing question.
// Exported for callers/tests that only have question strings to compare.
function isDuplicate(candidateQuestion, existingQuestions, threshold) {
  var existingSets = (existingQuestions || []).map(tokenSet);
  return overlapsAny(tokenSet(candidateQuestion), existingSets, threshold);
}

// Full pipeline from raw model text to clean, deduped, validated candidates.
//   existingQuestions: array of question strings already in the client's KB.
// Dedup vs the existing KB is on question tokens (all we cheaply have); dedup
// WITHIN this batch is on question + answer tokens, so two items describing the
// same event collapse even when phrased as different questions.
function processCandidates(modelText, opts) {
  opts = opts || {};
  var existing = Array.isArray(opts.existingQuestions) ? opts.existingQuestions : [];
  // Scope the existing-KB dedup to questions about the SAME destination, so two
  // questions that share only a template ("events coming up in Italy" vs
  // "...in Cyprus") are never treated as duplicates of each other. Without this,
  // one approved templated question blocks the same template for every other
  // place. When no destination is given, fall back to comparing against all.
  var destFilter = (opts.destination || '').trim().toLowerCase();
  var scopedExisting = destFilter
    ? existing.filter(function (q) { return String(q).toLowerCase().indexOf(destFilter) !== -1; })
    : existing;
  var existingSets = scopedExisting.map(tokenSet);
  var threshold = opts.threshold;

  var out = [];
  var seenFull = [];
  parseCandidates(modelText).forEach(function (raw) {
    var c = validateCandidate(raw, opts);
    if (!c) return;
    var qTokens = tokenSet(c.question);
    var fullTokens = tokenSet(c.question + ' ' + c.answer);
    if (overlapsAny(qTokens, existingSets, threshold)) return;  // dup of existing KB
    if (overlapsAny(fullTokens, seenFull, threshold)) return;   // dup within this batch
    seenFull.push(fullTokens);
    out.push(c);
  });
  return out.slice(0, MAX_CANDIDATES);
}

module.exports = {
  TARGET_TYPE: TARGET_TYPE,
  MAX_CANDIDATES: MAX_CANDIDATES,
  buildExtractionPrompt: buildExtractionPrompt,
  parseCandidates: parseCandidates,
  validateCandidate: validateCandidate,
  isDuplicate: isDuplicate,
  processCandidates: processCandidates
};
