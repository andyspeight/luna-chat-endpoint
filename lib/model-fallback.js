// lib/model-fallback.js
//
// Keep Luna answering when a model stops answering.
//
// WHAT HAPPENED (20 Aug 2026). The Travelgenix chat went quiet. Nothing was
// broken on our side: the token endpoint was fine, Ably was fine, the API key
// was fine, and Haiku answered a ping in the same breath. One model —
// claude-sonnet-4-6, the one the Travelgenix path uses — simply stopped
// responding. Requests hung until Vercel killed the function at 30s, so the
// visitor sat watching a typing dot and got nothing at all.
//
// Two separate faults, and this module fixes both:
//
//   1. NO TIMEOUT. The Anthropic client was constructed with no timeout, so a
//      model that never answers hangs for the whole function budget. A request
//      that is going to fail should fail fast enough to leave room to try
//      something else.
//
//   2. NO ALTERNATIVE. One unreachable model meant no reply, even though a
//      perfectly healthy model was configured and in use by every other client.
//
// The rule for retrying is deliberately narrow: only errors a DIFFERENT MODEL
// could plausibly fix. A 400 is our bug and will fail identically on any model,
// so retrying it just doubles the latency before the same failure. A 401 is the
// API key and is not a model problem either. Retrying those would turn one
// clear error into two slow ones.

'use strict';

// Anything here is worth a second attempt on another model.
//   408/429  - timeout or rate limit on this model
//   500-599  - upstream fault, includes 529 "overloaded"
//   404      - the model id is gone (retired or renamed)
// Anything else, including 400 and 401/403, is not.
function isRetryableModelError(err) {
  if (!err) return false;

  var status = err.status || err.statusCode
    || (err.response && err.response.status) || 0;
  if (status === 404 || status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // A 4xx we did not name above is our request's fault. Same model or not,
  // it will fail the same way.
  if (status >= 400 && status < 500) return false;

  // No status at all means it never got an answer: aborted, timed out, socket
  // dropped, DNS. That is exactly the case that took the chat down.
  var name = String(err.name || '');
  if (name === 'AbortError' || name === 'TimeoutError'
    || name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true;

  var msg = String(err.message || err).toLowerCase();
  return /timeout|timed out|aborted|econnreset|econnrefused|etimedout|socket hang up|network|fetch failed/
    .test(msg);
}

// The models to try, in order, primary first.
//
// The fallback defaults to Haiku because that is what every non-Travelgenix
// client already runs on, so it is the model with the most evidence behind it
// at any given moment. If the primary IS the fallback there is nothing to gain
// from a second attempt, so the chain is just the one entry and the caller
// makes a single call.
function modelChain(primary, fallback) {
  var chain = [];
  [primary, fallback].forEach(function (m) {
    var id = String(m || '').trim();
    if (id && chain.indexOf(id) === -1) chain.push(id);
  });
  return chain;
}

// Resolve the chain from the environment. Kept here so the ids cannot drift
// between luna-chat.js and the health monitor.
function resolveChain(primaryModel) {
  var chain = modelChain(
    primaryModel,
    process.env.LUNA_FALLBACK_MODEL || process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001'
  );
  // Never hand back an empty chain. The caller loops over this to decide what
  // to call, so empty would mean the streaming branch falls through with the
  // SSE headers already sent. Callers always pass a defaulted id today, so this
  // is a guard against a future edit rather than a live case.
  return chain.length ? chain : ['claude-haiku-4-5-20251001'];
}

// How long to wait on one model before giving up on it.
//
// api/luna-chat.js has maxDuration 30, so this has to leave room for a second
// attempt inside the same request. 20s does: a normal reply is well inside it,
// and a hang fails with 10s still on the clock.
//
// For a STREAMING call this mostly bounds connection and time-to-first-byte,
// because the fetch resolves when headers arrive rather than when the last
// token does. That is the behaviour we want: fail over on a hang, never
// truncate a reply that is streaming along perfectly well.
function requestTimeoutMs() {
  var n = parseInt(process.env.LUNA_MODEL_TIMEOUT_MS || '', 10);
  if (!isNaN(n) && n >= 1000 && n <= 29000) return n;
  return 20000;
}

function describeModelError(err) {
  if (!err) return 'unknown';
  var status = err.status || err.statusCode || (err.response && err.response.status) || 0;
  var msg = String((err && err.message) || err).replace(/\s+/g, ' ').trim().slice(0, 160);
  return (status ? status + ' ' : '') + (msg || err.name || 'unknown');
}

module.exports = {
  isRetryableModelError: isRetryableModelError,
  modelChain: modelChain,
  resolveChain: resolveChain,
  requestTimeoutMs: requestTimeoutMs,
  describeModelError: describeModelError
};
