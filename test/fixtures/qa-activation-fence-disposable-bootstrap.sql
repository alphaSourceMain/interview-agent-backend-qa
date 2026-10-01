-- Synthetic-only PostgreSQL 17 fixture for the unapplied QA activation-fence draft.
-- Run in a disposable local database, never hosted QA or production.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.clients (
  id uuid primary key,
  name text not null,
  email text not null,
  client_admin_name text,
  plan_tier text,
  billing_interval text,
  billing_status text default 'inactive',
  subscription_status text,
  auto_renew boolean,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_term_end timestamptz,
  cancel_at_term_end boolean,
  cancel_effective_at timestamptz,
  contract_start_at timestamptz,
  contract_end_at timestamptz
);

create table public.membership_agreements (
  id uuid primary key,
  client_id uuid,
  status text not null default 'signed',
  is_current boolean not null default true,
  superseded_by_agreement_id uuid,
  checkout_status text,
  checkout_session_id text,
  checkout_paid_at timestamptz,
  client_legal_name text,
  admin_email text,
  primary_admin_name text,
  initial_term_start date,
  initial_renewal_date date,
  updated_at timestamptz default now()
);

create table public.public_purchase_intents (
  id uuid primary key,
  agreement_id uuid,
  client_id uuid,
  status text not null default 'checkout_pending',
  canceled_at timestamptz,
  activation_claim_key text,
  activation_claimed_at timestamptz,
  selected_plan_key text,
  selected_billing_cadence text,
  package_snapshot jsonb,
  first_role_prepay_selected boolean,
  first_role_prepay_credit_type text,
  first_role_normal_role_fee_cents integer,
  first_role_prepay_amount_cents integer,
  first_role_prepay_discount_percent integer,
  stripe_checkout_session_id text,
  company_legal_name text,
  buyer_email text,
  buyer_first_name text,
  buyer_last_name text,
  term_start_basis text,
  activated_at timestamptz,
  updated_at timestamptz default now()
);

create table public.client_plan_settings (
  client_id uuid primary key,
  plan_tier text,
  billing_interval text,
  platform_fee numeric,
  per_role_fee numeric,
  included_interviews_per_role integer,
  additional_interview_fee numeric,
  max_interview_minutes integer,
  updated_at timestamptz default now()
);

create table public.client_role_credits (
  id bigint generated always as identity primary key,
  billing_client_id uuid,
  source_client_id uuid,
  source_public_purchase_intent_id uuid,
  source_membership_agreement_id uuid,
  source_stripe_checkout_session_id text,
  credit_type text,
  membership_key text,
  normal_role_fee_cents integer,
  discounted_credit_amount_cents integer,
  discount_percent integer,
  status text,
  metadata jsonb
);
create unique index on public.client_role_credits (source_public_purchase_intent_id)
  where source_public_purchase_intent_id is not null;
create unique index on public.client_role_credits (source_stripe_checkout_session_id)
  where source_stripe_checkout_session_id is not null;

create table public.client_members (
  client_id uuid not null,
  user_id uuid not null,
  email text,
  name text,
  role text not null check (role in ('member','manager','admin','tester','owner','super_admin')),
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);

create table public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  event_at timestamptz,
  email text,
  sg_event_id text,
  category text,
  email_category text,
  custom_args jsonb,
  status text,
  attempt integer,
  subject text,
  raw_payload jsonb not null,
  is_problem boolean not null default false,
  is_time_sensitive boolean not null default false,
  response text
);
create unique index on public.email_delivery_events (sg_event_id)
  where sg_event_id is not null;

insert into public.public_purchase_intents (id, status)
select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'completed'
from generate_series(1, 24) as i;
