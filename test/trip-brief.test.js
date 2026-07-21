// Tests for the hidden trip-brief marker (#1 structured trip brief).
//
// Luna emits a [BRIEF]{...}[/BRIEF] marker carrying a running, structured memory
// of the visitor's trip. The server must: strip it from anything the visitor
// sees (leading OR stray), parse it into an object returned as `brief`, and
// never let a malformed marker break the reply. These tests lock that in at two
// levels — the pure helpers directly, and the whole handler end to end.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const LC = require('../api/luna-chat');

let seq = 0;
const cid = () => 'brief-conv-' + (++seq);

// ── unit: parseLeadingMeta (leading [LANG:]/[BRIEF] stripping) ──────────────

test('parseLeadingMeta strips a leading [BRIEF] and parses it', () => {
  const r = LC.parseLeadingMeta('[BRIEF]{"destination":"Crete","adults":2}[/BRIEF]Crete is lovely.');
  assert.equal(r.cleaned, 'Crete is lovely.');
  assert.deepEqual(r.brief, { destination: 'Crete', adults: 2 });
});

test('parseLeadingMeta handles [LANG:] then [BRIEF] in either order', () => {
  const a = LC.parseLeadingMeta('[LANG:English][BRIEF]{"nights":7}[/BRIEF]Text.');
  assert.equal(a.cleaned, 'Text.');
  assert.equal(a.lang, 'English');
  assert.deepEqual(a.brief, { nights: 7 });

  const b = LC.parseLeadingMeta('[BRIEF]{"nights":7}[/BRIEF][LANG:Spanish]Hola.');
  assert.equal(b.cleaned, 'Hola.');
  assert.equal(b.lang, 'Spanish');
  assert.deepEqual(b.brief, { nights: 7 });
});

test('parseLeadingMeta ignores malformed brief JSON but still strips it', () => {
  const r = LC.parseLeadingMeta('[BRIEF]{not valid json}[/BRIEF]Still fine.');
  assert.equal(r.cleaned, 'Still fine.');
  assert.equal(r.brief, null);
});

test('parseLeadingMeta rejects a non-object brief (array)', () => {
  const r = LC.parseLeadingMeta('[BRIEF][1,2,3][/BRIEF]Hi.');
  assert.equal(r.cleaned, 'Hi.');
  assert.equal(r.brief, null);
});

test('parseLeadingMeta leaves ordinary text untouched', () => {
  const r = LC.parseLeadingMeta('Just a normal reply.');
  assert.equal(r.cleaned, 'Just a normal reply.');
  assert.equal(r.brief, null);
  assert.equal(r.lang, null);
});

// ── unit: leadingMetaComplete (the streaming buffering gate) ────────────────

test('leadingMetaComplete waits while a [BRIEF] is still open', () => {
  assert.equal(LC.leadingMetaComplete('[BRIEF]{"destination":"Cre'), false);
  assert.equal(LC.leadingMetaComplete('[BRIEF]{"destination":"Crete"}[/BRIEF]'), false); // nothing after yet
  assert.equal(LC.leadingMetaComplete('[BRIEF]{"destination":"Crete"}[/BRIEF]Hi'), true);
});

test('leadingMetaComplete waits on a growing prefix of an opener', () => {
  assert.equal(LC.leadingMetaComplete('[BRI'), false);
  assert.equal(LC.leadingMetaComplete('[LAN'), false);
  assert.equal(LC.leadingMetaComplete(''), false);
});

test('leadingMetaComplete is true once real text has begun', () => {
  assert.equal(LC.leadingMetaComplete('Crete is lovely'), true);
  assert.equal(LC.leadingMetaComplete('[LANG:English]Crete'), true);
});

// ── unit: extractBriefMarkers (stray-marker safety net) ────────────────────

test('extractBriefMarkers removes a brief placed mid-reply', () => {
  const r = LC.extractBriefMarkers('Sure! [BRIEF]{"board":"all inclusive"}[/BRIEF] Here you go.');
  assert.equal(r.cleaned, 'Sure!  Here you go.');
  assert.deepEqual(r.brief, { board: 'all inclusive' });
});

test('extractBriefMarkers returns the LAST valid brief when several appear', () => {
  const r = LC.extractBriefMarkers('[BRIEF]{"nights":5}[/BRIEF]a[BRIEF]{"nights":7}[/BRIEF]b');
  assert.deepEqual(r.brief, { nights: 7 });
  assert.equal(r.cleaned, 'ab');
});

test('extractBriefMarkers strips a malformed marker without throwing', () => {
  const r = LC.extractBriefMarkers('Hi [BRIEF]{bad}[/BRIEF] there');
  assert.equal(r.cleaned, 'Hi  there');
  assert.equal(r.brief, null);
});

test('extractBriefMarkers is a no-op on clean text', () => {
  const r = LC.extractBriefMarkers('Nothing to strip here.');
  assert.equal(r.cleaned, 'Nothing to strip here.');
  assert.equal(r.brief, null);
});

// ── end to end: the handler strips [BRIEF] and returns brief on the reply ───

test('handler strips a leading [BRIEF] from the visible reply and returns brief', async () => {
  H.setReply('[LANG:English][BRIEF]{"destination":"Crete","adults":2,"nights":7}[/BRIEF]Crete in September is gorgeous.');
  const { res } = await H.callHandler({ message: 'family week in Crete', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.reply, 'Crete in September is gorgeous.');
  assert.ok(!/\[BRIEF\]/.test(res.body.reply), 'no raw marker may reach the visitor');
  assert.deepEqual(res.body.brief, { destination: 'Crete', adults: 2, nights: 7 });
});

test('handler strips a stray mid-reply [BRIEF] too', async () => {
  H.setReply('Lovely choice. [BRIEF]{"board":"all inclusive"}[/BRIEF] Shall I price it?');
  const { res } = await H.callHandler({ message: 'all inclusive please', convId: cid(), clientName: 'Acme Travel' });
  assert.ok(!/\[BRIEF\]/.test(res.body.reply), 'stray marker must be removed: ' + res.body.reply);
  assert.deepEqual(res.body.brief, { board: 'all inclusive' });
});

test('handler omits brief when the model emits none', async () => {
  H.setReply('[LANG:English]Just a plain answer, no brief.');
  const { res } = await H.callHandler({ message: 'hello', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.reply, 'Just a plain answer, no brief.');
  assert.equal(res.body.brief, undefined);
});

test('handler survives malformed [BRIEF] JSON — reply intact, no brief', async () => {
  H.setReply('[BRIEF]{oops not json}[/BRIEF]Your trip sounds great.');
  const { res } = await H.callHandler({ message: 'plan my trip', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.reply, 'Your trip sounds great.');
  assert.ok(!/\[BRIEF\]/.test(res.body.reply));
  assert.equal(res.body.brief, undefined);
});
