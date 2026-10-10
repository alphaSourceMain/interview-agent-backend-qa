-- Disposable PostgreSQL fixture for the sales activation recovery migration.
-- Deliberately small: the function is also reviewed against hosted QA schema.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create table public.clients (
  id uuid primary key,
  name text,
  email text not null,
  client_admin_name text,
  plan_tier text,
  billing_interval text,
  billing_status text not null default 'inactive',
  subscription_status text,
  auto_renew boolean
);

create table public.public_purchase_intents (
  id uuid primary key,
  agreement_id uuid,
  created_by_user_id uuid,
  channel text not null default 'sales_assisted',
  status text not null default 'checkout_pending',
  canceled_at timestamptz,
  activated_at timestamptz,
  activation_claimed_at timestamptz,
  activation_claim_key text,
  client_id uuid,
  company_legal_name text not null default 'QA Company',
  buyer_email text not null default 'qa@example.invalid',
  buyer_first_name text not null default 'QA',
  buyer_last_name text not null default 'Buyer',
  term_start_basis text not null default 'successful_payment',
  stripe_checkout_session_id text,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.membership_agreements (
  id uuid primary key,
  client_id uuid,
  status text not null default 'signed',
  superseded_by_agreement_id uuid,
  superseded_at timestamptz,
  is_current boolean not null default true,
  checkout_status text,
  checkout_paid_at timestamptz,
  checkout_session_id text,
  client_legal_name text not null default 'QA Company',
  admin_email text not null default 'qa@example.invalid',
  primary_admin_name text not null default 'QA Buyer',
  initial_term_start date,
  initial_renewal_date date,
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);
