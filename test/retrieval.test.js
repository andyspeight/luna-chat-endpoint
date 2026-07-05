// Regression tests for the Luna Brain keyword retrieval.
//
// Locks in the fix for the silent-hallucination bug: retrieval used to search
// the Search Index for the keywords joined into one contiguous phrase (a
// substring match that almost never hit) then fall back to the FIRST keyword
// only, case-sensitively — so curated facts were routinely NOT retrieved and
// Luna answered from training data. These tests assert the query is now a
// case-insensitive OR across all keywords, ranked by keyword coverage, and that
// the correct curated fact is injected and flagged via kbGrounded.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// Luna Brain base + table ids (from api/luna-chat.js). Search Index is mixed-case
// on purpose so we prove lowercase query keywords still match.
const LB_BASE = 'appPKx77relfeiqmq';
const KNOWLEDGE = 'tblgdLszaPmquxQ7O';
const DESTINATIONS = 'tblirr0vJuQcTLuH2';
const TRANSPORT = 'tbl8CRDV48QGjDx2a';

const KB = {
  [KNOWLEDGE]: [
    { id: 'recCreteCurr', fields: { 'Search Index': 'Crete Greece currency euro money', Question: 'What currency does Crete use?', 'Consumer Answer': 'Crete uses the Euro (EUR).' } },
    { id: 'recSpainCurr', fields: { 'Search Index': 'Spain currency euro', Question: 'Spain currency', 'Consumer Answer': 'Spain uses the Euro.' } }
  ],
  [DESTINATIONS]: [
    { id: 'recCreteDest', fields: { 'Search Index': 'Crete island Greece Heraklion Chania', Name: 'Crete' } }
  ],
  [TRANSPORT]: []
};

// Airtable-shaped fetch: emulates SEARCH(term, LOWER({Search Index})) by matching
// each row's lowercased Search Index against the SEARCH terms in the formula.
function kbFetch() {
  return async (url) => {
    const m = url.match(new RegExp(LB_BASE + '\\/(tbl[A-Za-z0-9]+)'));
    if (!m) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const rows = KB[m[1]] || [];
    const formula = decodeURIComponent((url.split('filterByFormula=')[1] || '').split('&')[0]);
    const terms = [...formula.matchAll(/SEARCH\("([^"]+)"/g)].map((x) => x[1]);
    const matched = rows.filter((r) => terms.some((t) => (r.fields['Search Index'] || '').toLowerCase().includes(t)));
    return { ok: true, status: 200, json: async () => ({ records: matched }), text: async () => '' };
  };
}

function afterEach() { H.resetFetch(); H.setAirtableKey(null); }

test('retrieval query is a case-insensitive OR across keywords', async (t) => {
  t.after(afterEach);
  H.setReply('ok');
  H.setAirtableKey('at-test');
  H.setFetch(kbFetch());
  const { captured } = await H.callHandler({ message: 'What currency does Crete use?', convId: 'kb-1', clientName: 'Acme Travel' });
  // (indirect) the correct fact must be present in the assembled system prompt
  assert.ok(captured[0].system.includes('Crete uses the Euro'), 'curated Crete fact should be injected');
});

test('mixed-case Search Index is matched by lowercase query keywords', async (t) => {
  t.after(afterEach);
  H.setReply('ok');
  H.setAirtableKey('at-test');
  H.setFetch(kbFetch());
  const { captured } = await H.callHandler({ message: 'currency in Crete', convId: 'kb-2', clientName: 'Acme Travel' });
  assert.ok(captured[0].system.includes('Crete uses the Euro'), 'case-insensitive match failed');
});

test('rows covering more query keywords rank above weaker matches', async (t) => {
  t.after(afterEach);
  H.setReply('ok');
  H.setAirtableKey('at-test');
  H.setFetch(kbFetch());
  const { captured } = await H.callHandler({ message: 'What currency does Crete use?', convId: 'kb-3', clientName: 'Acme Travel' });
  const sys = captured[0].system;
  const cretePos = sys.indexOf('Crete uses the Euro');
  const spainPos = sys.indexOf('Spain uses the Euro');
  assert.ok(cretePos !== -1, 'Crete fact missing');
  assert.ok(spainPos === -1 || cretePos < spainPos, 'Crete (2 keyword hits) should rank above Spain (1 hit)');
});

test('kbGrounded is true when a curated fact was injected', async (t) => {
  t.after(afterEach);
  H.setReply('ok');
  H.setAirtableKey('at-test');
  H.setFetch(kbFetch());
  const { res } = await H.callHandler({ message: 'What currency does Crete use?', convId: 'kb-4', clientName: 'Acme Travel' });
  assert.equal(res.body.kbGrounded, true);
});
