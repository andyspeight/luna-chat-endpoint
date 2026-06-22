# tg-backoffice — Handover

This document lets a fresh Claude Code session (or engineer) pick up the Travelgenix back office
with full context. Read it top to bottom before making changes.

---

## 1. What this is

The **back office** is the single source of truth for **bookings, financials and supplier
information** for Travelgenix. It is a financial + reconciliation layer that unifies two existing
"booking" worlds and adds the money layer they lack.

- **Stack:** Next.js (App Router, TypeScript) → Vercel; data in **Supabase Postgres**.
- **This repo (`tg-backoffice`)** is the app. The database lives in the existing **Travelgenix
  CRM** Supabase project and is already migrated (see §4).
- It talks to **Postgres directly, server-side** (the `backoffice`/`contracts` schemas are **not**
  exposed to PostgREST), the same way `contract-loader` does — via `postgres.js` + `DATABASE_URL`.

### Decisions already made (with the product owner, Andy)
| Topic | Decision |
|---|---|
| Finance depth | **Booking finance** — customer payments in, supplier costs/payments out, margin, balances. *Not* full double-entry/trust accounting (yet). |
| Tenancy | **Multi-tenant**, keyed on `contracts.account`. |
| Booking sources | Supplier confirmation emails (Gmail), the Travelgenix booking engine, and manual entry. |
| Architecture | **A neutral unifying order layer** (`backoffice` schema) that both the engine and CRM map into — so neither owns "the booking". |
| Home | A **dedicated repo** (this one) + its own Vercel project. |

---

## 2. The wider Travelgenix system (so you don't rebuild what exists)

Everything is **many small repos → many Vercel apps → shared Supabase + Airtable backends**, under
the Vercel team `agendasgroup` (`team_60GtIq862EeN5iuKz2mbafeR`).

| Vercel project | Role | Backend |
|---|---|---|
| `travelgenix-crm` (`github.com/andyspeight/travelgenix-crm`, Next.js) | Agent-facing CRM | Supabase `public` schema |
| `contract-loader` (`contracts.travelify.io`, Next.js) | Inventory/contracting + booking **engine** | Supabase `contracts` schema |
| `luna-travel` | B2C traveller app | Supabase `luna_travel` schema |
| `tg-support-desk` | Support desk | separate `tg-support-desk` Supabase project |
| `luna-chat-endpoint` | Luna AI chat widget product | Airtable base `app6Ot3eOb3DangkB` |
| `tg-crm-b2b`, `tg-onboarding`, `tg-widgets`, `luna-marketing`, `tool-hub`, `luna-trends`, `tg-logo-library` | other apps | mixed |

### Backends
- **Supabase "Travelgenix CRM"** — project ref **`iexryjynfaktfbvzlwlx`**, region eu-west-1, Postgres 17.
  Schemas:
  - `public` (14 tables) — CRM: `agencies`, `users`, `households`, `contacts`, `suppliers`,
    `trips`, `trip_components`, `trip_passengers`, `interactions`, `tasks`, `notes`,
    `preferences`, `journeys`, `journey_runs`.
  - `contracts` (58 tables) — the engine: `contract`, `account`, `api_key`, `property`/`room_unit`/
    `physical_room`/`rate`/`rate_period`/`allocation`/`occupancy_price`, `reservation`,
    `accommodation_booking`, `car_*` (`car_contract`/`car_vehicle`/`car_rate`/`car_reservation`/
    `car_booking`), `flight_*`, `transfer_*`, `ticket_*`, `stop_sale`, oversell guards.
  - `luna_travel` (9 tables) — B2C app.
  - `backoffice` (new) — **this project's schema** (see §3).
- **Airtable** base `app6Ot3eOb3DangkB` — Luna chat platform. Relevant table: **`Suppliers`**
  (`tbl5dbJmO5E7lQ4y6`, ~60 trade suppliers — Sunhotels, Gold Medal, Jet2 Holidays, Bedsonline…)
  with fields Name, Type (`API Supplier`/`Tour Operator`), Bookability, `No Booking Fees`, Active,
  Notes, Status. Also `Clients` (`tbl6CZ7aVzq1wHF2v`).

### Tenant model (important)
- **Engine + back office tenant = `contracts.account`** (`account_id uuid`). Rows:
  - `Demo Account` — `external_ref='demo'`, `settings.brand` = "Sunshine Travel".
  - `Travelgenix` — `external_ref='recRCZl6afFpBFSW6'` (an **Airtable Clients record id** — accounts
    map to the Airtable client master).
- The CRM `public.agencies` is a **separate** tenant (1 demo row, id `00000000-0000-0000-0000-000000000001`),
  not FK-linked to `contracts.account`. Bridging them is part of the sync work (§7).

---

## 3. The `backoffice` schema (already applied & verified)

All money is `numeric(14,2)`; enums live in-schema; generated columns compute margins/balances;
functions are `security invoker` with `search_path = ''`. **Security model matches `contracts`:
RLS enabled, no policies, access via the `service_role` only** (the app connects server-side).

| Table | Purpose / key behaviour |
|---|---|
| `supplier` | Canonical supplier master. `account_id` NULL = shared/global trade supplier. Carries finance fields + `airtable_supplier_id`/`external_refs` for reconciliation. |
| `booking` | The canonical order. Tenant `account_id`; links `trip_id`→`public.trips`, `reservation_id`→`contracts.reservation`, `household_id`, `lead_contact_id`. `booking_no` auto (gapless per account). `sell_total`/`cost_total` maintained from items; `margin_total`, `balance_due` are generated; `paid_total`/`payment_status` maintained from cleared receipts. |
| `booking_item` | Component lines (accommodation/car/flight/transfer/ticket/insurance/fee/…). `sell_amount`/`cost_amount`/`tax_amount`, generated `margin`. Polymorphic source link: `source_schema`/`source_table`/`source_id` (unique when set) back to the originating engine booking or CRM component. |
| `invoice` + `invoice_line` | Customer invoices; `invoice_no` assigned (gapless) when status leaves `draft`. |
| `receipt` | Customer money IN. `kind` (deposit/balance/full/additional/refund/adjustment), `status` (scheduled/pending/cleared/failed/refunded/void). Only **cleared** receipts count toward `paid_total`; refunds count negative. `status='scheduled'` rows are the payment plan. |
| `supplier_bill` | AP — what we owe a supplier (cost). Generated `outstanding = amount - paid_total`. |
| `supplier_payment` | Money OUT to suppliers; updates the bill's `paid_total`/`status` when `status='paid'`. |
| `ledger_entry` | **Append-only** journal (D/C, chart-of-accounts enum). UPDATE/DELETE blocked by trigger for **all** roles incl. service_role. FK booking→ledger means a booking with financial history can't be deleted. *Not yet auto-posted — see §7.* |
| `number_sequence` + `next_number(account, kind)` | Gapless per-account reference generator. |

Views: `v_booking_finance`, `v_receipts_due` (AR schedule), `v_supplier_payables` (AP outstanding).

### Migrations (in Supabase migration history; mirrored in `db/backoffice/*.sql`)
- `backoffice_01_foundation` — schema, enums, numbering, `supplier`, `booking`, `booking_item`, totals triggers.
- `backoffice_02_ar_ap` — invoices, receipts (AR), supplier bills/payments (AP), payment-state triggers.
- `backoffice_03_ledger_and_views` — append-only ledger + immutability guard, views.

### Verified
Auto ref `00001`; sell/cost/margin roll-up from items; only cleared receipts count to paid;
`payment_status` transitions; ledger immutable; audit-protective FKs. Test data removed, sequence reset.

---

## 4. Running / deploying this app

```bash
npm install
cp .env.example .env.local     # set DATABASE_URL
npm run dev                    # or: npm run build
```
- **`DATABASE_URL`** = Supabase **transaction pooler** string (port 6543), service/postgres role
  (Supabase → Project Settings → Database → Connection string → *Transaction pooler*). `postgres.js`
  is configured with `prepare:false` (pgBouncer) and `ssl:'require'`.
- **Vercel:** new project from this repo, framework Next.js, Node 24.x (match `travelgenix-crm`);
  add `DATABASE_URL` for Production + Preview.
- Build is verified on **Next.js 16** (App Router). Data pages are `runtime = 'nodejs'` +
  `dynamic = 'force-dynamic'` (server components query Postgres directly).

Pages: `/` (KPIs), `/bookings`, `/payments` (AR), `/suppliers` (+AP). All degrade to a friendly
"configure DATABASE_URL" notice if the env var is missing.

---

## 5. ⚠️ Pre-existing security issues to resolve (NOT introduced here)
The Supabase advisor flags these on the **existing** schemas — they matter because finance now links to them:
- `rls_disabled_in_public` ×14 — the whole CRM `public` schema has RLS **disabled** (anon key can read/write every row).
- `sensitive_columns_exposed` ×1 — passport data in `public.contacts` is exposed (GDPR risk).
- `function_search_path_mutable` ×2, `extension_in_public` ×1 (WARN).

Get the owner's sign-off before changing existing-schema security (it touches the live CRM app).

---

## 6. How to continue (MCP tools you'll have in a new session)
Supabase (`mcp__Supabase__*`): `apply_migration`, `execute_sql`, `list_tables`, `get_advisors`.
Airtable (`mcp__Airtable__*`): `list_records_for_table` etc. (base `app6Ot3eOb3DangkB`).
Vercel (`mcp__Vercel__*`), Gmail (`mcp__Gmail__*`), GitHub (scope this repo).
Always re-run `list_tables`/`get_advisors` before schema changes; apply via `apply_migration`.

---

## 7. Roadmap (recommended order)

1. **Supplier reconciliation** — populate `backoffice.supplier`:
   - Airtable `Suppliers` (`tbl5dbJmO5E7lQ4y6`): Name→`name`; Type→`kind` (`API Supplier`→`bedbank`/
     `is_api_supplier=true`, `Tour Operator`→`tour_operator`); Active→`active`; rec id→`airtable_supplier_id`;
     Bookability/No-Booking-Fees→`external_refs`. These are global (`account_id` NULL).
   - `contracts.contract` suppliers and `public.suppliers` (9) → account-scoped rows.
   - Keep Airtable as a synced read-copy for the chat widget; Postgres is master.
2. **Sync wiring** — populate `booking`/`booking_item` from sources, using the polymorphic
   `source_schema`/`source_table`/`source_id` to stay idempotent:
   - `contracts.reservation` / `car_reservation` / `*_booking` → one `booking` (+ items), set `reservation_id`.
   - `public.trips` → `booking` (set `trip_id`); `trip_components` → `booking_item`.
   - Do this as SQL functions/edge functions or a server route — controlled & auditable, never a blind trigger cascade.
3. **Ledger auto-posting** — post `ledger_entry` rows on receipt-cleared, bill-raised, supplier-paid,
   refund, adjustment (triggers or service code), so the journal always reconciles to the views.
4. **Ingestion** — (a) booking-engine import endpoint keyed on `account.external_ref`/`DeepLinkSiteID`;
   (b) Gmail supplier-confirmation parsing → a **review queue** (draft `booking_item`s, human-approved
   before money commits). Reuse the existing "Suggested by Luna" review pattern.
5. **UI build-out** — booking detail (items, receipts, bills, ledger), record-payment / pay-supplier
   actions, invoice generation/PDF, cash position & aged-balance reports, supplier statements.

---

## 8. Repo provenance
The DB migrations + design doc + this scaffold were produced in a session scoped to
`luna-chat-endpoint`; the app was staged there under `tg-backoffice/` and copied into this repo.
Canonical SQL is in Supabase migration history (`backoffice_01..03`) and mirrored in `db/backoffice/`.
