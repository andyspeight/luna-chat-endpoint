// Regression tests for Booking Assist Stage 1 (enquiry_card + agent bridge).
//
// Same approach as widget.test.js: behavioural tests of the pure logic the
// feature relies on, plus source guards that fail loudly if the wiring is
// reverted or accidentally removed.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const CHAT = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

// ── 1. Behavioural: the enquiry endpoint's input hygiene (pure copies) ──

const enquiry = require('../api/luna-enquiry.js');

test('luna-enquiry rejects non-POST', async () => {
  const res = mockRes();
  await enquiry({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('luna-enquiry validates clientId shape before doing any work', async () => {
  process.env.AIRTABLE_KEY = process.env.AIRTABLE_KEY || 'test-key';
  const res = mockRes();
  await enquiry(req({ clientId: 'not-a-record-id', name: 'Jo', email: 'jo@x.com' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /clientId/i);
});

test('luna-enquiry requires name plus a contact route', async () => {
  process.env.AIRTABLE_KEY = process.env.AIRTABLE_KEY || 'test-key';
  const res = mockRes();
  await enquiry(req({ clientId: 'rec' + 'A'.repeat(14), name: 'Jo' }), res);
  assert.equal(res.statusCode, 400);
  const res2 = mockRes();
  await enquiry(req({ clientId: 'rec' + 'A'.repeat(14), name: 'Jo', email: 'not-an-email' }), res2);
  assert.equal(res2.statusCode, 400);
});

function req(body) {
  return { method: 'POST', headers: {}, body };
}
function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

// ── 2. Source guards: widget wiring ──

test('GUARD: enquiry_card is a known block type and has a registered renderer', () => {
  assert.match(WIDGET, /'enquiry_card',/, 'enquiry_card must be in KNOWN_BLOCK_TYPES');
  assert.match(WIDGET, /function renderEnquiryCard\(/, 'renderEnquiryCard must exist');
  assert.match(WIDGET, /enquiry_card:\s+renderEnquiryCard/, 'renderer must be registered');
});

test('GUARD: enquiry form dispatches to the shell, shell posts to /api/luna-enquiry', () => {
  assert.match(WIDGET, /type:\s*'enquiry_submit'/, 'renderer must dispatch enquiry_submit');
  assert.match(WIDGET, /case "enquiry_submit":\s*\n\s*submitEnquiry\(event\);/, 'shell must handle enquiry_submit');
  assert.match(WIDGET, /replace\("\/api\/luna-chat", "\/api\/luna-enquiry"\)/, 'shell must POST to /api/luna-enquiry');
});

test('GUARD: shell pings the dashboard channel and forwards the last deep link', () => {
  assert.match(WIDGET, /dashChannel\.publish\("enquiry",/, 'enquiry must be published to the dashboard channel');
  assert.match(WIDGET, /var lastDeepLink = null;/, 'lastDeepLink must be declared');
  assert.match(WIDGET, /searchUrl:\s*lastDeepLink/, 'enquiry payload must carry the last deep link');
});

test('GUARD: block context exposes visitor prefill and agency name', () => {
  assert.match(WIDGET, /visitor:\s*\{\s*name:\s*userName/, 'ctx.visitor must be prefilled');
  assert.match(WIDGET, /agencyName:\s*C\.clientName/, 'ctx.agencyName must come from config');
});

// ── 3. Source guards: prompt + dashboard wiring ──

test('GUARD: system prompt documents enquiry_card with the no-invention rule', () => {
  assert.match(CHAT, /\*\*enquiry_card\*\*/, 'prompt must document the block');
  assert.match(CHAT, /"type":"enquiry_card"/, 'prompt must include the emission format');
  assert.match(CHAT, /never invent a value; omit any prop you don't know/,
    'the anti-hallucination rule for props must be present');
  assert.match(CHAT, /ONCE, in one short prose sentence/, 'the offer-once rule must be present');
});

test('GUARD: dashboard subscribes to enquiry events and alerts the agent', () => {
  assert.match(DASH, /dashboardChannel\.subscribe\('enquiry'/, 'dashboard must subscribe to enquiry');
  assert.match(DASH, /function handleEnquiry\(/, 'handleEnquiry must exist');
  assert.match(DASH, /lunaAlertSignal\('enquiry'/, 'enquiry must trigger the alert pipeline');
});
