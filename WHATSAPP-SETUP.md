# Luna Chat — WhatsApp channel (via 360dialog)

Brings WhatsApp into the **same agent inbox** Luna already uses for the web
widget. A client's customer messages the client's own WhatsApp number → the
conversation appears live in `dashboard.html` (tagged **WhatsApp**) → Luna
answers (grounded in that client's knowledge) until it escalates or an agent
takes over → the agent's replies go back out over WhatsApp.

It is **multi-tenant**: each Luna client connects **their own** WhatsApp number,
and conversations are attributed to that client.

## Provider: 360dialog (Meta-native)

We go through **360dialog** (a Meta Solution Partner) rather than wiring up to
Meta directly. 360dialog is a thin, **Meta-native** proxy: the webhook payloads
and the send API are Meta's own Cloud API shapes, so a later move to direct Meta
is mostly a base-URL + auth swap, not a rewrite.

**All** 360dialog-specific logic lives in **`lib/whatsapp-provider.js`** — the
rest of the codebase only sees normalised data. To migrate to direct Meta later,
you change that one file (host `waba-v2.360dialog.io` → `graph.facebook.com/v{ver}`,
`D360-API-KEY` → `Authorization: Bearer`, add `/{phone_number_id}` to the path,
and switch inbound auth from the `?token=` shared secret to Meta's
`X-Hub-Signature-256` — the `verifyMetaSignature` stub is already there for it).

## How it fits the existing architecture

A WhatsApp customer has no widget, so the server does the widget's job:

```
Customer (WhatsApp)
   │ message
   ▼
360dialog ──webhook(?token=…)──▶ /api/whatsapp-webhook
                                     ├─ verify shared secret (fail-closed)
                                     ├─ map phone_number_id → clientId   (WHATSAPP_NUMBER_MAP)
                                     ├─ upsert Conversations row (by field id)  → Airtable
                                     ├─ publish new_conversation / message      → Ably (live inbox)
                                     ├─ ask Luna for a reply                     → /api/luna-chat
                                     └─ send reply to customer                   → 360dialog
                                     ▼
                          Agent dashboard inbox (live, via Ably)
                                     │ agent reply / take over / resolve
                                     ▼
                          /api/whatsapp-send ──▶ 360dialog ──▶ Customer
```

Ably channels/events are identical to the web widget, so the dashboard shows a
WhatsApp chat with no special handling: `new_conversation` on
`luna-dashboard:{clientId}` (carrying `channel:"whatsapp"` + `contact`), and
`message` / `handler_change` on `luna-chat:{clientId}:{convId}`.

### Files

| File | Purpose |
| --- | --- |
| `lib/whatsapp-provider.js` | **The provider seam** — 360dialog config/routing, inbound verify + parse, send, and the `verifyMetaSignature` stub for the future direct-Meta cutover. |
| `lib/wa-format.js` | Provider-agnostic: Luna rich reply → WhatsApp plain text, message chunking. |
| `lib/wa-conversations.js` | Conversations-table upsert/read by **field id** (`returnFieldsByFieldId=true`). |
| `lib/wa-store.js` | Optional Upstash: dedupe + Luna's multi-turn memory. |
| `lib/ably-rest.js` | Server-side Ably publish (the widget's job, done server-side). |
| `api/whatsapp-webhook.js` | Inbound: verify → parse → upsert → publish → Luna reply. |
| `api/whatsapp-send.js` | Agent outbound + takeover/resolve control plane. |
| `public/dashboard.html` | WhatsApp badge + mirrors agent send/takeover/resolve to the Cloud API. |

## Data model (no schema change)

Writes go to the existing **Conversations** table (`tblyin27D2J9ejHvf`) by field
id. Conversation id is **`wa_<phoneNumberId>_<from>`** (deterministic, so the
same customer always maps to the same conversation; the recipient for replies is
derived straight from the id). `History` accumulates `role: text` lines
(`user:` / `luna:` / `agent:`). Upsert rule: an existing conversation is only
**re-opened** if its handler is `Resolved`/`Closed` — an active agent is never
yanked out of a live chat.

> Per-message logging to the **Messages** table (`tblGlvZLU8xub2LHK`) with
> `direction`/`deliveryStatus` is a later phase and is **not** wired up here.

## Environment variables

Set on the `luna-chat-endpoint` Vercel project. Reuse the existing
`AIRTABLE_KEY`, `ABLY_ROOT_KEY`, `ANTHROPIC_API_KEY`, and (recommended)
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

| Var | Required | Notes |
| --- | --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | yes | Random secret. Appended to the 360dialog webhook URL as `?token=…` and used for the GET handshake. Server-only. |
| `WHATSAPP_NUMBER_MAP` | yes | JSON mapping each `phone_number_id` to a client. Value is either the client's Airtable record id, or `{ "clientId":"rec…", "apiKey":"<D360 key>" }`. |
| `WHATSAPP_D360_KEYS` | for sending | Optional JSON `{ phone_number_id: <D360-API-KEY> }` if you didn't put `apiKey` in the map above. |
| `WHATSAPP_D360_API_KEY` | for sending | Optional single global D360 key (single-number setups). |
| `WHATSAPP_API_BASE` | no | Default `https://waba-v2.360dialog.io`. Use `https://waba-sandbox.360dialog.io` for the sandbox. |
| `WHATSAPP_AI_AUTOREPLY` | no | `false` sends every WhatsApp chat straight to a human (new chats open as **Waiting**). Default: Luna answers (new chats open as **AI**). |
| `META_APP_SECRET` | no | Only used by the future direct-Meta `verifyMetaSignature` path. |

Example multi-tenant map (each number gets its own D360 key):

```
WHATSAPP_NUMBER_MAP={
  "1112223334445":{"clientId":"rec5zCfgH6dkvdClV","apiKey":"D360-aaa..."},
  "9998887776665":{"clientId":"recAbc123...","apiKey":"D360-bbb..."}
}
```

**Webhook URL to register in 360dialog:**
`https://chat.travelify.io/api/whatsapp-webhook?token=<WHATSAPP_VERIFY_TOKEN>`

## Provisioning (Phase 0 — human/account tasks)

1. Verify the Travelgenix business in **Meta Business Manager** (long lead time — the critical path).
2. Sign up to the **360dialog Partner Platform** and register as a **Meta Tech Provider** (required to onboard more than ~3 numbers; Meta caps onboarding at ~200 new clients / rolling 7 days).
3. Onboard a client's number (Embedded Signup), grab its **`phone_number_id`** and per-number **`D360-API-KEY`**, and add them to `WHATSAPP_NUMBER_MAP` (+ keys).
4. Set the env vars in Vercel and register the webhook URL above in 360dialog.

> **Diligence before scaling to ~300 clients** (sales-/login-walled, unverified here): EU data residency for Cloud API "Local Storage", ISO 27001/SOC 2, and the per-channel/partner-plan pricing at volume.

## Behaviour

- Inbound text, button replies, and interactive list replies are handled; other types post a placeholder into the inbox and route to a human.
- **Luna answers** by default (reusing the full web brain), stripping `[BLOCK]` cards to clean WhatsApp text and splitting long replies. Turn off per-deployment with `WHATSAPP_AI_AUTOREPLY=false`.
- **Escalation** flips the chat to *Waiting* and Luna stops; the agent picks it up.
- **Take over** (dashboard) marks it *Agent* so Luna stops even before the agent's first message; **Resolve** ends it (a later message re-opens a fresh chat).
- Meta's at-least-once webhook retries are de-duplicated by message id (needs Upstash).

### Limitations
- **24-hour window**: WhatsApp only allows free-form replies within 24h of the customer's last message; outside it you need approved **templates** (not wired up here).
- **Upstash recommended**: without it, dedupe and Luna's multi-turn memory degrade (each message answered statelessly).
- Outbound media/templates and delivery/read receipts are out of scope for this pass.

## Testing

Verification handshake (echoes the challenge):

```bash
curl "https://chat.travelify.io/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=12345"
# → 12345
```

Simulated inbound (360dialog/Meta-native shape; note the `?token=`):

```bash
curl -X POST "https://chat.travelify.io/api/whatsapp-webhook?token=YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entry":[{"changes":[{"field":"messages","value":{
    "metadata":{"phone_number_id":"YOUR_PHONE_NUMBER_ID"},
    "contacts":[{"profile":{"name":"Test User"},"wa_id":"447700900000"}],
    "messages":[{"from":"447700900000","id":"wamid.TEST1","type":"text","text":{"body":"Do you have summer holidays to Crete?"}}]
  }}]}]}'
```

A real number messaging the business line is the end-to-end test: the chat
appears in the inbox with a **WhatsApp** badge, Luna replies on the phone, and an
agent reply in the dashboard arrives on the phone.
