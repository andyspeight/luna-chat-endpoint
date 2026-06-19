# Luna Copilot — Stage 1 (Agent AI assist)

Adds an AI copilot to the Luna Chat agent dashboard: suggested replies grounded in the
client's Luna Brain knowledge, plus one-tap Improve / Friendlier / Shorter / More detail,
Summarise thread, and Translate. Agents see it; customers never do.

## Files
- `api/luna-copilot.js` — the hardened server endpoint (drop into the luna-chat-endpoint repo under `/api`).
- `dashboard-copilot.js` — the drop-in front-end module (serve it from the same project, e.g. `/public`).

## Deploy (2 steps)
1. **Env vars** on the `luna-chat-endpoint` Vercel project (server-only):
   - `ANTHROPIC_API_KEY` — reuse the key Luna Chat already uses.
   - `AIRTABLE_PAT` — the PAT already scoped to base `app6Ot3eOb3DangkB`.
   - Optional: `LUNA_COPILOT_MODEL` (defaults to a Haiku-class model), `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (turns on distributed rate limiting — reuse the existing Upstash if there is one).
2. **One line** in `dashboard.html`, just before `</body>`:
   ```html
   <script src="/dashboard-copilot.js" defer></script>
   ```

That's it. The module authenticates with the same `CONFIG.CLIENT_NAME` / `CONFIG.PASSWORD`
the dashboard already holds, reads the live transcript from the existing `.msg` bubbles,
and inserts text into `#msgInput` the same way canned responses do.

## Safety posture
- POST only, CORS locked to the dashboard origins, per-client auth (constant-time), rate limited.
- Grounded only in the client's supplied knowledge + the live chat. It will not invent prices,
  availability, dates, refs or ATOL/ABTA detail — it leaves a clear `[bracketed]` gap for the
  agent instead. Visitor text is treated as data, never as instructions.
- UK English, Travelgenix voice, no em dashes, no banned words, no competitor names.

## Next stages (in build order)
2. Customer file/image upload (Vercel Blob + signed upload + Messages attachment + widget drop-zone).
3. Co-browse (replace the "coming soon" stub).
4. ✅ Omnichannel WhatsApp into the inbox — built. Meta Cloud API webhook +
   channel model wired into the existing Ably inbox. See `WHATSAPP-SETUP.md`
   for provisioning + env vars (needs Meta provisioning to go fully live).
