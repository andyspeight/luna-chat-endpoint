# Luna chat tests

Two layers. The automated suite runs with no network and no API spend and guards
the QA fixes so they cannot silently regress. The staging checks confirm the same
behaviour on the real stack.

## 1. Automated regression suite (no network, no spend)

```
npm test
```

Runs every `test/*.test.js` through Node's built-in test runner. No test
framework or extra dependencies. What it covers:

- **luna-chat.handler.test.js** — drives the real request handler with a stubbed
  Anthropic SDK and stubbed fetch. Locks in: the current message is sent to the
  model only once (the duplicated-message bug), history is well-formed, escalation
  and moderation fire, output profanity is redacted, the opener JSON is parsed,
  pseudo-tags are stripped, and the response carries the `kbGrounded` flag.
- **retrieval.test.js** — feeds an Airtable-shaped knowledge base and proves the
  search is now a case-insensitive OR across all keywords, ranked by keyword
  coverage, that a mixed-case index is matched by lowercase keywords, that the
  right curated fact is injected, and that `kbGrounded` is true when it is.
- **widget.test.js** — behavioural tests for the malformed-`[BLOCK]` strip and the
  opener-history collapse, plus source guards that fail if any widget-side fix is
  reverted (the `history.slice(-16, -1)` de-dup, the `sendToAI` live-agent guard,
  `liveMode` persistence, `recordBotOpener` wiring, and the block-marker strip).

Run this before every deploy. A red test means one of the fixed bugs is back.

## 2. Staging smoke test (real endpoint, small spend)

Confirms the fixes on a real deploy and, most importantly, shows the brain being
used per answer via the `kbGrounded` flag.

```
LUNA_ENDPOINT="https://<staging-host>/api/luna-chat" \
LUNA_CLIENT="Your Client Name" \
npm run smoke
```

Hard checks (fail the run): HTTP 200, non-empty reply, and no raw protocol markers
(`[BLOCK]`, `[LANG:]`, `[FQ]`, …) leaking into the visible reply. Soft checks
(warn only): whether the brain grounded a question it was expected to — soft
because it depends on what is actually in your knowledge base. If a travel
question you know the KB answers comes back `brain=no`, that is the signal to
check retrieval or the KB entry.

## 3. Manual browser checks (need a real browser + the dashboard)

Two behaviours need a human because they involve the live agent dashboard and a
page reload, which the automated tests cannot drive.

**A. Human takeover silences the bot, and survives a reload.**
1. Open the widget on a test page and start a chat with Luna.
2. From the agent dashboard, take over the conversation.
3. As the visitor, send a message. Confirm it reaches the agent and Luna does not
   reply.
4. Tap a suggestion pill or a card button (these used to bypass the takeover).
   Confirm Luna still does not reply.
5. Reload the page. Send another message. Confirm you are still connected to the
   agent and Luna does not resume replying. (Before the fix, the reload handed the
   visitor back to the AI while the agent was still there.)

**B. Auto-trigger opener keeps context.**
1. On a page with an auto-trigger greeting configured, let the opener fire
   ("Looking for winter sun?").
2. Reply with something that only makes sense as an answer to it ("yes please").
3. Confirm Luna responds in context, not with a generic "how can I help". (Before
   the fix, the model never received the question it had asked.)

## Grounding signal

Every non-streaming reply (and the streaming `done` event) now includes
`kbGrounded: true|false` — true when verified Luna Brain knowledge or destination
context was in front of the model for that answer. Surface it in logs or the
dashboard to watch retrieval health over time; a sudden drop in the grounded rate
is an early warning that retrieval has regressed, long before a customer notices.
