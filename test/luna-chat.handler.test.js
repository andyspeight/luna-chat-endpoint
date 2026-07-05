// Behavioural regression tests for api/luna-chat.js.
// Runs the REAL handler against stubbed Anthropic + fetch (see helpers.js).
// Several tests below lock in the QA fixes so the specific bugs that made Luna
// argue / repeat / leak markers cannot silently return.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

let seq = 0;
const cid = () => 'test-conv-' + (++seq) + '-' + Math.floor(seq * 7919 % 100000);

test('strips leading [LANG:] marker and reports detectedLanguage', async () => {
  H.setReply('[LANG:English] Crete is lovely in September.');
  const { res } = await H.callHandler({ message: 'Tell me about Crete', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.reply, 'Crete is lovely in September.');
  assert.equal(res.body.detectedLanguage, 'English');
});

test('client sites use the Haiku model; Travelgenix uses the long model', async () => {
  H.setReply('ok');
  const a = await H.callHandler({ message: 'things to do in Crete', convId: cid(), clientName: 'Acme Travel' });
  assert.match(a.captured[0].model, /haiku/i);
  const b = await H.callHandler({ message: 'what packages do you offer', convId: cid(), clientName: 'Travelgenix' });
  assert.doesNotMatch(b.captured[0].model, /haiku/i);
});

test('HTML is stripped from the visitor message before it reaches the model', async () => {
  H.setReply('ok');
  const { captured } = await H.callHandler({ message: '<script>alert(1)</script> Tenerife weather', convId: cid(), clientName: 'Acme Travel' });
  const lastMsg = captured[0].messages[captured[0].messages.length - 1].content;
  assert.ok(!lastMsg.includes('<script>'), 'script tag should be stripped: ' + lastMsg);
});

test('message history is well-formed: starts with user, no consecutive same roles', async () => {
  H.setReply('ok');
  const { captured } = await H.callHandler({
    message: 'and hotels?', convId: cid(), clientName: 'Acme Travel',
    history: [
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'flights to crete' },
      { role: 'user', content: 'in june' }
    ]
  });
  const msgs = captured[0].messages;
  assert.equal(msgs[0].role, 'user');
  for (let i = 1; i < msgs.length; i++) assert.notEqual(msgs[i].role, msgs[i - 1].role);
});

// ── REGRESSION: the duplicated-message bug ──
test('current message is sent to the model exactly once when history already ends with it', async () => {
  H.setReply('ok');
  const msg = 'flights to Crete in June';
  const { captured } = await H.callHandler({
    message: msg, convId: cid(), clientName: 'Acme Travel',
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: msg }   // widget pushed it into history AND sends it as message
    ]
  });
  const last = captured[0].messages[captured[0].messages.length - 1].content;
  const count = (last.match(/flights to Crete in June/g) || []).length;
  assert.equal(count, 1, 'message must not be duplicated in the prompt: ' + JSON.stringify(last));
});

test('a genuinely new message is still appended to a trailing user turn', async () => {
  H.setReply('ok');
  const { captured } = await H.callHandler({
    message: 'and hotels?', convId: cid(), clientName: 'Acme Travel',
    history: [{ role: 'user', content: 'flights to Crete' }]
  });
  const last = captured[0].messages[captured[0].messages.length - 1].content;
  assert.ok(last.includes('and hotels?') && last.includes('flights to Crete'), last);
});

test('explicit human request sets escalate=true', async () => {
  H.setReply('Of course.');
  const { res } = await H.callHandler({ message: 'can I speak to a human please', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.escalate, true);
});

test('abusive input is moderated without any model call', async () => {
  const { res, captured } = await H.callHandler({ message: 'you are fucking useless', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.moderated, true);
  assert.equal(captured.length, 0, 'model must not be called for moderated content');
});

test('profanity in the model output is redacted before the visitor sees it', async () => {
  H.setReply('That hotel is damn good value.');
  const { res } = await H.callHandler({ message: 'is the hotel good value?', convId: cid(), clientName: 'Acme Travel' });
  assert.ok(!/damn/i.test(res.body.reply), 'output filter should redact profanity: ' + res.body.reply);
});

test('opener request: JSON is parsed, code fences stripped, pills sanitised', async () => {
  H.setReply('```json\n{"reply":"Greek islands are calling.","pills":["Best time to visit","Hidden islands","Island hopping","What to expect"]}\n```');
  const { res } = await H.callHandler({
    openerRequest: true, convId: cid(), clientName: 'Acme Travel',
    pageContext: { title: 'Greek Islands', path: '/greek-islands', url: 'https://x.com/greek-islands', primaryContent: 'Greek islands page' }
  });
  assert.equal(res.body.reply, 'Greek islands are calling.');
  assert.ok(Array.isArray(res.body.pills) && res.body.pills.length === 4);
});

test('empty message is rejected with 400', async () => {
  const { res } = await H.callHandler({ message: '', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.statusCode, 400);
});

test('hallucinated formatting pseudo-tags are stripped from the reply', async () => {
  H.setReply('First line.<blank_line>Second line.<break>');
  const { res } = await H.callHandler({ message: 'tell me about crete', convId: cid(), clientName: 'Acme Travel' });
  assert.ok(!/<blank_line>|<break>/.test(res.body.reply), res.body.reply);
});

// ── REGRESSION: grounding signal is exposed ──
test('response carries a kbGrounded flag (false when no knowledge base is configured)', async () => {
  H.setReply('ok');
  H.setAirtableKey(null);
  const { res } = await H.callHandler({ message: 'tell me about Crete', convId: cid(), clientName: 'Acme Travel' });
  assert.equal(res.body.kbGrounded, false);
});
