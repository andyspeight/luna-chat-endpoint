// The assistant must answer to the name the client gave her.
//
// Jamie Wake Travel named theirs "Ava". The chat bubble said Ava. She still
// opened with "I'm Luna, the chat assistant here at Jamie Wake Travel" — because
// WidgetBotName only ever reached the widget's UI label and was never put in the
// prompt, so the hardcoded "You are Luna" won every reply. The visitor sees both
// at once, so it reads as broken.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'luna-chat.js'), 'utf8');
const CFG = fs.readFileSync(path.join(__dirname, '..', 'api', 'widget-config.js'), 'utf8');

test('the client bot name is read into the prompt, not just the widget label', () => {
  assert.match(CFG, /WidgetBotName/, 'the widget still labels itself with it');
  assert.match(SRC, /f\.WidgetBotName/,
    'luna-chat must read it too — the label alone is what caused the mismatch');
});

test('a chosen name overrides the hardcoded Luna identity', () => {
  const at = SRC.indexOf('## Your name — overrides the name used anywhere above');
  assert.ok(at !== -1, 'there must be an explicit override section');
  const block = SRC.slice(at, at + 900);
  assert.match(block, /you are called \*\*\$\{botName\}\*\*, not Luna/);
  assert.match(block, /Introduce yourself as \$\{botName\}/);
  assert.match(block, /If asked your name, it is \$\{botName\}/);
});

test('it appears AFTER the base prompt so it actually overrides it', () => {
  const base = SRC.indexOf('const LUNA_CLIENT = `You are Luna');
  const override = SRC.indexOf('## Your name — overrides the name used anywhere above');
  assert.ok(base !== -1 && override > base,
    'an override earlier in the prompt than the thing it overrides is not an override');
});

test('it also stops her volunteering that she is Luna underneath', () => {
  const at = SRC.indexOf('## Your name — overrides the name used anywhere above');
  const block = SRC.slice(at, at + 900);
  assert.match(block, /never mention Luna as a product|powered by/i,
    'the client is white-labelling her; naming the product breaks that');
});

test('the default and blank cases leave the base prompt alone', () => {
  // Overriding with "Luna AI" would produce "I'm Luna AI", which reads worse
  // than doing nothing.
  assert.match(SRC, /if \(botName && !\/\^luna\( ai\)\?\$\/i\.test\(botName\)\)/,
    'must skip empty values and the Luna/Luna AI defaults');
});
