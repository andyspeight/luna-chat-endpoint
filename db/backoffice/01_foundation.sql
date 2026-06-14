-- Back office: the unifying single-source-of-truth layer.
-- New isolated schema. Tenant = contracts.account. Links out to CRM (public.trips/households/contacts)
-- and to the engine (contracts.reservation). Security model matches the contracts schema:
-- RLS enabled, no policies, access via service_role only (deny-by-default defense in depth).

create schema if not exists backoffice;
grant usage on schema backoffice to service_role;

-- ---------- enums ----------
create type backoffice.booking_status as enum ('quote','confirmed','cancelled','completed');
create type backoffice.payment_state  as enum ('unpaid','partial','paid','refunded');
create type backoffice.item_type      as enum ('accommodation','car','flight','transfer','ticket','insurance','fee','package','other');
create type backoffice.item_status    as enum ('quote','confirmed','cancelled');
create type backoffice.supplier_kind  as enum ('bedbank','tour_operator','dmc','airline','attraction','transfer','car_hire','insurer','internal_contract','other');

-- ---------- helpers ----------
create or replace function backoffice.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

-- gapless per-account numbering (booking refs, invoice nos)
create table backoffice.number_sequence (
  account_id uuid not null references contracts.account(id) on delete cascade,
  kind       text not null,
  prefix     text not null default '',
  next_val   bigint not null default 1,
  pad        int  not null default 5,
  primary key (account_id, kind)
);
alter table backoffice.number_sequence enable row level security;
grant all on backoffice.number_sequence to service_role;

create or replace function backoffice.next_number(p_account uuid, p_kind text)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_prefix text; v_val bigint; v_pad int;
begin
  insert into backoffice.number_sequence(account_id, kind) values (p_account, p_kind)
    on conflict (account_id, kind) do nothing;
  update backoffice.number_sequence
     set next_val = next_val + 1
   where account_id = p_account and kind = p_kind
   returning prefix, next_val - 1, pad into v_prefix, v_val, v_pad;
  return v_prefix || lpad(v_val::text, v_pad, '0');
end; $$;

-- ---------- supplier master ----------
-- Canonical supplier. account_id NULL = shared/global trade supplier (e.g. the Airtable bedbanks).
create table backoffice.supplier (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid references contracts.account(id) on delete cascade,
  name           text not null,
  kind           backoffice.supplier_kind not null default 'other',
  default_currency char(3) not null default 'GBP',
  payment_terms  text,
  commission_basis text,
  finance_email  text,
  finance_phone  text,
  account_ref    text,
  bonded         boolean not null default false,
  atol           text,
  is_api_supplier boolean not null default false,
  active         boolean not null default true,
  airtable_supplier_id text,
  external_refs  jsonb not null default '{}'::jsonb,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index supplier_acct_name_idx
  on backoffice.supplier (coalesce(account_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index supplier_account_idx on backoffice.supplier(account_id);
create trigger supplier_touch before update on backoffice.supplier
  for each row execute function backoffice.touch_updated_at();
alter table backoffice.supplier enable row level security;
grant all on backoffice.supplier to service_role;

-- ---------- booking (the canonical order) ----------
create table backoffice.booking (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references contracts.account(id) on delete cascade,
  booking_no     text,
  status         backoffice.booking_status not null default 'quote',
  payment_status backoffice.payment_state  not null default 'unpaid',
  currency       char(3) not null default 'GBP',
  lead_name      text,
  lead_email     text,
  lead_phone     text,
  household_id   uuid references public.households(id) on delete set null,
  lead_contact_id uuid references public.contacts(id) on delete set null,
  trip_id        uuid references public.trips(id) on delete set null,
  reservation_id uuid references contracts.reservation(id) on delete set null,
  destination    text,
  depart_date    date,
  return_date    date,
  sell_total     numeric(14,2) not null default 0,
  cost_total     numeric(14,2) not null default 0,
  margin_total   numeric(14,2) generated always as (sell_total - cost_total) stored,
  paid_total     numeric(14,2) not null default 0,
  balance_due    numeric(14,2) generated always as (sell_total - paid_total) stored,
  source         text not null default 'manual',
  external_ref   text,
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index booking_idem_idx on backoffice.booking(account_id, source, external_ref) where external_ref is not null;
create index booking_account_idx     on backoffice.booking(account_id);
create index booking_trip_idx        on backoffice.booking(trip_id);
create index booking_reservation_idx on backoffice.booking(reservation_id);
create index booking_household_idx   on backoffice.booking(household_id);

create or replace function backoffice.assign_booking_no()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.booking_no is null then
    new.booking_no := backoffice.next_number(new.account_id, 'booking');
  end if;
  return new;
end; $$;
create trigger booking_no_assign before insert on backoffice.booking
  for each row execute function backoffice.assign_booking_no();
create trigger booking_touch before update on backoffice.booking
  for each row execute function backoffice.touch_updated_at();
alter table backoffice.booking enable row level security;
grant all on backoffice.booking to service_role;

-- ---------- booking_item (component lines) ----------
create table backoffice.booking_item (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references backoffice.booking(id) on delete cascade,
  account_id     uuid not null references contracts.account(id) on delete cascade,
  item_type      backoffice.item_type not null,
  status         backoffice.item_status not null default 'quote',
  supplier_id    uuid references backoffice.supplier(id) on delete set null,
  title          text not null,
  sell_amount    numeric(14,2) not null default 0,
  cost_amount    numeric(14,2) not null default 0,
  tax_amount     numeric(14,2) not null default 0,
  margin         numeric(14,2) generated always as (sell_amount - cost_amount) stored,
  currency       char(3) not null default 'GBP',
  start_date     date,
  end_date       date,
  confirmation_ref text,
  supplier_due_date date,
  source_schema  text,
  source_table   text,
  source_id      uuid,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index booking_item_booking_idx  on backoffice.booking_item(booking_id);
create index booking_item_supplier_idx on backoffice.booking_item(supplier_id);
create unique index booking_item_source_idx
  on backoffice.booking_item(source_schema, source_table, source_id) where source_id is not null;
create trigger booking_item_touch before update on backoffice.booking_item
  for each row execute function backoffice.touch_updated_at();

create or replace function backoffice.recompute_booking_totals(p_booking uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update backoffice.booking b set
    sell_total = coalesce((select sum(i.sell_amount) from backoffice.booking_item i
                           where i.booking_id = b.id and i.status <> 'cancelled'),0),
    cost_total = coalesce((select sum(i.cost_amount) from backoffice.booking_item i
                           where i.booking_id = b.id and i.status <> 'cancelled'),0)
  where b.id = p_booking;
end; $$;

create or replace function backoffice.booking_item_aiud()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform backoffice.recompute_booking_totals(old.booking_id);
    return old;
  end if;
  perform backoffice.recompute_booking_totals(new.booking_id);
  if tg_op = 'UPDATE' and new.booking_id <> old.booking_id then
    perform backoffice.recompute_booking_totals(old.booking_id);
  end if;
  return new;
end; $$;
create trigger booking_item_totals after insert or update or delete on backoffice.booking_item
  for each row execute function backoffice.booking_item_aiud();

alter table backoffice.booking_item enable row level security;
grant all on backoffice.booking_item to service_role;

grant execute on function backoffice.next_number(uuid,text) to service_role;
grant execute on function backoffice.recompute_booking_totals(uuid) to service_role;
