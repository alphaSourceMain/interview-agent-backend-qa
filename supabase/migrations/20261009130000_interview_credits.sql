-- Interview credits for the rollover billing model.
--
-- When a Pro client closes a role, whatever allowance the role did not use is
-- minted as a credit the client can spend on any other role until it expires.
--
-- A credit records only what it was minted with. What is left of it, and which
-- interviews were charged to it, is worked out at read time from the interviews
-- themselves, so there is no balance column to keep in step and no draw table.

create extension if not exists pgcrypto;

create table if not exists public.interview_credits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  source_role_id uuid not null,
  quantity integer not null,
  minted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interview_credits_quantity_check check (quantity > 0)
);

-- A closed role mints at most one live credit, so a repeated close is a no-op
-- rather than a second grant. A revoked credit does not block a later mint.
create unique index if not exists interview_credits_source_role_uidx
  on public.interview_credits (source_role_id)
  where revoked_at is null;

create index if not exists interview_credits_client_expires_at_idx
  on public.interview_credits (client_id, expires_at);

alter table public.interview_credits enable row level security;

revoke all privileges on table public.interview_credits
from public, anon, authenticated;

grant select, insert, update, delete on table public.interview_credits
to service_role;
