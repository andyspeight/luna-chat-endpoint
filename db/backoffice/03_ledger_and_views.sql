-- Append-only financial journal: the audit backbone for "100% accurate".
create type backoffice.ledger_event as enum (
  'invoice_issued','invoice_voided','receipt_cleared','receipt_refunded',
  'bill_raised','bill_voided','supplier_paid','supplier_refund','adjustment','writeoff');
create type backoffice.ledger_account as enum (
  'sales','customer_ar','cash','supplier_ap','supplier_cost','commission','tax','adjustment');

create table backoffice.ledger_entry (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references contracts.account(id),
  booking_id     uuid references backoffice.booking(id),
  supplier_id    uuid references backoffice.supplier(id),
  event          backoffice.ledger_event   not null,
  ledger_account backoffice.ledger_account not null,
  direction      char(1) not null check (direction in ('D','C')),
  amount         numeric(14,2) not null check (amount >= 0),
  currency       char(3) not null default 'GBP',
  occurred_at    timestamptz not null default now(),
  actor          text,
  source_table   text,
  source_id      uuid,
  memo           text,
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index ledger_account_time_idx on backoffice.ledger_entry(account_id, occurred_at);
create index ledger_booking_idx      on backoffice.ledger_entry(booking_id);
create index ledger_supplier_idx     on backoffice.ledger_entry(supplier_id);

-- Immutability: forbid UPDATE/DELETE for everyone, including service_role.
create or replace function backoffice.ledger_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'backoffice.ledger_entry is append-only; % is not permitted', tg_op;
end; $$;
create trigger ledger_no_update before update on backoffice.ledger_entry
  for each row execute function backoffice.ledger_immutable();
create trigger ledger_no_delete before delete on backoffice.ledger_entry
  for each row execute function backoffice.ledger_immutable();

alter table backoffice.ledger_entry enable row level security;
-- no update/delete grant on purpose
grant select, insert on backoffice.ledger_entry to service_role;

-- ---------- reporting views ----------
create view backoffice.v_booking_finance as
select b.id, b.account_id, b.booking_no, b.status, b.payment_status, b.currency,
       b.lead_name, b.destination, b.depart_date, b.return_date,
       b.sell_total, b.cost_total, b.margin_total, b.paid_total, b.balance_due,
       (select count(*) from backoffice.booking_item i where i.booking_id = b.id) as item_count,
       b.trip_id, b.reservation_id, b.household_id, b.created_at
from backoffice.booking b;

-- AR: scheduled/pending customer money owed to us, by due date
create view backoffice.v_receipts_due as
select r.account_id, r.booking_id, b.booking_no, b.lead_name,
       r.kind, r.amount, r.currency, r.due_date, r.status
from backoffice.receipt r
join backoffice.booking b on b.id = r.booking_id
where r.status in ('scheduled','pending');

-- AP: outstanding supplier payables, by due date
create view backoffice.v_supplier_payables as
select sb.account_id, sb.supplier_id, s.name as supplier_name,
       sb.booking_id, sb.amount, sb.paid_total, sb.outstanding, sb.currency,
       sb.due_date, sb.status
from backoffice.supplier_bill sb
join backoffice.supplier s on s.id = sb.supplier_id
where sb.status not in ('paid','void');

grant select on backoffice.v_booking_finance  to service_role;
grant select on backoffice.v_receipts_due      to service_role;
grant select on backoffice.v_supplier_payables to service_role;
