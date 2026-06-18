# WhatsApp Phase 3 — self-service onboarding (Embedded Signup) for ~300 clients

**Status:** plan only (no code yet). Phases 1–2 + AI are built; the demo connects
numbers manually via the static `WHATSAPP_NUMBER_MAP` env. Phase 3 lets each of
the ~300 SME clients **connect their own WhatsApp number themselves**, from the
Luna dashboard, with no manual env edits and no Travelgenix touching Meta per
client.

## What changes from the demo

| | Demo (now) | Phase 3 |
| --- | --- | --- |
| Number → client mapping | static `WHATSAPP_NUMBER_MAP` env | **dynamic**, stored per client (Airtable) |
| Onboarding | we create the app + paste ids | client clicks **"Connect WhatsApp"**, completes Meta Embedded Signup |
| Who touches Meta | us, per client | the client (self-service); we're the Tech Provider behind it |
| Scale | a handful | hundreds (subject to Meta's onboarding cap) |

The provider seam (`lib/whatsapp-provider.js`) and everything downstream stay the
same — Phase 3 only changes **how config is sourced** (DB instead of env) and
**how numbers get provisioned** (Embedded Signup instead of manual).

## Prerequisites (account / human, the critical path)

1. **Meta Business Verification** of Travelgenix (long lead time — start first).
2. **Tech Provider enrolment** — register the Meta app as a Tech Provider and
   pass **App Review** for Advanced Access to `whatsapp_business_management` +
   `whatsapp_business_messaging` (App Review needs a screencast of the
   business-facing UI sending a message + creating a template; ~1–7 days).
3. **On Gupshup:** complete the **Tech Provider Program** on Gupshup + Meta and
   create a joint **Solution ID** (Gupshup as Solution Partner carries the Meta
   credit line, so clients don't each enter a card).
4. **Meta onboarding cap:** ~**200 new clients / rolling 7 days** — so ~300
   clients is ~2 weeks of onboarding minimum, not a single batch.

## Onboarding flow (Gupshup Partner API — our current provider)

```
Client dashboard ──"Connect WhatsApp"──▶ our backend
   1. Partner API: Create App (pre-linked to our Partner ID)         → appName
   2. Partner API: Generate Embedded-Signup link  ──────────────────▶ client
   3. Client completes Meta Embedded Signup (Login with Facebook):
        selects/creates their Business + WABA + phone number, verifies OTP
   4. Callback to us: waba_id, phone_number_id, business phone, app ready
   5. We set the app's inbound callback URL:
        https://chat.travelify.io/api/whatsapp-webhook?token=<secret>
   6. Register/activate the number (Cloud API) → "Channel Live"
   7. Store the mapping (below) and flip the client's status to Connected
```

The Meta-side pieces (Embedded Signup popup, WABA creation, OTP) are handled by
the flow; we orchestrate via Gupshup's Partner API and store the result.
(360dialog's Partner-hosted Embedded Signup and Meta-direct's `FB.login` +
`oauth/access_token` code exchange are equivalent shapes — the seam means we can
support whichever provider `WHATSAPP_PROVIDER` is set to.)

## Data model — replace the env map with per-client storage

Add a dedicated **`WhatsAppChannels`** table (one row per connected number —
supports a client having more than one later), linked to **Clients**:

| Field | Type | Notes |
| --- | --- | --- |
| `Client` | link → Clients | owner (attribution) |
| `Provider` | singleSelect | `gupshup` / `360dialog` |
| `AppName` | text | Gupshup app name (routing key for inbound) |
| `BusinessPhone` | text | digits, international — the `wa_<biz>_…` key |
| `WabaId` | text | Meta WABA id |
| `PhoneNumberId` | text | Meta phone-number id (for the Meta-direct future) |
| `Status` | singleSelect | `Pending` / `Connected` / `Error` / `Disabled` |
| `ConnectedAt` | dateTime | |

**Secrets — important:** with **Gupshup** the API key is **account-level** (one
`GUPSHUP_API_KEY` for all apps), so **no per-client secret needs storing** — the
table holds only non-secret identifiers. (If/when we go **Meta-direct**, each
client yields a per-client system-user **token** that *is* a secret and must be
encrypted at rest or held in a secret store — never plaintext Airtable. Plan for
an encrypted column or a KV secret keyed by client.)

## Code changes

1. **Provider config goes async + DB-backed.** `getNumberConfig(routingKey)` and
   `getConfigByClientId(clientId)` read `WhatsAppChannels` (cached briefly in
   Upstash) instead of parsing the env map. This is contained to the provider
   layer; the webhook/send already `await` everything.
2. **New onboarding endpoints** (agent-authed, like `whatsapp-send`):
   - `POST /api/whatsapp-onboard/start` → create app + return the Embedded-Signup link.
   - `GET/POST /api/whatsapp-onboard/callback` → receive provisioning result, set the webhook, register the number, write the `WhatsAppChannels` row.
   - `POST /api/whatsapp-onboard/disconnect` → disable a channel.
3. **Dashboard UI** — a **Settings → WhatsApp** panel with a "Connect WhatsApp"
   button (launches the signup), live status, the connected number, and
   disconnect. Mirrors the existing settings panels.
4. **Number registration + 2FA** — set the 6-digit PIN, handle display-name
   approval, and the green-tick (Official Business Account) application per
   client (Gupshup submits on their behalf).

## Operational & compliance notes

- **Per-client business verification** is needed for higher messaging tiers /
  green tick — that's on each client (we surface status, Gupshup assists).
- **24-hour window**: outside it, re-engagement needs approved **templates**
  (a Phase 4+ addition — template management + a small template library).
- **EU data residency**: set Gupshup `storageRegion` to **Germany** at app
  creation for EU clients (confirm billing-data residency separately).
- **Throughput/limits** are Meta-governed and now per-business-portfolio.

## Suggested sequencing

1. **Confirm with Gupshup sales** (blockers for design): partner per-message
   rate + any minimum; exact Partner-API onboarding calls + callback payloads;
   whether the Meta-format **v3 passthrough** covers everything we need;
   `storageRegion` options + billing-data residency.
2. Meta **Business Verification** + **Tech Provider / App Review** (long lead — start now).
3. Build the **`WhatsAppChannels` table** + switch the provider to **DB-backed config** (keep the env map as a fallback).
4. Build the **onboarding endpoints** + **dashboard UI** against Gupshup's Partner API.
5. **Pilot**: onboard 2–3 friendly clients end-to-end; verify attribution, AI, takeover, billing.
6. **Roll out** in batches within the ~200/week cap; monitor quality ratings and delivery.

## Open questions for Andy / Gupshup

- One WhatsApp number per client, or could some have several? (Drives 1:1 vs the channels table — I've assumed the table for headroom.)
- Do we want clients **self-serving** the connect flow, or Travelgenix doing it **on their behalf** in the dashboard? (Both are supportable; changes the UI emphasis.)
- Confirm the commercial model to clients (per-number add-on price) so onboarding can show/agree it at connect time.
