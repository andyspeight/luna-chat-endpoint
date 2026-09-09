// The deep-link correction must reach the visitor on every route the reply
// takes: the streaming widget, the two-pass widget, and the plain JSON reply
// that WhatsApp and the monitor use. And the prompt must stop telling the
// model the radius is in km.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');

const LINK = 'https://dl.tvllnk.com/deeplink/272?st=DynamicPackaging&org=LON&dst=HER&loc=Crete&lat=35.3&lng=25.1&rad=4&fr=2026-10-15&dur=7&adt=2&chd=0&inf=0';
const REPLY = 'Here you go — tap below for live prices. [BLOCK]{"type":"destination_card","props":{"name":"Crete","vibe":"Big island, big choice","tags":["Beaches","History"],"deepLink":"' + LINK + '"}}[/BLOCK] Shout if you want it narrowed down.';

function linkIn(text) {
  const m = /https:\/\/dl\.tvllnk\.com\/deeplink\/[^\s"'<>)\]}\\]+/.exec(text || '');
  return m ? new URL(m[0]).searchParams : null;
}

test('non-streaming: the JSON reply carries the site radius and airport group', async () => {
  h.setReply(REPLY);
  const { res } = await h.callHandler({ message: 'show me prices for Crete in October', clientName: 'Travelgenix', convId: 'conv_geo_json' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const p = linkIn(res.body.reply);
  assert.ok(p, 'reply must still contain the deep link');
  assert.equal(p.get('rad'), '90');
  assert.equal(p.get('dst'), 'GR1');
  assert.equal(p.get('lat'), '35.030312');
  assert.equal(p.get('org'), 'LON');
  assert.equal(p.get('fr'), '2026-10-15');
  assert.match(res.body.reply, /\[BLOCK\]\{"type":"destination_card"/, 'the card must survive intact');
});

test('streaming: the text deltas add up to the corrected link, never a partial one', async () => {
  h.setReply(REPLY);
  const { sse } = await h.callHandler(
    { message: 'show me prices for Crete in October', clientName: 'Travelgenix', convId: 'conv_geo_sse' },
    { stream: '1' }
  );
  const texts = sse.filter((e) => e.event === 'text').map((e) => e.data.delta);
  const joined = texts.join('');
  const p = linkIn(joined);
  assert.ok(p, 'streamed text must contain the link');
  assert.equal(p.get('rad'), '90');
  assert.equal(p.get('dst'), 'GR1');
  // No delta may end inside the link.
  let seen = '';
  for (const t of texts) {
    seen += t;
    const at = seen.lastIndexOf('https://dl.tvllnk.com/deeplink/');
    if (at !== -1) assert.ok(/[\s"'<>)\]}]/.test(seen.slice(at)), 'partial link streamed: ' + seen.slice(at));
  }
  const done = sse.find((e) => e.event === 'done');
  assert.ok(done, 'expected a done event');
  assert.equal(linkIn(done.data.reply).get('rad'), '90', 'the done payload must match what was streamed');
  assert.equal(done.data.reply.indexOf('rad=4&'), -1);
});

test('streaming: prose before the link is not held back', async () => {
  h.setReply(REPLY);
  const { sse } = await h.callHandler(
    { message: 'show me prices for Crete in October', clientName: 'Travelgenix', convId: 'conv_geo_sse2' },
    { stream: '1' }
  );
  const first = sse.find((e) => e.event === 'text');
  assert.ok(first && first.data.delta.startsWith('Here you go'), 'first text event: ' + JSON.stringify(first));
});

test('two-pass: the long stream and the done payload both carry the corrected link', async () => {
  h.setReply(REPLY);
  const { sse } = await h.callHandler(
    { message: 'show me prices for Crete in October', clientName: 'Travelgenix', convId: 'conv_geo_2p', useTwoPass: true, useAck: true },
    { stream: '1', useTwoPass: '1', useAck: '1' }
  );
  const done = sse.find((e) => e.event === 'done');
  assert.ok(done, 'expected a done event; events: ' + sse.map((e) => e.event).join(','));
  const p = linkIn(done.data.reply);
  assert.ok(p, 'done reply must contain the link');
  assert.equal(p.get('rad'), '90');
  assert.equal(done.data.mode, 'two-pass', 'the test must exercise the two-pass route');
  {
    const longJoined = sse.filter((e) => e.event === 'long_text').map((e) => e.data.delta).join('');
    assert.equal(linkIn(longJoined).get('rad'), '90', 'long_text deltas must add up to the corrected link');
  }
});

test('a reply with no deep link is byte-identical to what the model said', async () => {
  const plain = 'Crete is lovely in October, warm sea and quieter beaches.';
  h.setReply(plain);
  const { res } = await h.callHandler({ message: 'tell me about Crete', clientName: 'Travelgenix', convId: 'conv_geo_plain' });
  assert.equal(res.body.reply, plain);
});

test('an unknown destination keeps the model own numbers', async () => {
  h.setReply(REPLY.replace('dst=HER&loc=Crete&lat=35.3&lng=25.1', 'dst=MCO&loc=Universal+Orlando&lat=28.47&lng=-81.47'));
  const { res } = await h.callHandler({ message: 'hotels near Universal Orlando', clientName: 'Travelgenix', convId: 'conv_geo_miss' });
  const p = linkIn(res.body.reply);
  assert.equal(p.get('rad'), '4');
  assert.equal(p.get('dst'), 'MCO');
});

// ── the prompt ──

test('the prompt no longer calls the radius km, and no template hardcodes rad=4', () => {
  assert.doesNotMatch(SRC, /search radius in km/);
  assert.doesNotMatch(SRC, /&rad=4&/);
  assert.match(SRC, /search radius in MILES/);
  assert.equal((SRC.match(/&rad=\{RADIUS\}&/g) || []).length, 3, 'Packages, DynamicPackaging and Accommodation templates');
});

test('the prompt scales the radius to the kind of place, up to a whole country', () => {
  const at = SRC.indexOf('**RADIUS**');
  const block = SRC.slice(at, at + 1600);
  assert.match(block, /ski resort/);
  assert.match(block, /Algarve 47/);
  assert.match(block, /Crete 90/);
  assert.match(block, /Maldives 150/);
  assert.match(block, /A region is NOT a town/);
});

test('every route runs the rewrite, and the off switch is read once', () => {
  assert.equal((SRC.match(/geo\.rewriteDeepLinks\(/g) || []).length, 3, 'single-stream final, two-pass final, non-stream');
  assert.equal((SRC.match(/geo\.createStreamRewriter\(/g) || []).length, 3, 'single stream, two-pass long, two-pass retry');
  assert.match(SRC, /const GEO_REWRITE = process\.env\.LUNA_GEO_REWRITE !== '0';/);
  assert.doesNotMatch(SRC, /sendEvent\('text', \{ delta: deltaText \}\)/, 'raw deltas must go through the rewriter');
});
