// Source guards for the pre-launch widget XSS hardening.
//
// widget-core.js renders content from untrusted sources (visitor input, agent
// messages over Ably, operator config). These guards fail loudly if any of the
// fixed sinks reverts to interpolating a tainted value into innerHTML / a raw
// href/src, or if the tightened email regex is loosened.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');

test('email success toast is built with textContent, not innerHTML + email', () => {
  // The old sink: bar.innerHTML = '...Sent to ' + email + '...'  — must be gone.
  assert.doesNotMatch(SRC, /innerHTML\s*=\s*'[^']*Sent to '\s*\+\s*email/,
    'the visitor email must never be concatenated into innerHTML');
  assert.match(SRC, /okBox\.textContent\s*=\s*'[^']*'\s*\+\s*email/,
    'the toast must render the email via textContent');
});

test('showEmailError injects the server message via textContent', () => {
  assert.doesNotMatch(SRC, /tgx-email-status-text">'\s*\+\s*\(message/,
    'the error message must not be interpolated into innerHTML');
  assert.match(SRC, /_txt\.textContent\s*=\s*message/, 'the error message must be set via textContent');
});

test('the email regex rejects HTML metacharacters', () => {
  // Every email test must use the hardened class that excludes < > " '.
  assert.doesNotMatch(SRC, /\[\^\\s@\]\+@\[\^\\s@\]\+/, 'the loose email regex must be gone');
  assert.match(SRC, /\[\^\\s@<>"'\]\+@\[\^\\s@<>"'\]\+/, 'the hardened email regex must be present');
});

test('attachment URLs go through safeUrl before href/src', () => {
  assert.match(SRC, /var attUrl = safeUrl\(att\.url\)/, 'att.url must be sanitised once');
  assert.doesNotMatch(SRC, /a\.href = att\.url/, 'raw att.url must not reach href');
  assert.doesNotMatch(SRC, /img\.src = att\.url/, 'raw att.url must not reach img.src');
});

test('name overlay renders operator config via textContent / safeUrl', () => {
  assert.doesNotMatch(SRC, /'<h3>'\s*\+\s*C\.namePrompt/, 'namePrompt must not be interpolated into innerHTML');
  assert.doesNotMatch(SRC, /href="'\s*\+\s*C\.privacyUrl/, 'privacyUrl must not be interpolated into an href attribute');
  assert.match(SRC, /_npEl\.textContent = C\.namePrompt/, 'namePrompt via textContent');
  assert.match(SRC, /_pv\.href = safeUrl\(C\.privacyUrl\)/, 'privacyUrl via safeUrl');
});

test('cobrowse accent colour is set via CSSOM, not string-built into a style attribute', () => {
  assert.doesNotMatch(SRC, /background:'\s*\+\s*\(C\.accentColor \|\| "#00B4D8"\)/,
    'accentColor must not be interpolated into a style="" attribute');
  assert.match(SRC, /allow\.style\.background = C\.accentColor/, 'accentColor via CSSOM');
});

test('highlights hero image goes through safeUrl', () => {
  assert.match(SRC, /img\.src = safeUrl\(data\.photo\.url\)/, 'highlights img.src must be sanitised');
});
