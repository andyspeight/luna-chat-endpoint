# Luna Chat — WhatsApp channel

Brings WhatsApp into the **same agent inbox** Luna already uses for the web
widget. A client's customer messages the client's own WhatsApp number → the
conversation appears live in `dashboard.html` (tagged **WhatsApp**) → Luna
answers (grounded in that client's knowledge) until it escalates or an agent
takes over → the agent's replies go back out over WhatsApp.

It is **multi-tenant**: each Luna client connects **their own** WhatsApp number,
and conversations are attributed to that client.

## Providers (pluggable)

The provider is swappable via one env var — `WHATSAPP_PROVIDER` — and **all**
provider-specific logic lives under `lib/providers/`. The rest of the app only
sees normalised data, so changing provider (or later going direct to Meta) is a
config change plus one file, never a rewrite.

| `WHATSAPP_PROVIDER` | When | Cost shape | Migration to direct Meta |
| --- | --- | --- | --- |
| **`gupshup`** *(default)* | **Demo / initial setup** | **No fixed fee, no per-number licence** — pay-as-you-go wallet (~$0.001/msg + Meta) | Moderate (proprietary API; Gupshup offers a Meta-format "v3 passthrough") |
| `360dialog` | Scale / clean exit | £500–1,000/mo partner fee + ~€25/number | Easiest — Meta-native proxy (host + auth swap) |

We start on **Gupshup** because it's the cheapest to stand up and demo (no fixed
monthly fee). We can flip to 360dialog later by changing `WHATSAPP_PROVIDER` and
the number map — the integration code is unchanged.

## How it fits the existing architecture

A WhatsApp customer has no widget, so the server does the widget's job:

```
Customer (WhatsApp)
   │ message
   ▼
Provider ──webhook(?token=…)──▶ /api/whatsapp-webhook
                                   ├─ verify shared secret (fail-closed)
                                   ├─ map number/app → clientId   (WHATSAPP_NUMBER_MAP)
                                   ├─ upsert Conversations row (by field id)  → Airtable
                                   ├─ publish new_conversation / message      → Ably (live inbox)
                                   ├─ ask Luna for a reply                     → /api/luna-chat
                                   └─ send reply to customer                   → Provider
                                   ▼
                        Agent dashboard inbox (live, via Ably)
                                   │ agent reply / take over / resolve
                                   ▼
                        /api/whatsapp-send ──▶ Provider ──▶ Customer
```

Ably channels/events are identical to the web widget, so the dashboard shows a
WhatsApp chat with no special handling: `new_conversation` on
`luna-dashboard:{clientId}` (carrying `channel:"whatsapp"` + `contact`), and
`message` / `handler_change` on `luna-chat:{clientId}:{convId}`.

### Files

| File | Purpose |
| --- | --- |
| `lib/whatsapp-provider.js` | **The provider seam (dispatcher)** — picks the impl by `WHATSAPP_PROVIDER`; exposes one interface to the rest of the app. |
| `lib/providers/gupshup.js` | Gupshup impl (default). Proprietary API normalised onto the common contract. |
| `lib/providers/360dialog.js` | 360dialog impl (Meta-native). |
| `lib/providers/_shared.js` | Shared inbound auth (`?token=` / `x-webhook-token`, fail-closed) + helpers. |
| `lib/wa-format.js` | Provider-agnostic: Luna rich reply → WhatsApp plain text, message chunking. |
| `lib/wa-conversations.js` | Conversations-table upsert/read by **field id** (`returnFieldsByFieldId`). |
| `lib/wa-store.js` | Optional Upstash: dedupe + Luna's multi-turn memory. |
| `lib/ably-rest.js` | Server-side Ably publish (the widget's job, done server-side). |
| `api/whatsapp-webhook.js` | Inbound: verify → parse → upsert → publish → Luna reply. |
| `api/whatsapp-send.js` | Agent outbound + takeover/resolve control plane. |

## Data model (no schema change)

Writes go to the existing **Conversations** table (`tblyin27D2J9ejHvf`) by field
id. Conversation id is **`wa_<businessNumber>_<customerNumber>`** (deterministic,
so the same customer always maps to the same conversation; the reply recipient is
derived straight from the id). `History` accumulates `role: text` lines
(`user:` / `luna:` / `agent:`). An existing conversation is only **re-opened** if
its handler is `Resolved`/`Closed` — an active agent is never pulled out of a
live chat.

> Per-message logging to the **Messages** table (`tblGlvZLU8xub2LHK`,
> `direction`/`deliveryStatus`) is a later phase and is **not** wired up here.

## Environment variables

Set on the `luna-chat-endpoint` Vercel project. Reuse the existing
`AIRTABLE_KEY`, `ABLY_ROOT_KEY`, `ANTHROPIC_API_KEY`, and (recommended)
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.

**Common**

| Var | Required | Notes |
| --- | --- | --- |
| `WHATSAPP_PROVIDER` | no | `gupshup` (default) or `360dialog`. |
| `WHATSAPP_VERIFY_TOKEN` | yes | Random secret. Appended to the provider's webhook/callback URL as `?token=…`. Server-only. |
| `WHATSAPP_NUMBER_MAP` | yes | JSON mapping each number/app to a client (shape depends on provider — below). |
| `WHATSAPP_AI_AUTOREPLY` | no | `false` sends every WhatsApp chat straight to a human (new chats open **Waiting**). Default: Luna answers (new chats open **AI**). |

**Gupshup (default)** — `WHATSAPP_NUMBER_MAP` is keyed by the **Gupshup app name**:

```
WHATSAPP_NUMBER_MAP={
  "LunaDemoApp":{"clientId":"rec5zCfgH6dkvdClV","phone":"447700900000"}
}
GUPSHUP_API_KEY=<your Gupshup account API key>     # account-level; or put apiKey per entry
# GUPSHUP_API_BASE  (optional, default https://api.gupshup.io/wa/api/v1)
```

**360dialog** — `WHATSAPP_NUMBER_MAP` is keyed by the **`phone_number_id`**:

```
WHATSAPP_NUMBER_MAP={"111222333":{"clientId":"rec…","apiKey":"D360-…"}}
# or WHATSAPP_D360_KEYS={"111222333":"D360-…"} / WHATSAPP_D360_API_KEY=…
# WHATSAPP_API_BASE (optional, default https://waba-v2.360dialog.io)
# META_APP_SECRET   (only for the future direct-Meta verifyMetaSignature path)
```

## Quick start — Gupshup (demo)

1. Create a **Gupshup** account → create a **WhatsApp app** (use the free
   **sandbox** to test instantly, or connect a real number).
2. Copy your **API key** (Gupshup dashboard → *API key*) → `GUPSHUP_API_KEY`.
   Note the app's **name** and its **source phone number**.
3. Set env vars (above): `WHATSAPP_PROVIDER=gupshup`, `WHATSAPP_VERIFY_TOKEN`,
   `WHATSAPP_NUMBER_MAP` (app name → `{clientId, phone}`).
4. In Gupshup, set the app's **inbound/callback URL** to:
   `https://chat.travelify.io/api/whatsapp-webhook?token=<WHATSAPP_VERIFY_TOKEN>`
5. Message the app's number (or use the sandbox) — the chat appears in the inbox.

> For the rollout to ~300 clients you'd move onto Gupshup's **Partner/ISV
> program** (Embedded Signup, per-client onboarding) or switch
> `WHATSAPP_PROVIDER=360dialog`. Diligence before scaling (sales-walled,
> unverified here): negotiated partner per-message rate + any minimum; EU data
> residency (`storageRegion` Germany/UK — but billing data reportedly stays in
> India); SOC 2 / DPA; and the **+6% marketing markup from 1 Jan 2026** (largely
> moot for service traffic).

## Behaviour

- Inbound text, button replies and list replies are handled; other types post a placeholder into the inbox and route to a human.
- **Luna answers** by default (reusing the full web brain), stripping `[BLOCK]` cards to clean WhatsApp text and splitting long replies. Turn off with `WHATSAPP_AI_AUTOREPLY=false`.
- **Escalation** flips the chat to *Waiting* and Luna stops; the agent picks it up.
- **Take over** (dashboard) marks it *Agent* so Luna stops even before the agent's first message; **Resolve** ends it (a later message re-opens a fresh chat).
- Provider at-least-once webhook retries are de-duplicated by message id (needs Upstash).

### Limitations
- **24-hour window**: WhatsApp only allows free-form replies within 24h of the customer's last message; outside it you need approved **templates** (not wired up here).
- **Upstash recommended**: without it, dedupe and Luna's multi-turn memory degrade (each message answered statelessly).
- Gupshup is a **proprietary** API (its Meta-format passthrough isn't wired here); a later move to direct Meta is easier from `360dialog`.
- Outbound media/templates and delivery/read receipts are out of scope for this pass.

## Testing

Simulated inbound — **Gupshup** shape (note the `?token=`):

```bash
curl -X POST "https://chat.travelify.io/api/whatsapp-webhook?token=YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"app":"LunaDemoApp","type":"message","timestamp":1718000000000,"version":2,
       "payload":{"id":"gBEG-TEST-1","source":"447700900123","type":"text",
       "payload":{"text":"Do you have summer holidays to Crete?"},
       "sender":{"phone":"447700900123","name":"Test User"}}}'
```

Simulated inbound — **360dialog / Meta-native** shape:

```bash
curl -X POST "https://chat.travelify.io/api/whatsapp-webhook?token=YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"entry":[{"changes":[{"field":"messages","value":{
    "metadata":{"phone_number_id":"YOUR_PHONE_NUMBER_ID"},
    "contacts":[{"profile":{"name":"Test User"},"wa_id":"447700900123"}],
    "messages":[{"from":"447700900123","id":"wamid.TEST1","type":"text","text":{"body":"Hi"}}]
  }}]}]}'
```

A real number messaging the business line is the end-to-end test: the chat
appears in the inbox with a **WhatsApp** badge, Luna replies on the phone, and an
agent reply in the dashboard arrives on the phone.
