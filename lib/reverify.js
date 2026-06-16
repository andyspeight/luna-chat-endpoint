// lib/reverify.js
// Grounded re-verification of a saved knowledge answer against its cited source.
//
// This is the anti-staleness core. It NEVER refreshes a fact from the model's
// own memory (that would be hallucination). It only ever asks the model to act
// as a CHECKER: given a saved answer and the text of its Source URL, is the
// answer still supported by that source? It may use ONLY the source text.
//
// Outcomes:
//   confirmed     - source still supports the answer -> eligible to reset Last Verified.
//   changed       - source contradicts/updates it -> source-grounded suggestion + evidence, human approves.
//   unverifiable  - source does not cover it (or is too thin) -> flag only, never guess.
//
// Fail-safe: any malformed model reply parses to "unverifiable", so a bad
// response can never produce a false "confirmed" that wrongly resets freshness.
//
// The LLM call lives in the endpoint; this module owns the pure, testable parts:
// building the checker prompt and parsing/validating the verdict.

'use strict';

var VERDICTS = ['confirmed', 'changed', 'unverifiable'];

function clampText(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Build the system + user prompt for the checker.
function buildVerificationPrompt(record, sourceText, opts) {
  opts = opts || {};
  record = record || {};
  var question = clampText(record.question, 300);
  var answer = clampText(record.answer, 2000);
  var sourceUrl = clampText(record.sourceUrl || opts.sourceUrl, 500);

  var system = [
    'You re-verify a single saved answer in a UK travel agency knowledge base against a SOURCE web page. You are a CHECKER, not an author.',
    '',
    'ABSOLUTE RULES:',
    '- Use ONLY the SOURCE TEXT provided. Never use your own knowledge or anything not present in the source.',
    '- If the source does not clearly address the answer, you MUST return "unverifiable". Do not guess, and do not fill gaps from memory.',
    '- Never invent facts, dates, prices or policies. Any suggested correction must come straight from the source, with the supporting sentence quoted in "evidence".',
    '- UK English. No em-dashes (use commas or full stops). No Oxford commas.',
    '',
    'Return ONLY a JSON object (no prose, no code fences):',
    '{ "verdict": "confirmed" | "changed" | "unverifiable",',
    '  "evidence": "<a short verbatim quote from the source supporting your verdict, or empty>",',
    '  "changedDetail": "<if changed: one sentence on what specifically differs, else empty>",',
    '  "suggestedAnswer": "<if changed: a corrected answer using ONLY the source, else empty>" }',
    '',
    'verdict meanings:',
    '- confirmed: the source still supports the saved answer\'s key facts. Quote the supporting sentence in evidence.',
    '- changed: the source contradicts or updates the saved answer. Give changedDetail, a source-grounded suggestedAnswer, and the evidence quote.',
    '- unverifiable: the source does not cover this, or is too thin to judge. Return empty evidence/detail/answer. This is the correct, expected answer whenever you cannot tell from the source alone. Never substitute your own knowledge to avoid it.'
  ].join('\n');

  var user = 'SAVED QUESTION: ' + question + '\n'
    + 'SAVED ANSWER: ' + answer + '\n\n'
    + 'SOURCE' + (sourceUrl ? (' (' + sourceUrl + ')') : '') + ':\n'
    + clampText(sourceText, 12000) + '\n\n'
    + 'Return the JSON verdict now.';

  return { system: system, user: user };
}

// Parse + validate the model's reply. Fail-safe: anything unexpected becomes
// "unverifiable" so a malformed reply can never yield a false "confirmed".
function parseVerdict(text) {
  var fallback = { verdict: 'unverifiable', evidence: '', changedDetail: '', suggestedAnswer: '' };
  if (!text || typeof text !== 'string') return fallback;
  var t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  var first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first === -1 || last <= first) return fallback;
  var obj;
  try { obj = JSON.parse(t.slice(first, last + 1)); } catch (e) { return fallback; }
  if (!obj || VERDICTS.indexOf(obj.verdict) === -1) return fallback;

  var out = {
    verdict: obj.verdict,
    evidence: clampText(obj.evidence, 600).replace(/\s*—\s*/g, ', '),
    changedDetail: clampText(obj.changedDetail, 400).replace(/\s*—\s*/g, ', '),
    suggestedAnswer: clampText(obj.suggestedAnswer, 2000).replace(/\s*—\s*/g, ', ')
  };

  // Integrity: a "changed" verdict is only trustworthy with a concrete
  // suggestion AND evidence. Without both, downgrade to unverifiable rather
  // than surface a vague "something changed" with nothing to act on.
  if (out.verdict === 'changed' && (!out.suggestedAnswer || !out.evidence)) {
    return { verdict: 'unverifiable', evidence: out.evidence, changedDetail: out.changedDetail, suggestedAnswer: '' };
  }
  // Integrity: a "confirmed" verdict should cite supporting evidence. Without
  // it, treat as unverifiable so we never reset freshness on an unsupported claim.
  if (out.verdict === 'confirmed' && !out.evidence) {
    return { verdict: 'unverifiable', evidence: '', changedDetail: '', suggestedAnswer: '' };
  }
  return out;
}

// Map a verdict to what the system should do with it.
//   confirmed    -> { action: 'reverified' }  (eligible to stamp Last Verified)
//   changed      -> { action: 'review' }      (human approves the source-grounded correction)
//   unverifiable -> { action: 'flag' }         (surface for manual attention, change nothing)
function actionFor(verdict) {
  if (verdict === 'confirmed') return 'reverified';
  if (verdict === 'changed') return 'review';
  return 'flag';
}

module.exports = {
  VERDICTS: VERDICTS,
  buildVerificationPrompt: buildVerificationPrompt,
  parseVerdict: parseVerdict,
  actionFor: actionFor
};
