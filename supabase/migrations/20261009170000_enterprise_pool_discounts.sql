-- Volume discount thresholds for the Enterprise interview pool.
--
-- An Enterprise client buys a pool of interviews at signup. The larger the pool,
-- the larger the discount off the client's per-interview price. Thresholds live
-- in a table rather than in code so they can be changed without a deploy.
--
-- The rule the pricing service applies: the highest min_quantity less than or
-- equal to the purchased quantity wins. A quantity below the lowest threshold
-- gets no discount, and so does an empty table.

create extension if not exists pgcrypto;

create table if not exists public.enterprise_pool_discounts (
  id uuid primary key default gen_random_uuid(),
  min_quantity integer not null unique,
  discount_pct numeric(5,2) not null,
  created_at timestamptz not null default now(),
  constraint enterprise_pool_discounts_min_quantity_check check (min_quantity > 0),
  constraint enterprise_pool_discounts_discount_pct_check check (discount_pct >= 0 and discount_pct <= 100)
);

-- Seeded thresholds. on conflict so a re-run neither duplicates a row nor
-- overwrites a percentage someone has since changed by hand.
insert into public.enterprise_pool_discounts (min_quantity, discount_pct)
values (20, 0), (30, 5), (50, 10)
on conflict (min_quantity) do nothing;

alter table public.enterprise_pool_discounts enable row level security;

revoke all privileges on table public.enterprise_pool_discounts
from public, anon, authenticated;

grant select, insert, update, delete on table public.enterprise_pool_discounts
to service_role;
