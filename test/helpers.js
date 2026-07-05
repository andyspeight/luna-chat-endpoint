// Shared test harness for the Luna chat endpoint.
//
// The handler talks to two external services: the Anthropic SDK and (via fetch)
// Airtable / Vercel. Both are stubbed here so the REAL request pipeline in
// api/luna-chat.js runs end to end with no network and no API spend, and tests
// can assert exactly what the model would have been sent and what the visitor
// gets back.
//
// No test framework or mocking library — the repo ships zero dev dependencies,
// so we stub the SDK by intercepting its require and use node:test/node:assert.

'use strict';

const Module = require('module');
const path = require('path');

// ── deterministic env (set before the handler is required) ──
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.SEMANTIC_SEARCH = '0';            // keyword-only path, no embeddings
delete process.env.UPSTASH_REDIS_REST_URL;    // rate limiter fails open
delete process.env.AIRTABLE_KEY;              // per-test opt-in via setAirtableKey()

// ── stub the Anthropic SDK ──
// Captures every create()/stream() call so tests can inspect the assembled
// system prompt and messages, and returns a configurable reply.
let captured = [];
let nextReply = 'ok';

function textToDeltas(text) {
  // Split into a few chunks so the streaming path exercises multi-delta handling.
  const out = [];
  const size = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async (opts) => {
        captured.push(opts);
        return { content: [{ type: 'text', text: nextReply }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
      stream: (opts) => {
        captured.push(opts);
        const deltas = textToDeltas(nextReply);
        const usage = { input_tokens: 100, output_tokens: 50 };
        async function* iterate() {
          for (const d of deltas) {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: d } };
          }
        }
        const it = iterate();
        return Promise.resolve({
          [Symbol.asyncIterator]() { return it; },
          finalMessage: async () => ({ content: [{ type: 'text', text: nextReply }], usage })
        });
      }
    };
  }
}

const fakeSdkPath = '__fake_anthropic_sdk__';
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@anthropic-ai/sdk') return fakeSdkPath;
  return realResolve.call(this, request, ...rest);
};
require.cache[fakeSdkPath] = { id: fakeSdkPath, filename: fakeSdkPath, loaded: true, exports: FakeAnthropic };

// ── default fetch stub: everything fails soft (Airtable/booking absent) ──
// 404 keeps find-booking-widget quiet; other reads return non-ok → empty.
function defaultFetch() {
  return async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
}
global.fetch = defaultFetch();

// ── the handler under test (required AFTER the stubs are in place) ──
const handler = require(path.join(__dirname, '..', 'api', 'luna-chat.js'));

// ── controls ──
function setReply(text) { nextReply = text; }
function resetCaptured() { captured = []; }
function getCaptured() { return captured; }
function lastCall() { return captured[captured.length - 1]; }
function setFetch(fn) { global.fetch = fn; }
function resetFetch() { global.fetch = defaultFetch(); }
function setAirtableKey(k) { if (k) process.env.AIRTABLE_KEY = k; else delete process.env.AIRTABLE_KEY; }

// Minimal res double supporting both JSON and SSE paths.
function makeRes() {
  return {
    headers: {}, statusCode: null, body: null, writes: [], ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    write(s) { this.writes.push(s); return true; },
    end() { this.ended = true; return this; },
    flushHeaders() {}
  };
}

// Invoke the handler. Returns { res, captured, sse } where sse is the parsed
// SSE event list when streaming was used.
async function callHandler(body, query = {}) {
  resetCaptured();
  const res = makeRes();
  await handler({ method: 'POST', body, query, headers: {} }, res);
  return { res, captured: getCaptured(), sse: parseSse(res.writes) };
}

// Parse an array of res.write() strings into [{ event, data }].
function parseSse(writes) {
  const joined = writes.join('');
  const events = [];
  joined.split('\n\n').forEach((chunk) => {
    if (!chunk.trim()) return;
    let event = 'message';
    const dataLines = [];
    chunk.split('\n').forEach((line) => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    if (dataLines.length) {
      let data = dataLines.join('\n');
      try { data = JSON.parse(data); } catch (e) { /* leave as string */ }
      events.push({ event, data });
    }
  });
  return events;
}

module.exports = {
  handler, callHandler, makeRes,
  setReply, resetCaptured, getCaptured, lastCall,
  setFetch, resetFetch, setAirtableKey, parseSse
};
