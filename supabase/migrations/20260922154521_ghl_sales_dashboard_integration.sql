-- GHL CRM <-> alphaScreen sales close integration.
-- Every object is server-only. Browser callers must use authenticated Express
-- routes, and provider webhooks may only submit opaque identifiers that the
-- backend re-fetches from GHL before making a state transition.

create table if not exists public.ghl_sales_deal_bindings (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  contact_id text not null,
  opportunity_id text not null,
  pipeline_id text not null,
  ready_stage_id text not null,
  provider_owner_user_id text not null,
  sales_team_member_id uuid references public.sales_team_members(id) on delete restrict,
  sales_rep_user_id uuid references public.sales_reps(user_id) on delete restrict,
  purchase_intent_id uuid unique references public.public_purchase_intents(id) on delete restrict,
  status text not null default 'ready',
  company_name text,
  contact_first_name text,
  contact_last_name text,
  contact_email text,
  contact_phone text,
  contact_title text,
  opportunity_name text,
  opportunity_source text,
  provider_updated_at timestamptz,
  imported_at timestamptz not null default now(),
  linked_at timestamptz,
  won_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_detail text,
  manual_review_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ghl_sales_deal_bindings_provider_ids_check check (
    char_length(location_id) between 3 and 160
    and char_length(contact_id) between 3 and 160
    and char_length(opportunity_id) between 3 and 160
    and char_length(pipeline_id) between 3 and 160
    and char_length(ready_stage_id) between 3 and 160
    and char_length(provider_owner_user_id) between 3 and 160
  ),
  constraint ghl_sales_deal_bindings_status_check check (
    status in ('ready', 'linked', 'won_pending', 'won', 'exception', 'detached')
  ),
  constraint ghl_sales_deal_bindings_company_length check (company_name is null or char_length(company_name) <= 160),
  constraint ghl_sales_deal_bindings_contact_name_length check (
    (contact_first_name is null or char_length(contact_first_name) <= 80)
    and (contact_last_name is null or char_length(contact_last_name) <= 80)
  ),
  constraint ghl_sales_deal_bindings_contact_email_length check (contact_email is null or char_length(contact_email) <= 254),
  constraint ghl_sales_deal_bindings_contact_phone_length check (contact_phone is null or char_length(contact_phone) <= 40),
  constraint ghl_sales_deal_bindings_contact_title_length check (contact_title is null or char_length(contact_title) <= 120),
  constraint ghl_sales_deal_bindings_opportunity_length check (
    (opportunity_name is null or char_length(opportunity_name) <= 200)
    and (opportunity_source is null or char_length(opportunity_source) <= 120)
  ),
  constraint ghl_sales_deal_bindings_error_length check (
    (last_error_code is null or char_length(last_error_code) <= 80)
    and (last_error_detail is null or char_length(last_error_detail) <= 500)
  )
);

create unique index if not exists ghl_sales_deal_bindings_opportunity_uidx
  on public.ghl_sales_deal_bindings (location_id, opportunity_id);

create index if not exists ghl_sales_deal_bindings_rep_status_idx
  on public.ghl_sales_deal_bindings (sales_rep_user_id, status, imported_at desc);

create index if not exists ghl_sales_deal_bindings_contact_idx
  on public.ghl_sales_deal_bindings (location_id, contact_id, imported_at desc);

create table if not exists public.ghl_sales_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  body_sha256 text not null,
  location_id text,
  opportunity_id text,
  event_type text not null default 'ready_to_close',
  status text not null default 'processing',
  attempt_count integer not null default 1,
  binding_id uuid references public.ghl_sales_deal_bindings(id) on delete set null,
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  last_error_detail text,
  constraint ghl_sales_webhook_receipts_event_key_length check (char_length(event_key) between 8 and 255),
  constraint ghl_sales_webhook_receipts_digest_check check (body_sha256 ~ '^[a-f0-9]{64}$'),
  constraint ghl_sales_webhook_receipts_status_check check (status in ('processing', 'completed', 'failed')),
  constraint ghl_sales_webhook_receipts_attempt_check check (attempt_count between 1 and 100),
  constraint ghl_sales_webhook_receipts_error_length check (
    (last_error_code is null or char_length(last_error_code) <= 80)
    and (last_error_detail is null or char_length(last_error_detail) <= 500)
  )
);

create index if not exists ghl_sales_webhook_receipts_status_received_idx
  on public.ghl_sales_webhook_receipts (status, last_received_at desc);

create table if not exists public.ghl_sales_sync_events (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid references public.ghl_sales_deal_bindings(id) on delete restrict,
  purchase_intent_id uuid references public.public_purchase_intents(id) on delete restrict,
  direction text not null,
  event_type text not null,
  idempotency_key text not null unique,
  status text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  constraint ghl_sales_sync_events_direction_check check (direction in ('inbound', 'outbound', 'admin')),
  constraint ghl_sales_sync_events_status_check check (status in ('received', 'ignored', 'completed', 'failed', 'retrying', 'manual_review')),
  constraint ghl_sales_sync_events_type_length check (char_length(event_type) between 1 and 80),
  constraint ghl_sales_sync_events_idempotency_length check (char_length(idempotency_key) between 8 and 255),
  constraint ghl_sales_sync_events_metadata_object check (jsonb_typeof(safe_metadata) = 'object'),
  constraint ghl_sales_sync_events_error_length check (
    (error_code is null or char_length(error_code) <= 80)
    and (error_detail is null or char_length(error_detail) <= 500)
  )
);

create index if not exists ghl_sales_sync_events_binding_created_idx
  on public.ghl_sales_sync_events (binding_id, created_at desc);

alter table public.sales_integration_deliveries
  add column if not exists manual_review_required boolean not null default false;

alter table public.ghl_sales_deal_bindings enable row level security;
alter table public.ghl_sales_webhook_receipts enable row level security;
alter table public.ghl_sales_sync_events enable row level security;

revoke all on table public.ghl_sales_deal_bindings from public, anon, authenticated;
revoke all on table public.ghl_sales_webhook_receipts from public, anon, authenticated;
revoke all on table public.ghl_sales_sync_events from public, anon, authenticated;

grant select, insert, update on table public.ghl_sales_deal_bindings to service_role;
grant select, insert, update on table public.ghl_sales_webhook_receipts to service_role;
grant select, insert on table public.ghl_sales_sync_events to service_role;

create or replace function public.claim_ghl_sales_binding(
  p_binding_id uuid,
  p_purchase_intent_id uuid,
  p_sales_rep_user_id uuid,
  p_claimed_at timestamptz default now()
)
returns public.ghl_sales_deal_bindings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_binding public.ghl_sales_deal_bindings;
begin
  update public.ghl_sales_deal_bindings as binding
  set purchase_intent_id = p_purchase_intent_id,
      status = case when binding.status = 'won' then 'won' else 'linked' end,
      linked_at = coalesce(binding.linked_at, p_claimed_at),
      last_error_code = null,
      last_error_detail = null,
      manual_review_required = false,
      updated_at = p_claimed_at
  where binding.id = p_binding_id
    and binding.sales_rep_user_id = p_sales_rep_user_id
    and binding.status in ('ready', 'linked')
    and (binding.purchase_intent_id is null or binding.purchase_intent_id = p_purchase_intent_id)
  returning binding.* into v_binding;

  if v_binding.id is null then
    raise exception using errcode = 'P0001', message = 'ghl_sales_binding_not_claimable';
  end if;

  return v_binding;
end;
$$;

revoke all on function public.claim_ghl_sales_binding(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_ghl_sales_binding(uuid, uuid, uuid, timestamptz)
  to service_role;

create or replace function public.list_missing_ghl_sales_won_intents(
  p_limit integer default 100
)
returns table (id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select intent.id
  from public.public_purchase_intents as intent
  join public.ghl_sales_deal_bindings as binding
    on binding.purchase_intent_id = intent.id
   and binding.opportunity_id = intent.ghl_opportunity_id
   and binding.contact_id = intent.ghl_contact_id
   and binding.status in ('linked', 'won_pending', 'won')
   and binding.manual_review_required = false
  join public.membership_agreements as agreement
    on agreement.id = intent.agreement_id
   and agreement.status = 'signed'
   and agreement.checkout_status = 'paid'
   and agreement.checkout_paid_at is not null
  join public.clients as client
    on client.id = intent.client_id
   and client.billing_status = 'active'
   and coalesce(nullif(lower(btrim(client.subscription_status)), ''), 'active') in ('active', 'trialing')
  where intent.channel = 'sales_assisted'
    and intent.status = 'completed'
    and intent.activated_at is not null
    and intent.ghl_opportunity_id is not null
    and not exists (
      select 1
      from public.sales_integration_deliveries as delivery
      where delivery.purchase_intent_id = intent.id
        and delivery.integration = 'ghl'
        and delivery.event_type = 'sales_won'
    )
  order by intent.activated_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

revoke all on function public.list_missing_ghl_sales_won_intents(integer)
  from public, anon, authenticated;
grant execute on function public.list_missing_ghl_sales_won_intents(integer)
  to service_role;
