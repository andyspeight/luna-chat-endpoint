// Tests for the agent-specialisms store endpoint.

'use strict';

require('./helpers'); // SDK stub so the endpoint can be required

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.AIRTABLE_KEY = process.env.AIRTABLE_KEY || 'test-key';
const endpoint = require('../api/agent-specialisms.js');

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; }
  };
}

test('rejects a request with no session cookie (401) before any data access', async () => {
  const res = mockRes();
  await endpoint({ method: 'GET', headers: { 'x-client-name': 'Acme Travel' }, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('rejects a bad method', async () => {
  const res = mockRes();
  await endpoint({ method: 'PUT', headers: {}, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 405);
});

test('requires a client identifier', async () => {
  const res = mockRes();
  await endpoint({ method: 'GET', headers: {}, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 400);
});

// ── source guards ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'agent-specialisms.js'), 'utf8');

test('GUARD: endpoint enforces session + entitlement and credentialed CORS', () => {
  assert.match(SRC, /auth\.validateSession\(req\.headers\.cookie/, 'must validate session');
  assert.match(SRC, /auth\.resolveEntitledClient\(/, 'must check entitlement');
  assert.match(SRC, /Access-Control-Allow-Credentials/, 'must use credentialed CORS');
});

test('GUARD: the stored map is parsed defensively (corrupt JSON never throws)', () => {
  assert.match(SRC, /function parseMap/, 'parseMap must exist');
  assert.match(SRC, /catch \(e\) \{ \/\* ignore \*\/ \}/, 'JSON.parse must be guarded');
});
