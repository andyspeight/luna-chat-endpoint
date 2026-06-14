-- Back office money layer: AR (customer receipts + invoices) and AP (supplier bills + payments).

-- ---------- enums ----------
create type backoffice.receipt_kind   as enum ('deposit','balance','full','additional','refund','adjustment');
create type backoffice.receipt_status as enum ('scheduled','pending','cleared','failed','refunded','void');
create type backoffice.money_method   as enum ('card','bank_transfer','cash','cheque','offset','other');
create type backoffice.invoice_status as enum ('draft','issued','part_paid','paid','cancelled','refunded');
create type backoffice.bill_status    as enum ('draft','due','part_paid','paid','disputed','void');
create type backoffice.supplier_payment_status as enum ('scheduled','pending','paid','failed','void');

-- ---------- invoices (customer-facing) ----------
create table backoffice.invoice (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references contracts.account(id) on delete cascade,
  booking_id  uuid not null references backoffice.booking(id) on delete cascade,
  invoice_no  text,
  status      backoffice.invoice_status not null default 'draft',
  currency    char(3) not null default 'GBP',
  issued_at   date,
  due_at      date,
  subtotal    numeric(14,2) not null default 0,
  tax         numeric(14,2) not null default 0,
  total       numeric(14,2) not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index invoice_booking_idx on backoffice.invoice(booking_id);
create index invoice_account_idx on backoffice.invoice(account_id);

-- assign a gapless invoice_no the moment an invoice leaves draft
create or replace function backoffice.assign_invoice_no()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.invoice_no is null and new.status <> 'draft' then
    new.invoice_no := backoffice.next_number(new.account_id, 'invoice');
  end if;
  return new;
end; $$;
create trigger invoice_no_assign before insert or update on backoffice.invoice
  for each row execute function backoffice.assign_invoice_no();
create trigger invoice_touch before update on backoffice.invoice
  for each row execute function backoffice.touch_updated_at();
alter table backoffice.invoice enable row level security;
grant all on backoffice.invoice to service_role;

create table backoffice.invoice_line (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references backoffice.invoice(id) on delete cascade,
  booking_item_id uuid references backoffice.booking_item(id) on delete set null,
  description     text not null,
  amount          numeric(14,2) not null default 0,
  tax             numeric(14,2) not null default 0,
  sort_order      int not null default 0
);
create index invoice_line_invoice_idx on backoffice.invoice_line(invoice_id);
alter table backoffice.invoice_line enable row level security;
grant all on backoffice.invoice_line to service_role;

-- ---------- receipts (customer money IN) ----------
create table backoffice.receipt (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references contracts.account(id) on delete cascade,
  booking_id   uuid not null references backoffice.booking(id) on delete cascade,
  invoice_id   uuid references backoffice.invoice(id) on delete set null,
  kind         backoffice.receipt_kind not null default 'balance',
  amount       numeric(14,2) not null check (amount >= 0),
  currency     char(3) not null default 'GBP',
  method       backoffice.money_method,
  status       backoffice.receipt_status not null default 'scheduled',
  due_date     date,
  received_at  timestamptz,
  reference    text,
  gateway_meta jsonb not null default '{}'::jsonb,
  notes        text,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index receipt_booking_idx on backoffice.receipt(booking_id);
create index receipt_account_due_idx on backoffice.receipt(account_id, due_date);
create trigger receipt_touch before update on backoffice.receipt
  for each row execute function backoffice.touch_updated_at();

-- recompute booking.paid_total + payment_status from cleared receipts (refunds count negative)
create or replace function backoffice.recompute_booking_payment(p_booking uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_paid numeric(14,2); v_sell numeric(14,2);
begin
  select coalesce(sum(case when r.kind = 'refund' then -r.amount else r.amount end),0)
    into v_paid
  from backoffice.receipt r
  where r.booking_id = p_booking and r.status = 'cleared';

  update backoffice.booking b set
    paid_total = v_paid,
    payment_status = case
      when v_paid <= 0 then 'unpaid'::backoffice.payment_state
      when b.sell_total > 0 and v_paid >= b.sell_total then 'paid'::backoffice.payment_state
      else 'partial'::backoffice.payment_state end
  where b.id = p_booking
  returning b.sell_total into v_sell;
end; $$;

create or replace function backoffice.receipt_aiud()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform backoffice.recompute_booking_payment(old.booking_id);
    return old;
  end if;
  perform backoffice.recompute_booking_payment(new.booking_id);
  if tg_op = 'UPDATE' and new.booking_id <> old.booking_id then
    perform backoffice.recompute_booking_payment(old.booking_id);
  end if;
  return new;
end; $$;
create trigger receipt_totals after insert or update or delete on backoffice.receipt
  for each row execute function backoffice.receipt_aiud();
alter table backoffice.receipt enable row level security;
grant all on backoffice.receipt to service_role;

-- ---------- supplier bills (AP - what we owe) ----------
create table backoffice.supplier_bill (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references contracts.account(id) on delete cascade,
  booking_id      uuid references backoffice.booking(id) on delete set null,
  booking_item_id uuid references backoffice.booking_item(id) on delete set null,
  supplier_id     uuid not null references backoffice.supplier(id),
  amount          numeric(14,2) not null check (amount >= 0),
  currency        char(3) not null default 'GBP',
  due_date        date,
  status          backoffice.bill_status not null default 'due',
  reference       text,
  paid_total      numeric(14,2) not null default 0,
  outstanding     numeric(14,2) generated always as (amount - paid_total) stored,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index supplier_bill_supplier_idx on backoffice.supplier_bill(supplier_id);
create index supplier_bill_booking_idx  on backoffice.supplier_bill(booking_id);
create index supplier_bill_due_idx      on backoffice.supplier_bill(account_id, due_date);
create trigger supplier_bill_touch before update on backoffice.supplier_bill
  for each row execute function backoffice.touch_updated_at();
alter table backoffice.supplier_bill enable row level security;
grant all on backoffice.supplier_bill to service_role;

-- ---------- supplier payments (money OUT) ----------
create table backoffice.supplier_payment (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references contracts.account(id) on delete cascade,
  supplier_id uuid not null references backoffice.supplier(id),
  bill_id     uuid references backoffice.supplier_bill(id) on delete set null,
  amount      numeric(14,2) not null check (amount >= 0),
  currency    char(3) not null default 'GBP',
  method      backoffice.money_method,
  status      backoffice.supplier_payment_status not null default 'scheduled',
  paid_at     timestamptz,
  reference   text,
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index supplier_payment_supplier_idx on backoffice.supplier_payment(supplier_id);
create index supplier_payment_bill_idx     on backoffice.supplier_payment(bill_id);
create trigger supplier_payment_touch before update on backoffice.supplier_payment
  for each row execute function backoffice.touch_updated_at();

-- recompute a bill's paid_total + status from its 'paid' payments
create or replace function backoffice.recompute_bill(p_bill uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_paid numeric(14,2); v_amount numeric(14,2);
begin
  if p_bill is null then return; end if;
  select coalesce(sum(sp.amount),0) into v_paid
  from backoffice.supplier_payment sp
  where sp.bill_id = p_bill and sp.status = 'paid';

  update backoffice.supplier_bill b set
    paid_total = v_paid,
    status = case
      when b.status in ('draft','disputed','void') then b.status
      when v_paid <= 0 then 'due'::backoffice.bill_status
      when v_paid >= b.amount then 'paid'::backoffice.bill_status
      else 'part_paid'::backoffice.bill_status end
  where b.id = p_bill
  returning b.amount into v_amount;
end; $$;

create or replace function backoffice.supplier_payment_aiud()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform backoffice.recompute_bill(old.bill_id);
    return old;
  end if;
  perform backoffice.recompute_bill(new.bill_id);
  if tg_op = 'UPDATE' and new.bill_id is distinct from old.bill_id then
    perform backoffice.recompute_bill(old.bill_id);
  end if;
  return new;
end; $$;
create trigger supplier_payment_totals after insert or update or delete on backoffice.supplier_payment
  for each row execute function backoffice.supplier_payment_aiud();
alter table backoffice.supplier_payment enable row level security;
grant all on backoffice.supplier_payment to service_role;

grant execute on function backoffice.recompute_booking_payment(uuid) to service_role;
grant execute on function backoffice.recompute_bill(uuid) to service_role;
