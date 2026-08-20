// Luna must keep answering when a model stops answering.
//
// 20 Aug 2026: the Travelgenix chat went quiet. Nothing of ours was broken —
// the token endpoint, Ably and the API key were all fine, and Haiku answered a
// ping in the same breath. One model, claude-sonnet-4-6, stopped responding.
// Two faults turned that into an outage:
//
//   1. The Anthropic client had NO timeout, so a model that never answers hung
//      until Vercel killed the function at 30 seconds. The visitor watched a
//      typing dot and got nothing.
//   2. There was no alternative. One dead model meant no reply, even though a
//      healthy model was configured and already serving every other client.
//
// Worth pinning: the model split is why only Travelgenix went down.
// api/luna-chat.js sets useHaiku for every non-Travelgenix client, so clients
// run on LUNA_HAIKU_MODEL and only Travelgenix runs on LUNA_MODEL.
//
// The retry rule is deliberately narrow — only failures a DIFFERENT model could
// fix. And a retry may only happen while the visitor has seen nothing: once a
// text delta is on the wire, starting again would duplicate words in the bubble.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mf = require('../lib/model-fallback');
const h = require('./helpers');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SRC = read('api/luna-chat.js');

// ── which failures deserve another model ──

test('a hang gets retried — the failure that actually took the chat down', () => {
  assert.equal(mf.isRetryableModelError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), true);
  assert.equal(mf.isRetryableModelError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(mf.isRetryableModelError(new Error('fetch failed')), true);
  assert.equal(mf.isRetryableModelError(new Error('socket hang up')), true);
  assert.equal(mf.isRetryableModelError(new Error('ETIMEDOUT')), true);
});

test('a retired model gets retried', () => {
  assert.equal(mf.isRetryableModelError({ status: 404, message: 'model not found' }), true);
});

test('an overloaded or rate-limited model gets retried', () => {
  [429, 500, 502, 503, 529].forEach(function (s) {
    assert.equal(mf.isRetryableModelError({ status: s }), true, 'expected retry for ' + s);
  });
});

test('a 400 is NOT retried — it is our request, and it will fail identically', () => {
  // Retrying this would turn one clear error into two slow ones.
  assert.equal(mf.isRetryableModelError({ status: 400, message: 'invalid_request_error' }), false);
});

test('a bad API key is NOT retried — no model will accept it', () => {
  assert.equal(mf.isRetryableModelError({ status: 401 }), false);
  assert.equal(mf.isRetryableModelError({ status: 403 }), false);
});

test('a missing error never counts as retryable', () => {
  [null, undefined, 0, ''].forEach(function (e) {
    assert.equal(mf.isRetryableModelError(e), false);
  });
});

// ── the chain ──

test('the chain is primary then fallback', () => {
  assert.deepEqual(mf.modelChain('claude-sonnet-4-6', 'claude-haiku-4-5-20251001'),
    ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
});

test('a client already ON the fallback gets a single-entry chain, not a pointless retry', () => {
  // Every non-Travelgenix client runs Haiku. Calling the same dead model twice
  // would only double their wait before the same failure.
  assert.deepEqual(mf.modelChain('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'),
    ['claude-haiku-4-5-20251001']);
});

test('blank or missing ids are dropped rather than called', () => {
  assert.deepEqual(mf.modelChain('claude-sonnet-4-6', ''), ['claude-sonnet-4-6']);
  assert.deepEqual(mf.modelChain('', 'claude-haiku-4-5-20251001'), ['claude-haiku-4-5-20251001']);
  assert.deepEqual(mf.modelChain('  ', null), []);
});

test('the fallback is env-overridable but defaults to the model clients already use', () => {
  delete process.env.LUNA_FALLBACK_MODEL;
  delete process.env.LUNA_HAIKU_MODEL;
  assert.deepEqual(mf.resolveChain('claude-sonnet-4-6'),
    ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  process.env.LUNA_FALLBACK_MODEL = 'claude-sonnet-5';
  assert.deepEqual(mf.resolveChain('claude-sonnet-4-6'), ['claude-sonnet-4-6', 'claude-sonnet-5']);
  delete process.env.LUNA_FALLBACK_MODEL;
});

// ── the timeout ──

test('the timeout leaves room for a second attempt inside maxDuration 30', () => {
  delete process.env.LUNA_MODEL_TIMEOUT_MS;
  const t = mf.requestTimeoutMs();
  assert.ok(t >= 1000 && t < 30000, 'got ' + t);
  assert.ok(t <= 25000, 'a hang must fail with time left to try another model, got ' + t);
});

test('a nonsense timeout override is ignored rather than obeyed', () => {
  // A typo here could reintroduce the exact hang we are fixing.
  ['0', '-1', 'abc', '999999', ''].forEach(function (v) {
    process.env.LUNA_MODEL_TIMEOUT_MS = v;
    const t = mf.requestTimeoutMs();
    assert.ok(t >= 1000 && t <= 29000, 'bad override ' + JSON.stringify(v) + ' gave ' + t);
  });
  process.env.LUNA_MODEL_TIMEOUT_MS = '9000';
  assert.equal(mf.requestTimeoutMs(), 9000);
  delete process.env.LUNA_MODEL_TIMEOUT_MS;
});

// ── the real handler, end to end ──

test('a dead primary model still gets the visitor an answer', async () => {
  // The outage, reproduced: Travelgenix, primary model hangs.
  process.env.LUNA_MODEL = 'claude-sonnet-4-6';
  process.env.LUNA_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  h.clearModelFailures();
  h.failModel('claude-sonnet-4-6', { name: 'TimeoutError', message: 'The operation was aborted due to timeout' });
  h.setReply('Happy to help with that.');

  const { res, captured } = await h.callHandler({
    message: 'hello', clientName: 'Travelgenix', convId: 'conv_test_fallback'
  });

  const models = captured.map((c) => c.model);
  assert.ok(models.includes('claude-sonnet-4-6'), 'the primary must be tried first: ' + models);
  assert.ok(models.includes('claude-haiku-4-5-20251001'), 'the fallback must be tried: ' + models);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(String(res.body && res.body.reply), /Happy to help/);
  h.clearModelFailures();
});

test('every Anthropic call carries a timeout, so nothing can hang for 30 seconds', async () => {
  h.clearModelFailures();
  h.setReply('ok');
  await h.callHandler({ message: 'hello', clientName: 'Travelgenix', convId: 'conv_test_timeout' });
  // The timeout rides in the second argument, which the fake records separately
  // from opts — so assert on the source instead, for every call site.
  const calls = SRC.match(/client\.messages\.(create|stream)\(/g) || [];
  const timed = SRC.match(/\}, \{ timeout: MODEL_TIMEOUT \}\)/g) || [];
  assert.equal(timed.length, calls.length,
    'expected a timeout on all ' + calls.length + ' Anthropic calls, found ' + timed.length);
});

test('a 400 is surfaced, not quietly retried on a second model', async () => {
  process.env.LUNA_MODEL = 'claude-sonnet-4-6';
  process.env.LUNA_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  h.clearModelFailures();
  h.failModel('claude-sonnet-4-6', { status: 400, message: 'invalid_request_error' });

  const { captured } = await h.callHandler({
    message: 'hello', clientName: 'Travelgenix', convId: 'conv_test_400'
  });
  const models = captured.map((c) => c.model);
  assert.ok(!models.includes('claude-haiku-4-5-20251001'),
    'a 400 will fail the same on any model — retrying just doubles the wait: ' + models);
  h.clearModelFailures();
});

// ── the gates that stop a retry duplicating words on screen ──

test('a stream is only retried while the visitor has seen nothing', () => {
  assert.match(SRC, /var canRetryStream = !firstTextChunkSeen/,
    'retrying after a delta has been sent would replay it as duplicate text');
  assert.match(SRC, /if \(!longFirstToken && MODEL_FALLBACK && modelFallback\.isRetryableModelError\(longErr\)\)/);
});

test('the streaming retry is bounded by the chain, so it cannot loop', () => {
  assert.match(SRC, /streamAttempt < MODEL_CHAIN\.length - 1/);
  assert.match(SRC, /for \(var streamAttempt = 0; streamAttempt < MODEL_CHAIN\.length; streamAttempt\+\+\)/);
});

test('a fallback is logged loudly enough to find in Vercel', () => {
  // Silent degradation is how you end up serving the cheap model for a month
  // without noticing.
  const shouts = SRC.match(/MODEL FALLBACK/g) || [];
  assert.ok(shouts.length >= 2, 'expected the fallback to announce itself, found ' + shouts.length);
});

test('the short call keeps its own graceful degradation, unchanged', () => {
  // It is already non-fatal: if the short pass dies, the long one carries the
  // whole reply. That is the right behaviour and must not be replaced.
  assert.match(SRC, /short stream failed \(non-fatal, long will continue\)/);
});

// ── streaming: the path real visitors actually use ──

test('STREAMING: a dead primary model still streams an answer to the visitor', async () => {
  process.env.LUNA_MODEL = 'claude-sonnet-4-6';
  process.env.LUNA_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  h.clearModelFailures();
  h.failModel('claude-sonnet-4-6', { name: 'TimeoutError', message: 'The operation was aborted due to timeout' });
  h.setReply('Tenerife is lovely in October.');

  const { sse, captured } = await h.callHandler(
    { message: 'where should I go in October?', clientName: 'Travelgenix', convId: 'conv_stream_fb' },
    { stream: '1' }
  );

  // Assert on the MAIN answer call (max_tokens 2048), not just "haiku appears
  // somewhere" — the two-pass path always uses haiku for its short call, so a
  // looser check here would pass even with the fallback ripped out.
  const mainCalls = captured.filter((c) => c.max_tokens === 2048).map((c) => c.model);
  assert.ok(mainCalls.includes('claude-haiku-4-5-20251001'),
    'the fallback must serve the MAIN answer on the streaming path: ' + JSON.stringify(mainCalls));
  assert.equal(mainCalls[0], 'claude-sonnet-4-6', 'the primary must still be tried first');

  const text = sse.filter((e) => e.event === 'text' || e.event === 'long_text' || e.event === 'short_text')
    .map((e) => (e.data && e.data.delta) || '').join('');
  assert.match(text, /Tenerife/, 'the visitor must actually receive words: ' + JSON.stringify(sse.map(e => e.event)));

  const errors = sse.filter((e) => e.event === 'error');
  assert.equal(errors.length, 0, 'no error event should reach the visitor when a fallback succeeded');
  h.clearModelFailures();
});

test('STREAMING: the answer is delivered once, not duplicated by the retry', async () => {
  // The failure mode a careless retry would cause: the visitor reads the reply
  // twice in the same bubble.
  process.env.LUNA_MODEL = 'claude-sonnet-4-6';
  process.env.LUNA_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  h.clearModelFailures();
  h.failModel('claude-sonnet-4-6', { status: 503, message: 'overloaded' });
  h.setReply('MARKER_ONCE');

  const { sse } = await h.callHandler(
    { message: 'hello', clientName: 'Travelgenix', convId: 'conv_stream_dupe' },
    { stream: '1' }
  );

  const text = sse.filter((e) => e.event === 'text' || e.event === 'long_text' || e.event === 'short_text')
    .map((e) => (e.data && e.data.delta) || '').join('');
  const hits = (text.match(/MARKER_ONCE/g) || []).length;
  assert.equal(hits, 1, 'expected the reply exactly once, got ' + hits + ' in: ' + JSON.stringify(text));
  h.clearModelFailures();
});

test('STREAMING: when every model is down the visitor gets the handover message', async () => {
  // Not silence. The one thing worse than a fallback is a typing dot forever.
  process.env.LUNA_MODEL = 'claude-sonnet-4-6';
  process.env.LUNA_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
  h.clearModelFailures();
  h.failModel('claude-sonnet-4-6', { name: 'TimeoutError', message: 'timeout' });
  h.failModel('claude-haiku-4-5-20251001', { name: 'TimeoutError', message: 'timeout' });

  const { sse } = await h.callHandler(
    { message: 'hello', clientName: 'Travelgenix', convId: 'conv_stream_alldead' },
    { stream: '1' }
  );

  const err = sse.find((e) => e.event === 'error');
  assert.ok(err, 'an error event must reach the visitor: ' + JSON.stringify(sse.map(e => e.event)));
  assert.match(String(err.data && err.data.fallbackReply), /connect you with one of the team/);
  h.clearModelFailures();
});

test('the chain is never empty, whatever the environment says', async () => {
  // The streaming branch loops over the chain after the SSE headers are sent.
  // An empty chain would fall through and try to send a JSON body on top.
  delete process.env.LUNA_FALLBACK_MODEL;
  delete process.env.LUNA_HAIKU_MODEL;
  ['', null, undefined, '   '].forEach(function (v) {
    const chain = mf.resolveChain(v);
    assert.ok(chain.length >= 1, 'empty chain for primary ' + JSON.stringify(v));
    assert.ok(chain.every((m) => typeof m === 'string' && m.length));
  });
});
