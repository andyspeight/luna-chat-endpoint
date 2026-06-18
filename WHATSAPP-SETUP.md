# Luna Chat — WhatsApp channel (Meta Cloud API)

Brings WhatsApp into the **same agent inbox** Luna already uses for the web
widget. A WhatsApp customer messages your business number; the conversation
appears live in `dashboard.html`, Luna answers (grounded in the client's
knowledge) until it escalates or an agent takes over, and the agent's replies
go straight back to the customer over WhatsApp.

Nothing about the web widget changes. WhatsApp conversations are tagged with a
green **WhatsApp** badge in the inbox; everything else (escalation, takeover,
resolve, transcripts, quality scoring) behaves exactly as it does for web.

---

## How it fits the existing architecture

The web widget runs in the customer's browser and publishes to Ably itself.
WhatsApp customers have no widget, so the server does that work for them:

```
Customer (WhatsApp app)
      │  message
      ▼
Meta WhatsApp Cloud API ──webhook──▶ /api/whatsapp-webhook
                                          │
                                          ├─ resolve client by phone_number_id      (lib/whatsapp.js)
                                          ├─ open / continue conversation           (lib/wa-store.js → Upstash)
                                          ├─ ask Luna for a reply                    (POST /api/luna-chat)
                                          ├─ send reply to customer                  (Cloud API)
                                          ├─ publish new_conversation / message      (lib/ably-rest.js → Ably)
                                          └─ persist transcript                      (POST /api/conversation → Airtable)
                                          ▼
                              Agent dashboard inbox (live, via Ably)
                                          │  agent reply
                                          ▼
                              /api/whatsapp-outbound ──▶ Cloud API ──▶ Customer
```

Ably channels and events are **identical** to the web widget, so the dashboard
needs no special handling to display a WhatsApp chat:

- `luna-dashboard:{clientId}` → `new_conversation` (carries `source:"whatsapp"`
  and `contact:{ waId, phoneNumberId }`)
- `luna-chat:{clientId}:{convId}` → `message`, `handler_change`

### New / changed files

| File | Purpose |
| --- | --- |
| `api/whatsapp-webhook.js` | Meta webhook: verification (GET) + inbound messages (POST). |
| `api/whatsapp-outbound.js` | Authenticated endpoint the dashboard calls to send an agent reply / control state. |
| `lib/whatsapp.js` | Cloud API send, signature verification, number↔client routing, rich→plain-text. |
| `lib/wa-store.js` | Upstash-backed session/routing/history state. |
| `lib/ably-rest.js` | Server-side Ably publish (the widget's job, done server-side). |
| `public/dashboard.html` | Channel badge + mirrors agent send/takeover/resolve to WhatsApp. |
| `vercel.json` | Function config for the two new endpoints. |

---

## Environment variables

Set these on the `luna-chat-endpoint` Vercel project. Reuse the existing
infra vars (`AIRTABLE_KEY`, `ABLY_ROOT_KEY`, `ANTHROPIC_API_KEY`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) — WhatsApp depends on all
of them.

### Single business number (simplest)

| Var | Required | Notes |
| --- | --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | The Cloud API **phone number ID** (not the phone number). |
| `WHATSAPP_TOKEN` | yes | Permanent access token (System User token recommended). |
| `WHATSAPP_VERIFY_TOKEN` | yes | Any string you choose; entered in Meta when subscribing the webhook. |
| `WHATSAPP_CLIENT_NAME` | yes | The Luna `ClientName` this number belongs to (must match Airtable). |
| `META_APP_SECRET` | recommended | Meta App secret; enables `X-Hub-Signature-256` verification. |
| `WHATSAPP_API_VERSION` | no | Graph API version, default `v21.0`. |
| `WHATSAPP_AI_AUTOREPLY` | no | `false` routes every WhatsApp chat straight to a human. Default: Luna answers. |

### Multiple numbers (multi-tenant)

Provide a JSON array — one entry per business number. Per-number `token` /
`verifyToken` override the globals; omit them to fall back to `WHATSAPP_TOKEN` /
`WHATSAPP_VERIFY_TOKEN`.

```
WHATSAPP_NUMBERS=[
  {"phoneNumberId":"123456789","clientName":"Travelgenix","token":"EAAG...","verifyToken":"tg-verify"},
  {"phoneNumberId":"987654321","clientName":"Acme Travel","token":"EAAH...","verifyToken":"acme-verify"}
]
```

`META_APP_SECRET` is app-wide and shared across numbers in the same Meta app.

---

## Meta provisioning (one time)

1. **Meta app** — at <https://developers.facebook.com> create (or reuse) a
   Business app and add the **WhatsApp** product.
2. **Number** — add/verify a WhatsApp business phone number. Note its
   **Phone number ID** and **WhatsApp Business Account (WABA) ID**.
3. **Permanent token** — create a System User in Business Settings, give it the
   WABA asset with `whatsapp_business_messaging` + `whatsapp_business_management`,
   and generate a non-expiring token → `WHATSAPP_TOKEN`.
4. **App secret** — App Settings → Basic → App Secret → `META_APP_SECRET`.
5. **Webhook** — WhatsApp → Configuration → Webhook:
   - Callback URL: `https://luna-chat-endpoint.vercel.app/api/whatsapp-webhook`
   - Verify token: the value you set in `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field.
6. Deploy with the env vars above set, then click **Verify and Save** in Meta.

---

## Behaviour

- **Inbound** text, button replies, and interactive list replies are handled.
  Media/location/reactions post a placeholder into the inbox and route the chat
  to a human (the agent opens WhatsApp to view the attachment).
- **Luna answers** by default, reusing the full web brain (knowledge, FCDO,
  escalation detection). Rich `[BLOCK]` cards are stripped to clean WhatsApp
  text; `**bold**`/links are converted to WhatsApp formatting; long replies are
  split into multiple messages.
- **Escalation** — when Luna escalates (or fails), the chat flips to *Waiting*
  and the bot stops answering; the agent picks it up in the dashboard.
- **Takeover** — clicking *Take over* marks the chat human-handled server-side,
  so Luna stops auto-replying even before the agent's first message.
- **Resolve** — ends the WhatsApp session; the customer's next message starts a
  fresh conversation.
- **Dedup** — Meta delivers webhooks at-least-once; messages are de-duplicated
  by message id (Upstash).

### Limitations

- **24-hour window** — WhatsApp only allows free-form business messages within
  24h of the customer's last message. Outside that window you must send an
  approved **message template** (not yet wired up here).
- **Upstash required** — multi-turn memory, agent↔customer routing, and
  takeover all rely on Upstash Redis. Without it, the bot still answers each
  message statelessly but loses continuity and human-takeover suppression.
- **Outbound media/templates** and **status (delivered/read) analytics** are
  out of scope for this first cut.

---

## Testing

**Webhook verification** (should echo the challenge):

```bash
curl "https://luna-chat-endpoint.vercel.app/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
# → 12345
```

**Simulated inbound** (Meta sends this shape; signature header omitted here —
set `META_APP_SECRET` empty in a test env, or sign the body):

```bash
curl -X POST https://luna-chat-endpoint.vercel.app/api/whatsapp-webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "object":"whatsapp_business_account",
    "entry":[{"changes":[{"field":"messages","value":{
      "metadata":{"phone_number_id":"YOUR_PHONE_NUMBER_ID"},
      "contacts":[{"profile":{"name":"Test User"},"wa_id":"447700900000"}],
      "messages":[{"from":"447700900000","id":"wamid.TEST1","type":"text","text":{"body":"Hi, do you have summer holidays to Crete?"}}]
    }}]}]
  }'
```

A real number messaging your business line is the end-to-end test: the chat
should appear in the dashboard inbox with a **WhatsApp** badge, Luna should
reply on the phone, and an agent reply in the dashboard should arrive on the
phone.
