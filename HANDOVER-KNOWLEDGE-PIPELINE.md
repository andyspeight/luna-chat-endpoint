# Luna Knowledge Pipeline — Handover

Living doc for the self‑updating knowledge work. Read this first.

## Prime directives (never break these)
- **Zero hallucination.** Facts come only from trusted/fetched sources, never the model's memory. Anything the model can't ground → flagged, never invented. Fail safe (a bad/ambiguous model reply must become "unverifiable", never a false confirm).
- **Voice:** UK English, no em‑dashes, no Oxford commas, plain and warm. (Mirrors `lib/system-prompt.js` + the in‑force prompt in `api/luna-chat.js`.)
- **FCDO safety guardrail (`api/luna-chat.js` ~line 1256‑1270):** Luna must NEVER voice a safety assessment. We surface the official FCDO status as a server‑built card; the model only points to the FCDO page.
- **Human‑gated or trusted‑source‑gated.** New/changed knowledge is either approved by a human, or auto‑applied only when backed by an authoritative source or two independent corroborating sources.

## Dev workflow
- Branch: `claude/luna-knowledge-base-updates-ssbrwe`. Develop here.
- Ship: push → open PR to `main` → merge → Vercel auto‑deploys production `luna-chat-endpoint.vercel.app`. (17 PRs merged so far.)
- Tests: pure libs are unit‑tested with throwaway `node` scripts (no test runner; `node_modules` is NOT installed in the sandbox, so don't `require` full handler files that need the Anthropic SDK — extract pure fns from source instead). Always `node --check` touched files.
- **Sandbox has NO outbound to gov.uk / Tavily / Foursquare etc.** Live checks happen on deploy via `?dryRun=1&secret=<CRON_SECRET>`.
- Commit footer: `Co-Authored-By: Claude ...` + the session link (per repo rules).

## Airtable bases
- **Global "Travel Knowledge" / Luna Brain — `appPKx77relfeiqmq`** (the shared brain that powers Luna + widgets for ALL clients).
  - Widgets search these UNIFIED tables (no status filter → anything written is instantly live): `Destinations` `tblirr0vJuQcTLuH2`, `Knowledge` `tblgdLszaPmquxQ7O`, `Transport` `tbl8CRDV48QGjDx2a`. Each has a `Search Index` (widget searches it) and `Last Verified`.
  - One‑time bulk load: every record `Last Verified = 2026-04-06`. No prior refresh process.
  - New tables created this work:
    - `Suggested Knowledge` `tblazKYYAENwRUjyS` — discovery staging (Pending→Approved/Dismissed).
    - `Discovery Sources` `tblLq1NiTacsFDGsJ` — central source URLs (has `Skip Scrape` `fldlZw1Y4Lan0igUB`). 6 seeded (Greece/Spain/Portugal/Italy/Cyprus/Malta).
    - `Knowledge Reverification` `tblCimk9x32l3LRMK` — re‑verify audit/queue (Pending/Applied/Dismissed; Verdict confirmed/changed/unverifiable/source_unreachable).
- **Per‑client CRM — `app6Ot3eOb3DangkB`** (Clients `tbl6CZ7aVzq1wHF2v`, per‑client Knowledge `tblstATJ3BSqtuTDU` (+ added `LastVerifiedAt` `fldkNk8hEuZJXiK5p`), Conversations, Knowledge Gaps, Highlights Overrides, Suppliers).
- **Destination content (weather widget) — `appuZdlMJ7HKUt6qS`** (Cities/Resorts/Countries w/ Climate). Separate; not the main brain.

## What's built and live (all on `main`)
- **Temporal anchor** — `buildTemporalContext()` in `api/luna-chat.js`, injected into every reply.
- **Freshness loop** — `lib/freshness.js`, `api/knowledge-freshness.js` (cron 08:00). Review‑due queue in per‑client `public/luna-brain.html`; global health in `public/global-brain.html`. Advisory only (never changes retrieval).
- **FCDO** — `lib/fcdo.js` + `api/fcdo.js` (widget card data + warm cron 07:00); `api/refresh-fcdo.js` (writes official FCDO Status to Destinations, cron 04:00, no LLM); `fcdo_card` renderer in `public/widget-core.js`; server attaches card in `api/luna-chat.js` (`buildFcdoCardFromReply`).
- **Discovery** — `lib/safe-scrape.js` (shared SSRF fetch), `lib/discover.js` (extraction‑only prompt + destination‑scoped dedup), `lib/ticketmaster.js` (events), `lib/foursquare.js` (things to do; host‑adaptive: `FOURSQUARE_HOST=places-api.foursquare.com`), `api/discover-scan.js` (cron 06:00) → writes Pending to `Suggested Knowledge`. Attraction filter strips supermarkets/malls etc.
- **Global review** — `api/global-brain.js` + `public/global-brain.html` (admin‑gated: approve→promote into live Knowledge with built Search Index / dismiss; shows knowledge health).
- **Re‑verification (anti‑staleness)** — `lib/reverify.js` (grounded source‑only checker, fail‑safe), `lib/trusted-sources.js` (authoritative classifier), `lib/search.js` (Tavily; Bearer auth), `api/reverify.js` (cron 05:00). Trust rule: ONE authoritative source OR TWO independent corroborating sources → auto‑apply (`Last Verified` reset, or answer update for trusted `changed`); else Pending. Concurrent (`mapLimit`), per‑run capped, prioritises authoritative sources + factual categories. Audit trail in `Knowledge Reverification`.

### Crons (`vercel.json`)
monitor `*/15`; refresh‑fcdo `0 4`; reverify `0 5`; discover‑scan `0 6`; fcdo warm `0 7`; knowledge‑freshness `0 8`.

### Env vars (Vercel, all set)
`ANTHROPIC_API_KEY`, `AIRTABLE_KEY`, `CRON_SECRET`, `ADMIN_PASSWORD`, `TICKETMASTER_API_KEY`, `FOURSQUARE_API_KEY`, `FOURSQUARE_HOST=places-api.foursquare.com`, `TAVILY_API_KEY`, `LUNA_TRUSTED_DOMAINS` (airlines/airports/cruise/tourism boards). Tuning (optional): `REVERIFY_LIMIT|CORRO_CAP|CONCURRENCY|UNSOURCED_LIMIT|AUTOAPPLY|MODEL`, `LUNA_GLOBAL_REVIEW_DAYS`, `DISCOVER_MODEL`.

### Verified working (deploy dry‑runs)
- `discover-scan?dryRun=1` → Ticketmaster events + Foursquare 44‑50 filtered attractions for the 6 seeded destinations; dedup correctly returns 0 for already‑known.
- `reverify?dryRun=1` → completes (no timeout); Tavily connected (`results:6, checked 3`); checker correctly refuses to confirm general advice (those stay Pending — correct, not a bug).

## OUTSTANDING — run discovery across the WHOLE Destinations table (~230)
Discovery currently only covers the 6 rows in `Discovery Sources`. To cover all ~230 global Destinations:

1. **Foursquare `near=` (BLOCKER).** It's geo‑based and only knows ~16 hard‑coded centroids (`CENTROIDS` in `lib/foursquare.js`); the Destinations table has NO lat/lng. Switch to Foursquare's `near=<Name, Country>` text param (verify on the new Places host; geocode fallback if unsupported). This drops the coordinate dependency.
2. **Re‑point connectors to the global Destinations table** (`tblirr0vJuQcTLuH2`) instead of the 6 `Discovery Sources` rows. Add per‑run **rotation**: process a batch (~20) per run, oldest‑first by a new `Last Discovered` dateTime field on Destinations (add it). Keep per‑run caps to fit the 60s cron. Keep the existing curated URL‑scrape phase for `Discovery Sources` rows (e.g. Cyprus) alongside.
3. **Volume/pacing + review screen.** ~230 × ~2 drafts ≈ ~460 suggestions. Pace via rotation (consider Foursquare WEEKLY cadence — free tier ~10k Pro calls/mo, 230/day ≈ ~7k/mo, close). Extend `public/global-brain.html` to also surface the **Reverification Pending queue** (`tblCimk9x32l3LRMK`) with apply/dismiss actions (currently only reviewable in Airtable), and add filtering/pagination so the volume is workable.

Cost flags: Ticketmaster 5k/day (fine), Tavily free tier (watch), Foursquare ~10k Pro/mo (use weekly cadence at scale).

## Also outstanding (original roadmap)
#4 proactive coverage map (thin‑destination finder); #6 ground Destination Spotlight (`api/highlights-card.js`) in verified KB + events; #7 semantic retrieval (pgvector via Supabase) to replace keyword `SEARCH()`. Plus: a one‑off **duplicate finder** (global Knowledge has dupe questions), and apply‑actions/review UI for both Pending queues.
