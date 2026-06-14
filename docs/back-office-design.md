# Back Office — design & build log

The back office is the single source of truth that links **bookings, financials and
supplier information**. It is built as a new, isolated **`backoffice`** schema inside the
existing **Travelgenix CRM** Supabase project (`iexryjynfaktfbvzlwlx`), alongside the CRM
(`public`) and the inventory/booking engine (`contracts`).

## Decisions (agreed with Andy)

- **Finance depth:** booking finance — per-booking money (customer payments in, supplier
  costs/payments out, margin/commission, balances), not full trust accounting/double-entry.
- **Tenancy:** multi-tenant. Tenant = `contracts.account` (the engine's tenant, which is
  already linked to the Airtable Clients master via `account.external_ref`).
- **Booking sources:** supplier confirmation emails (Gmail), the Travelgenix booking engine,
  and manual entry.
- **Architecture:** a **neutral unifying order layer** that both the `contracts` engine and the
  `public` CRM map into — so neither owns "the booking", avoiding a competing source of truth.

## Why a new layer (not money bolted onto `public.trips`)

Two parallel "booking" worlds already exist and were not linked:
1. `public.trips` / `trip_components` — CRM, agent-facing (had `total_value`, `commission`).
2. `contracts.*` — a real inventory/contracting + booking engine (accommodation, car, flight,
   transfer, ticket bookings; `reservation`/`car_reservation` already track
   total/paid/outstanding/payment_status; rates carry cost/sell/markup/commission).

Money was fragmented (a `payment` jsonb blob per booking, paid/outstanding on reservations)
with **no** customer-payment ledger, supplier payables, invoices, or audit journal. The
`backoffice` layer adds those and references the source rows in either world.

## Schema (applied)

Migrations in Supabase history:
- `backoffice_01_foundation` — schema, enums, `number_sequence` + `next_number()`, `supplier`,
  `booking`, `booking_item`, totals triggers.
- `backoffice_02_ar_ap` — `invoice`/`invoice_line`, `receipt` (AR), `supplier_bill`/
  `supplier_payment` (AP), payment-state triggers.
- `backoffice_03_ledger_and_views` — append-only `ledger_entry` + immutability guard,
  reporting views.

SQL mirrored in `db/backoffice/*.sql` for reproducibility (Supabase migration history is the
source of truth).

### Core tables
- **`booking`** — canonical order. Tenant `account_id`; links `trip_id`, `reservation_id`,
  `household_id`, `lead_contact_id`. `booking_no` auto-assigned (gapless per account).
  `sell_total`/`cost_total` maintained from items; `margin_total`, `balance_due` generated;
  `paid_total`/`payment_status` maintained from cleared receipts.
- **`booking_item`** — component lines (accommodation/car/flight/transfer/ticket/insurance/
  fee/…). `sell_amount`/`cost_amount`/`tax_amount`, generated `margin`, optional `supplier_id`,
  and a polymorphic `source_schema`/`source_table`/`source_id` back to the originating engine
  booking or CRM component.
- **`supplier`** — canonical supplier master. `account_id` NULL = shared/global trade supplier
  (e.g. the Airtable bedbanks). Carries finance fields + `airtable_supplier_id`/`external_refs`
  for reconciliation.
- **AR:** `invoice` (+ `invoice_line`), `receipt` (deposit/balance/refund…, status incl.
  `scheduled` for the payment plan).
- **AP:** `supplier_bill` (generated `outstanding`), `supplier_payment`.
- **`ledger_entry`** — append-only journal (D/C, chart-of-accounts enum). UPDATE/DELETE blocked
  by trigger for all roles. FK from ledger to booking means a booking with financial history
  cannot be deleted.

### Security model (matches `contracts`)
RLS enabled, **no policies**, access via the **service role** only (deny-by-default defense in
depth; app talks to these schemas server-side). Functions are `security invoker` with
`search_path = ''`.

## Verified
Booking ref auto `00001`; sell/cost/margin roll-up from items; only *cleared* receipts count to
`paid_total`; `payment_status` transitions; ledger immutable; audit-protective FKs. Smoke data
removed, sequence reset.

## Roadmap / next steps
1. **Supplier reconciliation** — merge Airtable Suppliers (60, base `app6Ot3eOb3DangkB`),
   `contracts` contract suppliers, and `public.suppliers` into `backoffice.supplier`; keep
   Airtable as a synced read-copy for the chat widget.
2. **Sync wiring** — populate `booking`/`booking_item` from `contracts` reservations/bookings
   and from `public.trips`/`trip_components` (functions/edge functions; controlled, auditable).
3. **Ledger auto-posting** — post journal entries automatically on receipt-cleared, bill-raised,
   supplier-paid, refund, adjustment.
4. **Ingestion** — booking-engine import endpoint; Gmail supplier-confirmation parsing into a
   review queue (drafts, human-approved before money commits).
5. **UI / API surface** — back-office dashboard (bookings, cash position, AR aging, supplier
   payables, margin).

## Pre-existing security issues to resolve (existing schemas, not introduced here)
- `rls_disabled_in_public` ×14 — CRM `public` tables have RLS disabled (anon key can read/write).
- `sensitive_columns_exposed` ×1 — passport data in `public.contacts` exposed.
- `function_search_path_mutable` ×2, `extension_in_public` ×1 (WARN).
