// Tests for the skills-based routing matching engine (lib/skills-routing.js).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/skills-routing');

// ── region roll-up (the headline example) ──
test('a destination rolls up to its region', () => {
  assert.ok(R.regionsForTerm('Maldives').includes('indian ocean'));
  assert.ok(R.regionsForTerm('Barbados').includes('caribbean'));
  assert.ok(R.regionsForTerm('Santorini').includes('mediterranean'));
});

test('deriveConversationTerms adds the rolled-up region for a destination', () => {
  const terms = R.deriveConversationTerms({ destination: 'Maldives' });
  assert.ok(terms.includes('maldives'));
  assert.ok(terms.includes('indian ocean'), 'a Maldives chat must also count as Indian Ocean');
});

test('THE headline case: a Maldives chat matches an agent tagged only "Indian Ocean"', () => {
  const terms = R.deriveConversationTerms({ destination: 'Maldives' });
  const m = R.agentMatch('Indian Ocean', terms);
  assert.ok(m, 'agent tagged "Indian Ocean" should match a Maldives conversation');
  assert.equal(m.term, 'indian ocean');
});

// ── free-text forgiveness ──
test('matching is case/space-insensitive and comma-separated', () => {
  const terms = R.deriveConversationTerms({ destination: 'Mauritius' });
  assert.ok(R.agentMatch('  INDIAN OCEAN , cruises ', terms), 'messy free-text tags still match');
});

test('phrase containment works either direction', () => {
  assert.ok(R.agentMatch('maldives', ['the maldives']), 'tag inside conversation phrase');
  assert.ok(R.agentMatch('luxury honeymoons', ['honeymoon']), 'conversation term inside tag');
});

test('trip types expand via synonyms', () => {
  const terms = R.deriveConversationTerms({ holidayType: 'honeymoon' });
  assert.ok(R.agentMatch('honeymoons', terms), 'plural tag matches singular type');
});

test('no false match on unrelated topics', () => {
  const terms = R.deriveConversationTerms({ destination: 'Maldives' });
  assert.equal(R.agentMatch('ski, caribbean', terms), null, 'unrelated specialisms must not match');
});

// ── routing decision: hard, with fallback ──
const agents = () => ([
  { id: 'a1', name: 'Asha', specialisms: 'Indian Ocean, Luxury', online: true },
  { id: 'a2', name: 'Ben', specialisms: 'Caribbean, Cruise', online: true },
  { id: 'a3', name: 'Cara', specialisms: 'Indian Ocean', online: false } // offline specialist
]);

test('routes ONLY to online matching agents (hard)', () => {
  const r = R.routeConversation({ agents: agents(), conversation: { destination: 'Maldives' } });
  const names = r.routedTo.map(a => a.name).sort();
  assert.deepEqual(names, ['Asha'], 'only the online Indian Ocean specialist gets it');
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.matchedSkill, 'indian ocean');
});

test('falls back to ALL online agents when no specialist is online', () => {
  // Cara (Indian Ocean) is offline; the chat is about the Maldives; nobody online matches.
  const roster = [
    { id: 'a2', name: 'Ben', specialisms: 'Caribbean, Cruise', online: true },
    { id: 'a3', name: 'Cara', specialisms: 'Indian Ocean', online: false }
  ];
  const r = R.routeConversation({ agents: roster, conversation: { destination: 'Maldives' } });
  assert.equal(r.fallbackUsed, true, 'no online specialist → fallback');
  assert.deepEqual(r.routedTo.map(a => a.name), ['Ben'], 'falls back to everyone online');
});

test('offline agents are never routed to, matching or not', () => {
  const r = R.routeConversation({ agents: agents(), conversation: { destination: 'Barbados' } });
  assert.deepEqual(r.routedTo.map(a => a.name), ['Ben'], 'Ben (Caribbean, online) only');
  assert.ok(!r.routedTo.some(a => a.name === 'Cara'), 'offline specialist excluded');
});

test('a conversation with no detectable topic falls back to everyone online', () => {
  const r = R.routeConversation({ agents: agents(), conversation: {} });
  assert.equal(r.fallbackUsed, true);
  assert.deepEqual(r.routedTo.map(a => a.name).sort(), ['Asha', 'Ben']);
});

// ── source guards: the browser wiring stays in place ──
const fs = require('node:fs');
const path = require('node:path');
const WIDGET = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget-core.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const UMD = fs.readFileSync(path.join(__dirname, '..', 'public', 'skills-routing.js'), 'utf8');

test('GUARD: matcher is a UMD module (browser window + node require)', () => {
  assert.match(UMD, /window\.SkillsRouting = api/, 'must expose window.SkillsRouting');
  assert.match(UMD, /module\.exports = api/, 'must export for node');
});

test('GUARD: widget sends the trip topic to the dashboard', () => {
  assert.match(WIDGET, /function buildTopicHint/, 'buildTopicHint must exist');
  assert.match(WIDGET, /publish\("conversation_topic"/, 'topic updates must be published');
  assert.match(WIDGET, /topic: buildTopicHint\(\)/, 'new_conversation must carry the topic');
});

test('GUARD: dashboard loads the matcher and routes incoming chats', () => {
  assert.match(DASH, /<script src="\/skills-routing\.js">/, 'dashboard must load the shared matcher');
  assert.match(DASH, /function computeRoutingForConv/, 'routing decision must exist');
  assert.match(DASH, /conv\.routing\.mine/, 'the alert must be gated by whether the chat is mine');
  assert.match(DASH, /specialisms: CONFIG\.MY_SPECIALISMS/, 'presence must broadcast this agent\'s specialisms');
  assert.match(DASH, /window\._teamAdd/, 'the Team panel must be wired');
});
