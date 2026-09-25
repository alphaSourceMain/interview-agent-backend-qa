-- The Enterprise interview pool.
--
-- An Enterprise client buys a block of interviews at signup. Every role under
-- that client, and under any of its child entities, draws from the same pool.
-- Once the pool is empty interviews continue and are metered at the client's
-- usage price — running out never stops anyone working.
--
-- No foreign key on client_id: public.clients is not created by any migration in
-- this repository, so there is nothing here to reference (deviation A of the
-- Billing 1 run).

create extension if not exists pgcrypto;

create table if not exists public.client_interview_pools (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  quantity_purchased integer not null,
  quantity_remaining integer not null default 0,
  unit_price_cents integer not null,
  discount_pct numeric(5,2) not null default 0,
  total_cents integer not null,
  stripe_checkout_session_id text null,
  stripe_payment_intent_id text null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  paid_at timestamptz null,
  constraint client_interview_pools_quantity_check check (quantity_purchased > 0),
  constraint client_interview_pools_remaining_check
    check (quantity_remaining >= 0 and quantity_remaining <= quantity_purchased),
  constraint client_interview_pools_unit_price_check check (unit_price_cents >= 0),
  constraint client_interview_pools_total_check check (total_cents >= 0),
  constraint client_interview_pools_discount_check check (discount_pct >= 0 and discount_pct <= 100),
  constraint client_interview_pools_status_check
    check (status in ('pending', 'paid', 'failed', 'voided', 'refunded'))
);

create index if not exists client_interview_pools_client_id_idx
  on public.client_interview_pools (client_id);

-- One row per interview drawn, so a redelivered event or a late transcript
-- cannot spend the same interview twice. The unique interview_id is what
-- enforces that, not application logic.
create table if not exists public.client_interview_pool_draws (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.client_interview_pools(id) on delete cascade,
  client_id uuid not null,
  role_id uuid not null,
  interview_id uuid not null unique,
  drawn_at timestamptz not null default now()
);

create index if not exists client_interview_pool_draws_pool_id_idx
  on public.client_interview_pool_draws (pool_id);

create index if not exists client_interview_pool_draws_role_id_idx
  on public.client_interview_pool_draws (role_id);

alter table public.client_interview_pools enable row level security;
alter table public.client_interview_pool_draws enable row level security;

revoke all privileges on table public.client_interview_pools
from public, anon, authenticated;

revoke all privileges on table public.client_interview_pool_draws
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.client_interview_pools,
  public.client_interview_pool_draws
to service_role;
