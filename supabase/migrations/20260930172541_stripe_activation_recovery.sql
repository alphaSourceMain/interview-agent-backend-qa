-- QA candidate: recover a crashed Stripe activation without allowing a stale
-- worker to mark a canceled or superseded agreement paid. All functions are
-- service-role only; the application supplies a fresh random fence per attempt.

create or replace function public.claim_public_purchase_activation(
  p_agreement_id uuid,
  p_claim_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_claim_key is null or length(p_claim_key) < 32 then
    raise exception using errcode = '22023', message = 'invalid_activation_fence';
  end if;

  select * into v_intent
  from public.public_purchase_intents
  where agreement_id = p_agreement_id
  for update;
  if not found then
    select * into v_agreement
    from public.membership_agreements
    where id = p_agreement_id
    for update;
    if found and (v_agreement.superseded_by_agreement_id is not null
      or v_agreement.status in ('superseded', 'voided')) then
      return jsonb_build_object('status', 'agreement_superseded');
    end if;
    return jsonb_build_object('status', 'purchase_intent_missing');
  end if;

  select * into v_agreement
  from public.membership_agreements
  where id = p_agreement_id
  for update;
  if not found or v_agreement.superseded_by_agreement_id is not null
    or v_agreement.status in ('superseded', 'voided') then
    return jsonb_build_object('status', 'agreement_superseded', 'intent_id', v_intent.id);
  end if;
  if v_intent.status = 'canceled' or v_intent.canceled_at is not null then
    return jsonb_build_object('status', 'purchase_canceled', 'intent_id', v_intent.id);
  end if;
  if v_intent.activation_claimed_at is not null
    and v_intent.activation_claimed_at >= v_now - interval '5 minutes' then
    return jsonb_build_object('status', 'activation_in_progress', 'intent_id', v_intent.id);
  end if;

  update public.public_purchase_intents
  set activation_claimed_at = v_now,
      activation_claim_key = p_claim_key,
      updated_at = v_now
  where id = v_intent.id;
  return jsonb_build_object('status', 'claimed', 'intent_id', v_intent.id);
end;
$$;

create or replace function public.heartbeat_public_purchase_activation(
  p_intent_id uuid,
  p_claim_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.public_purchase_intents
  set activation_claimed_at = clock_timestamp()
  where id = p_intent_id
    and activation_claim_key = p_claim_key
    and activation_claimed_at is not null
    and status <> 'canceled'
    and canceled_at is null;
  return found;
end;
$$;

create or replace function public.release_public_purchase_activation(
  p_intent_id uuid,
  p_claim_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.public_purchase_intents
  set activation_claimed_at = null,
      activation_claim_key = null,
      updated_at = clock_timestamp()
  where id = p_intent_id
    and activation_claim_key = p_claim_key;
  return found;
end;
$$;

-- Cancellation and replacement compete with claim/reclaim on the same intent
-- row. A stale lease can be cleared only by whichever transaction wins the row.
create or replace function public.cancel_sales_assisted_purchase(
  p_intent_id uuid,
  p_agreement_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement_updated integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  update public.public_purchase_intents
  set status = 'canceled',
      canceled_at = v_now,
      activation_claimed_at = null,
      activation_claim_key = null,
      updated_at = v_now
  where id = p_intent_id
    and created_by_user_id = p_user_id
    and channel = 'sales_assisted'
    and agreement_id is not distinct from p_agreement_id
    and status not in ('completed', 'canceled')
    and activated_at is null
    and (activation_claimed_at is null
      or activation_claimed_at < v_now - interval '5 minutes')
  returning * into v_intent;
  if not found then
    return jsonb_build_object('status', 'refused');
  end if;

  if p_agreement_id is not null then
    update public.membership_agreements
    set status = 'voided',
        is_current = false,
        updated_at = v_now
    where id = p_agreement_id
      and coalesce(checkout_status, '') <> 'paid'
      and superseded_by_agreement_id is null;
    get diagnostics v_agreement_updated = row_count;
    if v_agreement_updated <> 1 then
      raise exception using errcode = 'P0001', message = 'sales_agreement_not_cancelable';
    end if;
  end if;
  return jsonb_build_object('status', 'canceled', 'intent', to_jsonb(v_intent));
end;
$$;

create or replace function public.replace_sales_assisted_agreement(
  p_intent_id uuid,
  p_old_agreement_id uuid,
  p_new_agreement_id uuid,
  p_new_expires_at timestamptz,
  p_replaced_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent_updated integer := 0;
  v_agreement_updated integer := 0;
begin
  update public.public_purchase_intents
  set agreement_id = p_new_agreement_id,
      status = 'agreement_pending',
      expires_at = p_new_expires_at,
      stripe_checkout_session_id = null,
      term_start_basis = 'agreement_date',
      activation_claimed_at = null,
      activation_claim_key = null,
      updated_at = p_replaced_at
  where id = p_intent_id
    and channel = 'sales_assisted'
    and agreement_id = p_old_agreement_id
    and status <> 'completed'
    and activated_at is null
    and (activation_claimed_at is null
      or activation_claimed_at < clock_timestamp() - interval '5 minutes');
  get diagnostics v_intent_updated = row_count;
  if v_intent_updated <> 1 then return false; end if;

  update public.membership_agreements
  set status = 'superseded',
      is_current = false,
      superseded_at = p_replaced_at,
      superseded_by_agreement_id = p_new_agreement_id,
      updated_at = p_replaced_at
  where id = p_old_agreement_id
    and status in ('sent', 'signed')
    and coalesce(checkout_status, '') <> 'paid';
  get diagnostics v_agreement_updated = row_count;
  if v_agreement_updated <> 1 then
    raise exception using errcode = 'P0001', message = 'sales_agreement_not_replaceable';
  end if;

  update public.membership_agreements
  set status = 'sent', sent_at = p_replaced_at, updated_at = p_replaced_at
  where id = p_new_agreement_id and status = 'draft';
  if not found then
    raise exception using errcode = 'P0001', message = 'sales_replacement_not_ready';
  end if;
  return true;
end;
$$;

create or replace function public.complete_public_purchase_activation(
  p_agreement_id uuid,
  p_claim_key text,
  p_paid_at timestamptz,
  p_checkout_session_id text,
  p_client_id uuid,
  p_create_client boolean,
  p_plan_key text,
  p_billing_interval text,
  p_term_start date,
  p_renewal_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.public_purchase_intents%rowtype;
  v_agreement public.membership_agreements%rowtype;
  v_client_id uuid;
  v_client_email text;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_intent
  from public.public_purchase_intents
  where agreement_id = p_agreement_id
  for update;
  if not found then
    return jsonb_build_object('status', 'no_intent');
  end if;
  select * into v_agreement
  from public.membership_agreements
  where id = p_agreement_id
  for update;
  if not found or v_agreement.superseded_by_agreement_id is not null
    or v_agreement.status in ('superseded', 'voided') then
    return jsonb_build_object('status', 'agreement_superseded');
  end if;
  if v_intent.status = 'canceled' or v_intent.canceled_at is not null then
    return jsonb_build_object('status', 'purchase_canceled');
  end if;
  if v_intent.activation_claim_key is distinct from p_claim_key
    or v_intent.activation_claimed_at is null then
    return jsonb_build_object('status', 'activation_fence_lost');
  end if;
  if p_paid_at is null or p_client_id is null or p_plan_key not in ('basic', 'pro')
    or p_billing_interval not in ('monthly', 'annual') then
    raise exception using errcode = '22023', message = 'invalid_activation_input';
  end if;

  if v_agreement.client_id is not null and v_intent.client_id is not null
    and v_agreement.client_id <> v_intent.client_id then
    raise exception using errcode = 'P0001', message = 'activation_client_mismatch';
  end if;
  v_client_id := coalesce(v_agreement.client_id, v_intent.client_id, p_client_id);
  if p_create_client and v_client_id = p_client_id then
    insert into public.clients (
      id, name, email, client_admin_name, plan_tier, billing_interval,
      billing_status, subscription_status, auto_renew
    ) values (
      v_client_id,
      coalesce(nullif(trim(v_intent.company_legal_name), ''),
        nullif(trim(v_agreement.client_legal_name), ''), 'alphaScreen client'),
      lower(coalesce(nullif(trim(v_intent.buyer_email), ''), trim(v_agreement.admin_email))),
      coalesce(nullif(trim(v_intent.buyer_first_name || ' ' || v_intent.buyer_last_name), ''),
        nullif(trim(v_agreement.primary_admin_name), '')),
      p_plan_key, p_billing_interval, 'inactive', 'incomplete', false
    ) on conflict (id) do nothing;
  end if;
  select email into v_client_email from public.clients where id = v_client_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'activation_client_missing';
  end if;
  if p_create_client and v_client_id = p_client_id
    and lower(v_client_email) <> lower(coalesce(nullif(trim(v_intent.buyer_email), ''), trim(v_agreement.admin_email))) then
    raise exception using errcode = 'P0001', message = 'activation_client_conflict';
  end if;

  update public.membership_agreements
  set client_id = v_client_id,
      checkout_status = 'paid',
      checkout_paid_at = coalesce(checkout_paid_at, p_paid_at),
      checkout_session_id = coalesce(checkout_session_id, nullif(p_checkout_session_id, '')),
      initial_term_start = case
        when checkout_paid_at is null and v_intent.term_start_basis = 'successful_payment'
        then p_term_start else initial_term_start end,
      initial_renewal_date = case
        when checkout_paid_at is null and v_intent.term_start_basis = 'successful_payment'
        then p_renewal_date else initial_renewal_date end,
      updated_at = v_now
  where id = p_agreement_id;

  update public.public_purchase_intents
  set client_id = v_client_id,
      status = 'completed',
      activated_at = coalesce(activated_at, v_agreement.checkout_paid_at, p_paid_at),
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, nullif(p_checkout_session_id, '')),
      updated_at = v_now
  where id = v_intent.id and activation_claim_key = p_claim_key;
  if not found then
    raise exception using errcode = 'P0001', message = 'activation_fence_lost';
  end if;
  return jsonb_build_object('status', 'completed', 'client_id', v_client_id,
    'paid_at', coalesce(v_agreement.checkout_paid_at, p_paid_at));
end;
$$;

revoke all on function public.claim_public_purchase_activation(uuid, text) from public, anon, authenticated;
revoke all on function public.heartbeat_public_purchase_activation(uuid, text) from public, anon, authenticated;
revoke all on function public.release_public_purchase_activation(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_sales_assisted_purchase(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_public_purchase_activation(uuid, text, timestamptz, text, uuid, boolean, text, text, date, date) from public, anon, authenticated;
grant execute on function public.claim_public_purchase_activation(uuid, text) to service_role;
grant execute on function public.heartbeat_public_purchase_activation(uuid, text) to service_role;
grant execute on function public.release_public_purchase_activation(uuid, text) to service_role;
grant execute on function public.cancel_sales_assisted_purchase(uuid, uuid, uuid) to service_role;
grant execute on function public.replace_sales_assisted_agreement(uuid, uuid, uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.complete_public_purchase_activation(uuid, text, timestamptz, text, uuid, boolean, text, text, date, date) to service_role;
