# tg-backoffice

Travelgenix **back office** — the single source of truth for **bookings, financials and
suppliers**. A Next.js (App Router, TypeScript) app over the Supabase `backoffice` schema in
the **Travelgenix CRM** project (`iexryjynfaktfbvzlwlx`).

It connects to **Postgres directly, server-side** (the `backoffice`/`contracts` schemas are not
exposed to PostgREST), matching how `contract-loader` works. The schema itself is defined in the
sibling `db/backoffice/*.sql` migrations (already applied to Supabase).

## Pages
- **Overview** — KPIs: bookings, sales value, margin, AR balance due, AP payables.
- **Bookings** — `backoffice.v_booking_finance`.
- **Payments & AR** — `backoffice.v_receipts_due` (deposit/balance schedule).
- **Suppliers & AP** — supplier master + outstanding payables.

## Run locally
```bash
npm install
cp .env.example .env.local   # set DATABASE_URL (Supabase transaction pooler, service role)
npm run dev
```

## Env
| Var | What |
|-----|------|
| `DATABASE_URL` | Supabase **transaction pooler** connection string (port 6543), service/postgres role. See `.env.example`. |

## Deploy (Vercel)
1. Create a Vercel project from this repo (framework: Next.js, Node 24.x — same as `travelgenix-crm`).
2. Add `DATABASE_URL` as an environment variable (Production + Preview).
3. Deploy.

---

## ⚠️ This folder is staged inside `luna-chat-endpoint`
The session that generated this could only write to `luna-chat-endpoint`, so the app was staged
here on branch `claude/back-office-tool-research-2evxqd`. To give it its own home:

```bash
# create the empty repo on GitHub first (e.g. andyspeight/tg-backoffice), then:
git clone https://github.com/andyspeight/luna-chat-endpoint
cd luna-chat-endpoint && git checkout claude/back-office-tool-research-2evxqd
cp -r tg-backoffice /tmp/tg-backoffice
cd /tmp/tg-backoffice && git init && git add . && git commit -m "Initial back-office scaffold"
git remote add origin https://github.com/andyspeight/tg-backoffice.git
git push -u origin main
```
Then connect the new repo to a Vercel project and set `DATABASE_URL`.
