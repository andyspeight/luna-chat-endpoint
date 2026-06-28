# Luna Knowledge Pipeline — Handover

Current state of the self‑updating knowledge work. Read this first. Last refreshed against `main` @ `e72a37b`.

**Where the owner reviews/approves everything:** **https://luna-chat-endpoint.vercel.app/global-brain.html** (admin password). One dashboard, three tabs: Discovery suggestions · Re‑verification queue · + Add data. A daily digest email links straight to it.

## Prime directives (never break)
- **Zero hallucination.** Facts come only from trusted/fetched sources, never the model's memory. Anything the model can't ground → flagged, never invented. Fail safe (a bad/ambiguous model reply must become "unverifiable", never a false confirm).
- **Voice:** UK English, no em‑dashes, no Oxford commas, plain and warm.
- **FCDO safety guardrail** (`api/luna-chat.js`): Luna never voices a safety assessment; the server attaches the official FCDO status as a card and points to the FCDO page.
- **Auto‑publish policy (owner‑approved):** deterministic, code‑built connector data (Ticketmaster/Foursquare, NO LLM) auto‑publishes to live Knowledge; anything a model extracted stays human‑gated in the review queue.

## Status: SHIPPED and live on `main` (production `luna-chat-endpoint.vercel.app`)
The knowledge pipeline runs across the whole global database. Crons (`vercel.json`):

| Cron | Schedule | Purpose |
|---|---|---|
| `/api/discover-scan` | `0 */3 * * *` | All ~230 Destinations, batch‑25 rotation (`Last Discovered` field). 3 phases: curated URL scrape → Pending (human‑gated); Ticketmaster + Foursquare → auto‑publish to live Knowledge; backlog sweep promotes connector Pending rows. |
| `/api/reverify` | `0 5 * * *` | Q&A re‑verification. Grounded source‑only checker. Trust rule: 1 authoritative source OR 2 independent corroborating sources → auto‑apply; else Pending. Concurrent (`mapLimit`), per‑run capped, prioritises authoritative sources + factual categories. |
| `/api/reverify-structured` | `0 2 * * *` | Destinations/Transport STRUCTURED fields (currency, capital, dialling code, plug, voltage, tap water, UK visa, time zone; IATA code/city/country) via corroboration. Re‑checks fields that ALREADY have a value. Highest‑yield (crisp facts). |
| `/api/fill-gaps` | `0 3 * * *` | Proactive gap filler. Finds BLANK structured fields and EXTRACTS a value from fetched web sources (grounded, never memory), staging it as a Pending suggestion in the re‑verify queue. Never auto‑applies (model‑extracted ⇒ human‑gated). |
| `/api/refresh-fcdo` | `0 4 * * *` | Writes official FCDO Status to Destinations, verbatim, no LLM (does not touch record‑level Last Verified). |
| `/api/backfill-search-index` | `30 5 * * *` | Rebuilds empty `Search Index` on Destinations/Transport (deterministic, no LLM) so hand‑added rows are findable. Also returns a field‑gap report. `?all=1` rebuilds every row. |
| `/api/reverify` | `0 5 * * *` | Q&A re‑verification. Grounded source‑only checker. Trust rule: 1 authoritative source OR 2 independent corroborating sources → auto‑apply; else Pending. Concurrent (`mapLimit`), per‑run capped, prioritises authoritative sources + factual categories. |
| `/api/embed-index` | `0 9 * * *` | Builds/refreshes the semantic‑search index. Embeds every Knowledge/Destinations/Transport row (Voyage `voyage-3.5-lite`) and upserts vectors into Supabase pgvector. Incremental via content hash; prunes deleted rows. Writes ONLY to the vector store, never the chat path or Airtable. `?dryRun=1`, `?full=1`. |
| `/api/review-digest` | `0 6 * * *` | Daily email to the owner (`REVIEW_DIGEST_TO`, default andy.speight@agendas.group) summarising both Pending queues with a link to the dashboard. Sends every day (heartbeat) incl. an "all clear"; `DIGEST_SKIP_WHEN_EMPTY=1` opts out. `?dryRun=1` previews JSON; `?force=1` forces a send. |
| `/api/knowledge-freshness` | `0 8 * * *` | Staleness digest (global + per‑client). |
| `/api/fcdo?warm=1` | `0 7 * * *` | Pre‑warm FCDO cache. |
| `/api/monitor` | `*/15` | Heartbeat (now incl. Check C, a real AI round‑trip). |

Review screen: **`/global-brain.html`** (admin‑gated by `ADMIN_PASSWORD`) — three tabs: **Discovery suggestions** + **Re‑verification queue** (search/filter, pagination, apply/dismiss) + **+ Add data** (forms to add a destination or an airport/airline/cruise; Search Index is built on save). Per‑client review: `/luna-brain.html?client=<name>`.

## Semantic search (hybrid, behind a flag)
Retrieval in `api/luna-chat.js` (`searchLunaBrain`) now runs **keyword + semantic in parallel and merges** (semantic first, de‑duped by record id, cap 8). It is OFF until `SEMANTIC_SEARCH=1` AND the keys are present; any error/missing‑config silently falls back to the existing keyword search, so it cannot break a reply.
- Vectors live in Supabase project **Luna Agents** (`fybqkrrjxtvzthycljfv`, `https://fybqkrrjxtvzthycljfv.supabase.co`): table `kb_embeddings` + `match_kb()` RPC, `pgvector`, RLS server‑only.
- Embeddings: Voyage `voyage-3.5-lite` (1024‑dim), `lib/embeddings.js`. Store client: `lib/vectorstore.js` (PostgREST, no npm dep). Doc/hash/merge: `lib/kb-doc.js` (pure, tested). Indexer: `api/embed-index.js`.
- **To switch ON (owner):** (1) create a Voyage key → `VOYAGE_API_KEY`; (2) copy the Supabase **service_role** key (dashboard → Settings → API) → `SUPABASE_SERVICE_KEY`, and set `SUPABASE_URL=https://fybqkrrjxtvzthycljfv.supabase.co`; (3) run `/api/embed-index?secret=<CRON_SECRET>` once (or wait for the 09:00 cron) to populate; (4) set `SEMANTIC_SEARCH=1`. Tune match threshold with `SEMANTIC_MIN_SIM` (default 0.45). Flip off instantly by unsetting `SEMANTIC_SEARCH`.

## Adding data (owner)
- **Destination / city / resort** → `+ Add data` tab (or a Destinations row directly). Name is enough; leave `Last Discovered` blank so discovery auto‑fills its things‑to‑do + events next run. Backend: `api/global-brain.js` `add-destination`.
- **Airport / airline / cruise** → same tab (or a Transport row). Not crawled, so the Info fields you enter are what Luna serves. Backend: `add-transport`.
- **Curated source URL** → Discovery Sources row, `Enabled` ✓ → scraped → Pending for review.
- The nightly `backfill-search-index` indexes anything added directly in Airtable, and `fill-gaps` proposes missing structured facts — so the owner only ever *approves*, never hunts.

## Key files
- Discovery: `api/discover-scan.js`, `lib/discover.js`, `lib/safe-scrape.js` (shared SSRF fetch), `lib/ticketmaster.js`, `lib/foursquare.js` (uses `near=<Name, Country>` text search — no coordinates needed; host‑adaptive via `FOURSQUARE_HOST`).
- Re‑verification: `api/reverify.js`, `api/reverify-structured.js`, `lib/reverify.js` (checker + `FIELD_CATALOG` for structured fields; plus `buildExtractionPrompt`/`parseExtraction`/`buildFieldQuestion` for gap‑fill), `lib/trusted-sources.js` (authoritative classifier), `lib/search.js` (Tavily, Bearer auth).
- Gap fill: `api/fill-gaps.js` — extracts blank structured fields from sources; guards = source‑only extraction, evidence quote must appear in the fetched text (anti‑fabrication), corroboration recorded, never auto‑applies. Stages into the same `Knowledge Reverification` queue (verdict `changed`, Current Answer "(currently blank)"), so the existing reverify‑apply path writes it on approval.
- Owner email + indexing: `api/review-digest.js` (daily SendGrid digest; HTML + plain‑text, dashboard URL in both), `api/backfill-search-index.js` (Search Index backfill + gap report; `lib/global-knowledge.js` `buildDestinationSearchIndex`/`buildTransportSearchIndex`). Admin add‑row actions live in `api/global-brain.js`; UI in `public/global-brain.html` (`+ Add data` tab).
- Promotion/auto‑publish: `lib/global-knowledge.js` (`suggestionToKnowledgeFields`, `connectorDraftToKnowledgeFields`, `decidePublish` — ownership guard: create / refresh‑own‑row / skip‑if‑owned‑by‑other so it never clobbers human content; builds Search Index).
- FCDO: `lib/fcdo.js`, `api/fcdo.js`, `api/refresh-fcdo.js`; card injection in `api/luna-chat.js` (`buildFcdoCardFromReply`); renderer in `public/widget-core.js`.
- Freshness: `lib/freshness.js`, `api/knowledge-freshness.js`. Temporal anchor: `buildTemporalContext()` in `api/luna-chat.js`.

## Airtable
- **Global brain — `appPKx77relfeiqmq`.** Widgets search the UNIFIED tables (NO status filter → anything written is instantly live): `Knowledge` `tblgdLszaPmquxQ7O`, `Destinations` `tblirr0vJuQcTLuH2`, `Transport` `tbl8CRDV48QGjDx2a` (each has `Search Index` + `Last Verified`). New tables: `Suggested Knowledge` `tblazKYYAENwRUjyS` (discovery staging), `Discovery Sources` `tblLq1NiTacsFDGsJ` (has `Skip Scrape`), `Knowledge Reverification` `tblCimk9x32l3LRMK` (audit/queue). Destinations has a `Last Discovered` field driving rotation.
- **Per‑client CRM — `app6Ot3eOb3DangkB`** (Clients `tbl6CZ7aVzq1wHF2v`, per‑client Knowledge `tblstATJ3BSqtuTDU` w/ `LastVerifiedAt`).
- **Destination content (weather) — `appuZdlMJ7HKUt6qS`** (separate).

## Env vars (all set in Vercel)
`ANTHROPIC_API_KEY`, `AIRTABLE_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`, `TICKETMASTER_API_KEY`, `FOURSQUARE_API_KEY`, `FOURSQUARE_HOST=places-api.foursquare.com`, `TAVILY_API_KEY`, `LUNA_TRUSTED_DOMAINS`, `SENDGRID_API_KEY` (digest + transcript email; sender `noreply@travelgenix.io` is domain‑authenticated). Tuning (optional): `REVERIFY_LIMIT|CORRO_CAP|CONCURRENCY|UNSOURCED_LIMIT|AUTOAPPLY|MODEL`, `DISCOVER_BATCH`, `LUNA_GLOBAL_REVIEW_DAYS`, `DISCOVER_MODEL`, `FILL_LIMIT|FILL_FIELDS|FILL_CONCURRENCY|FILL_SCAN|FILL_TABLES`, `REVIEW_DIGEST_TO|REVIEW_DIGEST_FROM|REVIEW_DASHBOARD_URL|DIGEST_SKIP_WHEN_EMPTY`.
- Semantic search (optional, off by default): `VOYAGE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SEMANTIC_SEARCH=1` to enable; tuning `SEMANTIC_MIN_SIM`, `EMBED_MODEL|EMBED_DIM|EMBED_MAX|EMBED_BATCH`.
- Note: `@sendgrid/mail` is now a declared dependency in `package.json` (was used by the transcript email but undeclared, so it would have failed to install on Vercel).

## Dev workflow
- Branch: `claude/luna-knowledge-base-updates-ssbrwe`. PR → merge to `main` → Vercel auto‑deploys.
- Git identity for commits: `user.email=noreply@anthropic.com`, `user.name=Claude` (else GitHub marks Unverified).
- Tests: pure libs via throwaway `node` scripts; `node --check` everything. **No `node_modules` in sandbox** (don't `require` handlers needing the Anthropic SDK; extract pure fns from source). **Sandbox has no outbound to gov.uk / Tavily / Foursquare** — live checks via `?dryRun=1&secret=<CRON_SECRET>` on deploy.
- **Do NOT rewrite already‑merged `main` history** (a stop hook may suggest it; ignore for merged commits).

## Outstanding
- ✅ **Validate live output** — done. 252 auto‑published connector rows + re‑verify queue inspected; guardrails holding. Foursquare/Ticketmaster noise tightened (PR #32).
- ✅ **Coverage gaps** — `fill-gaps` now identifies + proposes missing structured facts; `backfill-search-index` reports field gaps. (Original roadmap #4 effectively covered for structured fields.)
- ✅ **#7 semantic retrieval** — built (hybrid, behind `SEMANTIC_SEARCH`; see Semantic search section). Awaiting owner to add keys + flip on.
- Still open: #6 ground Destination Spotlight (`api/highlights-card.js`) in verified KB + events. Plus a duplicate‑finder for the global Knowledge table. Possible next: extend `fill-gaps`‑style grounding to richer fields; a per‑destination coverage % view; run `embed-index` more often if event freshness in semantic results matters.

## Note: repo scope expanded beyond knowledge
A parallel session shipped much more to production (all live on `main`): WhatsApp channel (`api/whatsapp-*`, `lib/wa-*`, `lib/providers/*`), file sharing (Vercel Blob), CSAT, read receipts, returning‑visitor memory, behaviour‑based proactive triggers, a showcase page, dashboard onboarding walkthrough, an agent reply‑quality gate, and a **critical fix to a chat 404 (a retired Sonnet model id was breaking every reply)**. Not part of the knowledge pipeline but now part of the product — review when convenient.
