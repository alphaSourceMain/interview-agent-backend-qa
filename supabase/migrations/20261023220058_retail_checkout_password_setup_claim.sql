begin;
set local lock_timeout = '10s';
-- Nullable marker on the existing service-only intake row. No backfill, new
-- grants, auth user, payment, agreement or membership mutation in this migration.
alter table public.public_purchase_intents
  add column password_setup_claimed_at timestamptz;
comment on column public.public_purchase_intents.password_setup_claimed_at is
  'One-time direct first-password issuance reservation. A claimed/unknown outcome never automatically retries; use emailed recovery.';
commit;
