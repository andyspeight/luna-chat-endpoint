# Luna Chat — microsite brief

**For:** the session building the Luna Chat microsite on travelgenix.io
**From:** the session that has been working on the product
**Source of truth:** the `luna-chat-endpoint` codebase at `main` (`297e66f`,
9 Sep 2026). Every feature below was read out of shipped code, not a roadmap.

Read §11 (**Do not claim**) before writing any copy. It is the most important
section in this document.

---

## 1. What Luna Chat is

Luna Chat is an AI travel expert that sits on an agency's website and answers
their customers, day and night, in the agency's own voice, from the agency's own
verified knowledge.

It is not a chatbot with a decision tree. It holds a real conversation, works out
what the customer actually wants, answers from a knowledge base the agency
controls, and turns interest into a live search on the agency's own booking
engine with a working link. When it reaches the edge of what it should handle, it
hands the conversation to a human, in an inbox that also receives the agency's
WhatsApp messages.

**One-sentence version:** Luna answers your website visitors like your best
agent would, at two in the morning, and hands you the ones worth a human.

**What makes it different from a website chatbot:** Luna is wired into the travel
business itself. It knows which destinations the agency sells, answers from
knowledge the agency has approved, produces real bookable search links on their
own site, retrieves existing bookings, checks Foreign Office advice before
discussing safety, and refuses to mention a competitor. A generic chatbot
deflects tickets. Luna sells holidays and books demos.

---

## 2. Who it is for

The microsite should speak to all of these. Their pains are genuinely different.

| Segment | What they are | What they feel |
|---|---|---|
| **Homeworkers and independent agents** | One person, no office hours | "People message me at eleven at night. By morning they have booked somewhere else." |
| **Independent high-street agencies** | 1 to 3 branches, small team | "The website gets visitors. We have no idea who they are or what they wanted." |
| **Multi-branch agencies** | 4 to 20 branches | "Every branch answers differently. Nobody sees the enquiries that never became a phone call." |
| **Consortia, groups and franchises** | Central team serving many members | "We cannot staff live chat for 80 members. They all need it." |
| **Tour operators and specialists** | Own product, deep expertise | "Our whole value is that we know the destination. A generic bot makes us look like everyone else." |

One agency can hold several websites and switch between them, so the group and
consortium story is real rather than aspirational.

---

## 3. The problem

Write these as the customer's own words, not as feature gaps.

**1. The website is open all night and nobody is home.**
Most holiday research happens in the evening and at weekends. An enquiry form
sends an email that gets answered the next working day, by which time the
customer has asked three other agencies.

**2. Live chat means staffing live chat.**
Agencies that have tried it discover the real cost is a person watching a screen.
So the widget gets switched off, or worse, left on and unanswered.

**3. A generic chatbot embarrasses you.**
It does not know the agency's ATOL number, opening hours, deposit terms or which
operators they book. It invents prices. It cannot say what is actually available.
It answers a question about the Maldives by suggesting the customer try
Booking.com.

**4. Most website visitors leave without a trace.**
They browse, they wonder something, they cannot be bothered to fill in a form,
and they go. The agency never learns what they wanted, so the question never gets
answered on the site either.

**5. The expertise lives in people's heads.**
The agency knows things nobody has written down. When the person who knows is on
holiday, or leaves, the knowledge goes with them.

**6. Enquiries arrive in five places.**
Website chat, WhatsApp, Facebook, email, phone. Nobody has one view, so things
get missed and nobody can see how many enquiries there really were.

**7. Nobody can prove chat is worth it.**
Without numbers, it is a cost. With numbers, it is the cheapest salesperson in
the business.

---

## 4. The solution — the core promise

**The hero is the conversation itself, and the fact it converts.**

> A visitor asks "somewhere hot in October with a toddler".
>
> Luna asks the two things it needs, answers from what the agency actually knows,
> and produces a **live search on the agency's own website** with the dates,
> airport and party size already filled in.
>
> If they want a person, the agency's agent picks it up mid conversation, with
> the whole thread and a structured summary of the trip already in front of them.

Three supporting promises:

1. **It knows your business.** It answers from your knowledge base, not the open
   internet, and never mentions a competitor.
2. **It will not make things up.** Facts come from sources, get re-checked
   against those sources on a schedule, and anything it cannot ground it flags
   rather than guesses.
3. **It hands over cleanly.** Your agent takes the conversation, in one inbox
   that also carries WhatsApp.

---

## 5. Features — full detail

Everything in this section is built and shipping on `main`. Use the "why it
matters" line as the customer-facing benefit.

### 5.1 The conversation — an AI that behaves like an agent

This is the product. Give it the most space.

- **Understands the request rather than matching keywords.** It works out
  destination, dates, flexibility, party size including child ages, board basis,
  budget and airport across a natural conversation, not a form.
- **The concierge rule.** The prompt explicitly instructs it to go deeper rather
  than give a shallow answer and stop.
- **Never re-asks something already answered.** It keeps a hidden structured
  **trip brief** of everything the visitor has said, so the conversation moves
  forward rather than in circles.
- **Follow-up pills.** Every answer offers easy next taps, so the visitor never
  faces a blank box.
- **Multilingual.** It detects the visitor's language and replies in it
  throughout, switching if they switch. The knowledge base is English and gets
  translated naturally, without ever mentioning that it is translating.
- **Short-answer mode and continuation mode**, so a quick question gets a quick
  answer and a developing conversation keeps its thread.

**Why it matters:** it reads like your best agent on a good day, not like a bot.

### 5.2 Real bookable search — the commercial engine

The feature that separates this from every support chatbot.

- Luna builds a **deep link into the agency's own booking engine** with the
  search already filled in: destination, dates, duration, departure airport,
  adults, children, infants, board basis and star rating.
- Four search types: **Packages, Flights, Accommodation and Dynamic Packaging.**
  Every new client gets all four.
- Links are **dated relative to today**, so a link is still valid later rather
  than pointing at a date that has passed.
- If a client has no search configured, the prompt switches to an explicit
  "search not available" mode rather than inventing a URL. This exists because
  a client without an App ID once had Luna invent booking links on their own
  domain that all returned 404.

**Why it matters:** the conversation ends on the agency's own search results, not
a promise to get back to them.

### 5.3 Luna Brain — the agency's own knowledge

- Per-client knowledge items, injected into the conversation as authoritative
  facts at the moment they are needed.
- **Usage is tracked**, so the agency can see which answers earn their keep.
- **Train Luna** scans pages from the agency's own website and turns them into
  knowledge.
- **Knowledge gaps** are detected automatically: when Luna could not answer well,
  the question is written to a gaps list with a suggested answer for the owner to
  approve.
- **Conversation quality scoring** runs over finished conversations against a
  rubric, so poor answers surface instead of disappearing.
- The owner reviews everything in a **Luna Brain** screen: gaps, low-quality
  conversations, top knowledge and a review-due queue.

**Why it matters:** the expertise stops living in people's heads, and the thing
answering customers gets better every week rather than drifting.

### 5.4 Knowledge that keeps itself honest

**Give this its own section on the microsite.** It is the answer to "we do not
trust AI", and almost nothing else in the market has it.

- **Re-verification against the original source.** Luna never refreshes a fact
  from the model's own memory. It re-reads the cited source and returns one of
  three verdicts: *confirmed*, *changed* (with the evidence, for a human to
  approve) or *unverifiable* (flagged, never guessed). A malformed reply parses
  to *unverifiable*, so a bad response can never produce a false confirmation.
- **Freshness queue.** Items are classified by how long they have gone unchecked,
  and surfaced for a human re-check. It never changes what Luna says, only what
  the owner is asked to look at.
- **Discovery is extraction only.** The crawler that proposes new knowledge is
  forbidden from adding anything not present in the page text, and everything it
  finds is written as a draft that a human approves before Luna will use it.
- **Deterministic data auto-publishes, model-extracted data does not.** Data
  built by code from a connector goes live; anything a model wrote stays behind a
  human gate.

**Why it matters:** the honest answer to "how do you know it is not making things
up" is a process, not a promise.

### 5.5 Safety — the Foreign Office guardrail

- Luna **never voices a safety assessment in its own words**. It is explicitly
  forbidden from saying a destination is safe, from stating what the FCDO does or
  does not advise, and from following a safety answer with a sales question about
  the same destination.
- The server attaches the **official FCDO status** as a card and points the
  visitor at the FCDO's own page.
- FCDO data is refreshed on a schedule and warmed daily.

**Why it matters:** a travel business cannot have software making safety claims
on its behalf. This is the design that makes that impossible.

### 5.6 Commercial loyalty

Luna is instructed, absolutely and with no exceptions, never to recommend or name
a competitor: not the big online travel agents, not comparison sites, not when
asked directly and not unprompted.

**Why it matters:** it was written after a live client's chat suggested a
competitor on their own website. Worth saying plainly on the site, because it is
the first thing an agency owner worries about.

### 5.7 Live handover to a human

- Real-time chat between visitor and agent, with **typing indicators, read
  receipts and agent presence**.
- Luna escalates when the visitor asks for a human, has a booking reference or
  complaint, or seems frustrated after two attempts. It is explicitly told **not**
  to escalate general holiday searches, because it has a search tool of its own.
- The agent inherits the whole thread plus the structured trip brief.
- **Canned responses** for the things agents type all day.
- **Out-of-hours lead email** to the agency when a visitor leaves a message and
  no agent is watching.

**Why it matters:** the customer never has to start again, and the agent starts
the conversation already knowing what the trip is.

### 5.8 WhatsApp in the same inbox

- A customer messages the agency's own WhatsApp number and the conversation
  appears **live in the same dashboard**, tagged WhatsApp.
- Luna answers, grounded in that client's knowledge, until it escalates or an
  agent takes over. Agent replies go back out over WhatsApp.
- Multi-tenant: each client connects their own number.

**See §11 before writing about this.** The channel is built and works; the
self-service connection flow is not, so numbers are currently connected by
Travelgenix rather than by the client.

### 5.9 Luna Copilot — AI help for the agent, not the customer

Agents see it, customers never do.

- **Three suggested replies**, grounded in that client's knowledge and the live
  conversation, each tagged with what it is based on.
- **Rephrase** the agent's draft: friendlier, shorter, more detail.
- **Summarise** the thread into the visitor's open need and the next action.
- **Translate** into the customer's language.
- **A reply check** runs before an agent's message sends. If a draft is rude,
  dismissive, sarcastic or unprofessional it is flagged with a warm rewrite that
  keeps the agent's intent. There is a fast local backstop as well as the AI one.

**Why it matters:** a new agent answers like an experienced one, and nothing goes
out that the agency would regret.

### 5.10 Rich answers, not walls of text

Luna renders structured cards inside the conversation:

- **Destination cards** with temperature, flight time, a short description, tags
  and a one-tap deep link into search
- **Weather cards** with twelve-month climate, live conditions and a forecast
- **Location cards** with a map for airports and attractions
- **Quick reply pills** on every answer
- **Booking lookup**: a visitor retrieves an existing booking through an inline
  form in the chat

**Why it matters:** it looks like a product, not a text box, and each card is a
step towards a search.

### 5.11 Visitor memory

- Luna recognises a returning visitor on the same device and picks up their
  context, so they are not treated as a stranger.
- **Cross-device recall**: a visitor who chatted on their phone can be recognised
  on a laptop by proving the email address is theirs with a one-time code. Only
  the compact memory comes back, never a transcript.
- What it holds is deliberately small: a name, when they were last in touch, how
  often, and a short topic summary.

**Why it matters:** returning customers are the warmest audience an agency has,
and being remembered is the difference between a website and a relationship.

### 5.12 Screen share and file sharing

- **Consent-gated, view-only screen share.** The agent asks, the visitor agrees,
  and the agent can see the visitor's screen to guide them. View only.
- **Files and images both ways.** Images render inline, documents as a download.
  Passports, booking confirmations, screenshots of a listing they found.

**Why it matters:** the two things that usually force a phone call.

### 5.13 Getting the visitor to engage

- **Auto-trigger** on a delay, on scroll depth, on exit intent, or on specific
  URL patterns
- **Page-aware takeover**: a page can be configured so the widget opens itself in
  expanded mode
- **Voice input**, so a visitor can talk rather than type
- **A visitor rating** at the end of a conversation
- **Email the transcript** to the visitor
- **Email capture** that pushes to the agency's marketing platform
- **A "chat to us" button** the agency can drop anywhere on their site, either as
  a ready-styled button or on their own element

**Why it matters:** the widget earns conversations rather than waiting in the
corner.

### 5.14 It looks like the agency, not like us

Around thirty settings, including brand colour, accent colour, theme mode, logo,
profile image, bubble icon, corner radius, position, size, welcome message,
tagline, hints, footer text, privacy policy link, and the **assistant's own
name**, so it can be called whatever the agency wants rather than Luna.

**Why it matters:** on the client's website it is their assistant, with their
name on it.

### 5.15 Proof it is working

The dashboard reports conversations, message counts, average duration, average
messages, how many were handled by AI alone and the percentage, escalations,
visitor ratings and the rating spread, quality scores, top topics, top pages,
busiest hour and daily volumes.

**Why it matters:** chat stops being a cost nobody can justify.

### 5.16 Running quietly in the background

Eleven scheduled jobs keep the product honest without anyone touching it:
a health check every fifteen minutes with alerting, a daily freshness digest,
Foreign Office refresh and warming, a discovery crawl every three hours,
re-verification, gap filling, a review digest, and search-index and embedding
rebuilds.

**Why it matters:** worth one line on the site. It is why the thing still works
in six months.

### 5.17 Set-up and support

- A **readiness score** on the dashboard showing exactly what is done and what is
  missing, with a shortcut to each
- One script tag to embed
- Travelgenix staff can **open a client's account** to help them, and clients are
  provisioned from Client Control rather than by hand

**Why it matters:** they are useful on day one.

---

## 6. Differentiators — the comparison table

Every row is real and defensible.

| | Generic website chatbot | Luna Chat |
|---|---|---|
| Understands a holiday request | Keyword matching | Full conversation, structured trip brief |
| Answers from your own knowledge | No | Yes, approved by you |
| Produces a real bookable search | No | Deep link into your own booking engine, pre-filled |
| Booking links that still work later | — | Dated relative to today |
| Retrieves an existing booking | No | Inline in the chat |
| Checks Foreign Office advice | No | Official status card, never its own opinion |
| Will it mention a competitor | Often | Never, by absolute rule |
| Re-checks its own facts against sources | No | Scheduled, three-verdict, human-approved |
| WhatsApp in the same inbox | No | Yes |
| Helps your agent write the reply | No | Suggested replies, rephrase, summarise, translate |
| Stops a rude reply going out | No | Checked before send |
| Screen share | No | Consent-gated, view only |
| Speaks the visitor's language | No | Detects and follows |
| Remembers a returning customer | No | Same device, and across devices with a verified code |

**The strongest single differentiator: the deep link.** Luna does not just talk
about holidays, it produces the search, on the agency's own site, with everything
filled in. It is easy to demonstrate and impossible for a generic chatbot to
copy.

**The strongest trust differentiator: re-verification.** Nothing else in this
market re-reads the source and tells you when a saved answer has stopped being
true.

---

## 7. Objection handling

| Objection | Answer |
|---|---|
| "AI will say something wrong about our holidays." | It answers from knowledge you approved, and it re-checks those answers against their sources on a schedule. Anything it cannot ground it flags rather than guesses. |
| "It will tell people to go and book on Booking.com." | It is under an absolute instruction never to name a competitor, asked or unasked. |
| "What if someone asks whether a destination is safe?" | Luna never gives a safety opinion. It shows the official Foreign Office status and points them at the FCDO page. |
| "We have not got the staff to watch a chat window." | Luna handles the conversation on its own and only escalates when it should. Out of hours, a lead lands in your inbox by email. |
| "It will not sound like us." | It uses your voice settings, your knowledge and your own name for the assistant. Customers need never see the word Luna. |
| "Our customers use WhatsApp, not website chat." | WhatsApp comes into the same inbox as the website chat. |
| "We already have a chatbot." | Ask it to plan a family holiday to Tenerife in October and see whether it produces a bookable search. |
| "How do we know it is working?" | Conversations, escalations, ratings, quality scores, top topics and busiest hours, in the dashboard. |
| "We are a group and need consistency." | Each member keeps their own brand, knowledge and voice, under one platform. |

---

## 8. Screenshots — shot list

**I could not capture these.** They need a logged-in session against live client
data, and this environment has neither credentials nor a safe demo tenant.

Take them at a **wide browser window**, in **light mode**, using a **demo
company** with realistic UK travel content. Never a real client's conversations.

**Priority order.** If you only take five, take the first five.

| # | What | Where | State to set up | Use on site |
|---|---|---|---|---|
| 1 | **A conversation ending in a deep link** | widget on a demo site | Family holiday request through to the search button, destination card visible | Hero. The most important image on the site. |
| 2 | **Agent inbox with a live chat** | `/dashboard.html` | Several conversations, one live, trip brief visible | "A human when they want one" |
| 3 | **Luna Copilot suggesting replies** | dashboard, chat open | Three suggestions with their basis tags | Copilot section |
| 4 | **Luna Brain** | `/luna-brain.html` | Gaps, low-quality conversations and top knowledge populated | Knowledge section |
| 5 | **Destination or weather card in chat** | widget | A card with climate and a search link | Rich answers section |
| 6 | **WhatsApp conversation in the dashboard** | dashboard | A chat tagged WhatsApp | Channels section |
| 7 | **Analytics** | dashboard stats | 30 days with realistic numbers | Proof section |
| 8 | **The readiness score** | dashboard settings | Part complete, so the checklist shows | Onboarding section |
| 9 | **Widget appearance settings** | dashboard settings | Brand colours and a custom assistant name | White-label section |
| 10 | **Booking lookup in chat** | widget | The inline form with a retrieved booking | Post-booking section |
| 11 | **FCDO safety card** | widget | A safety question and the official status card | Trust section |
| 12 | **Screen share consent prompt** | widget | The moment the visitor is asked | Support section |

**Also worth capturing:** a short screen recording of a full conversation from
first question to search results opening on the agency's site. If the microsite
has one piece of motion, make it that.

**Before publishing any screenshot:** check for real customer names, real
messages, real emails and real phone numbers.

---

## 9. Suggested microsite structure

**1. Hub — `/what-we-do/luna-chat`**
- Hero: the conversation that ends in a bookable search
- The problem in the customer's words (§3)
- How it works in three steps: it answers, it searches, it hands over
- Feature overview grid linking to each page
- Who it is for (§2)
- The trust section: FCDO, re-verification, commercial loyalty
- Reporting
- FAQ (§7)
- CTA

**2. `/luna-chat/how-it-answers`** — the conversation, trip brief, multilingual,
rich cards, follow-up pills.

**3. `/luna-chat/bookable-search`** — the deep link, four search types, evergreen
dating, booking lookup. Commercially the most persuasive page.

**4. `/luna-chat/your-knowledge`** — Luna Brain, Train Luna, gaps, quality
scoring.

**5. `/luna-chat/trust-and-safety`** — re-verification, FCDO, commercial loyalty,
no invention. The page that closes the sale for a nervous owner.

**6. `/luna-chat/your-team`** — handover, Copilot, reply check, canned responses,
screen share, files.

**7. `/luna-chat/channels`** — website widget and WhatsApp in one inbox.

**8. `/luna-chat/for-groups`** — consortia, multi-branch, franchises.

---

## 10. Copy starters

Plain, confident, no hype. Travel agents are sceptical of marketing language.

**Hero options**
- "The agent who never goes home."
- "It answers your customers. Then it books them a search."
- "Your website is open all night. Now someone is answering."
- "Not a chatbot. A travel expert that knows your business."

**Section headers**
- Problem: "Your best enquiries arrive after you have gone home."
- Search: "It does not just talk about holidays. It finds them."
- Knowledge: "It answers from what you know, not what the internet thinks."
- Trust: "It re-reads the source to check it is still true."
- Safety: "It never tells a customer a destination is safe. It shows them the Foreign Office."
- Loyalty: "It will never send your customer to a competitor."
- Handover: "When they want a person, they get one. Mid sentence."
- WhatsApp: "Website chat and WhatsApp. One inbox."
- White label: "It has your name on it, not ours."

**Tone guidance**
- Short sentences. Concrete nouns. No "unlock", "supercharge", "revolutionise",
  "seamless", "game-changing".
- Say what it does, not how transformative it is.
- British English. No em dashes. No Oxford comma.
- Travel language: agents, homeworkers, consortium, ABTA, ATOL, high street,
  bookings. Not "SMBs", "brands", "users".

---

## 11. Do not claim — accuracy guardrails

**Read this before writing a word of copy.** A marketing session without code
access will fill gaps by inventing plausible capability. These are the gaps.

**Do not invent numbers.** I have **no performance data whatsoever**: no
conversation volumes, no conversion rates, no response times, no revenue
attributed to chat, no customer satisfaction figures, no case studies. Any
statistic not supplied by Andy is fabricated. Luna Chat cannot currently attribute
a booking to a conversation, so do not imply it can.

**Do not claim these. They are not built:**

- **Skills-based routing.** Routing a chat to the agent who specialises in that
  destination exists only as an unmerged draft. Do not describe agent specialisms
  or routing anywhere on the site.
- **Self-service WhatsApp connection.** The channel works, but a client cannot
  connect their own number themselves. Travelgenix connects it for them. Do not
  imply a self-serve WhatsApp setup.
- **Voice output.** Visitors can speak to Luna. Luna does not speak back.
- **A mobile app.** Both the widget and the dashboard are responsive web.
- **Facebook Messenger, Instagram DM, SMS or live phone.** The channels are the
  website widget and WhatsApp.
- **CRM or booking-system integration** beyond the booking lookup. Luna does not
  write into a CRM and cannot report revenue.
- **Payments.** Luna does not take money.
- **Automatic knowledge publishing from the web.** Anything a model extracted is
  human-approved before Luna will use it. Do not describe it as self-teaching.

**Handle with care:**

- **"It never makes things up."** The accurate claim is that facts come from
  approved sources, are re-checked against those sources, and anything it cannot
  ground is flagged rather than guessed. Do not write an absolute guarantee.
- **Cross-device memory.** It requires the visitor to verify their email with a
  code. Do not describe it as automatic recognition across devices.
- **Analytics depth.** Good on conversations, escalations, ratings, topics and
  timing. It does not report bookings or revenue.
- **The knowledge base.** The shared destination library is a **Travelgenix
  editorial asset**, not something Luna researches live. The client's own
  knowledge is separate and theirs.
- **"Works with any website."** The widget is one script tag and goes anywhere.
  The **bookable search deep link needs a Travelify App ID.** Without it Luna
  explicitly switches to a no-search mode. This is a genuine dependency and the
  site should not imply otherwise.

**Say "your own", not "ours".** The knowledge, the WhatsApp number, the booking
engine, the customers and the conversations belong to the agency. That is a
selling point, and getting it backwards would be a misrepresentation.

**Status.** Luna Chat has live clients on live websites today, which is a real
difference from Luna Marketing. But I do not know which of them are quotable, and
several accounts in the system are internal or test. **Do not name a client or
publish a testimonial without Andy confirming it**, and do not state a client
count from any number I have given you in passing.

---

## 12. Open questions for Andy

The microsite session will need these and I cannot answer them from the code:

1. **Pricing.** Nothing in the codebase indicates a model: per client, per agent,
   per conversation, or bundled with Travelgenix.
2. **Is it Travelgenix-only?** The bookable search needs a Travelify App ID.
   Can an agency buy Luna Chat without being a Travelgenix website customer, and
   if so, what does it do without search?
3. **Named clients.** Which live clients, if any, will let us use their name or
   give a quote?
4. **The CTA.** Demo, trial, or talk to sales?
5. **WhatsApp positioning.** Do we sell it now, given Travelgenix connects the
   number, or hold it until self-service onboarding is built?
6. **Group and consortium commercials.** Is there a specific offer? It is a
   strong story and deserves its own page.
7. **Does Luna Chat get sold alongside Luna Marketing**, or are they separate
   products with separate pages and separate CTAs?
