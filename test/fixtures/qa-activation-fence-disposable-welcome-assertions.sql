-- Synthetic-only, disposable PostgreSQL welcome ledger assertions.
\set ON_ERROR_STOP on

do $$
declare v_result jsonb; v_token uuid;
begin
  v_result := public.reserve_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim');
  if v_result->>'status' <> 'reserved' then
    raise exception 'welcome_reserve_failed: %', v_result;
  end if;
  if (select count(*) from public.email_delivery_events) <> 1 then
    raise exception 'welcome_reserve_count_failed';
  end if;
  v_result := public.begin_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim');
  if v_result->>'status' <> 'sending' or v_result->>'send_token' is null then
    raise exception 'welcome_begin_failed: %', v_result;
  end if;
  v_token := (v_result->>'send_token')::uuid;
  v_result := public.reserve_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim');
  if v_result->>'status' <> 'sending' then
    raise exception 'ambiguous_welcome_retried: %', v_result;
  end if;
  v_result := public.finish_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', v_token, 'sent', 'status:202');
  if v_result->>'status' <> 'sent' then
    raise exception 'welcome_finish_failed: %', v_result;
  end if;
  v_result := public.reserve_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim');
  if v_result->>'status' <> 'sent' or (select attempt from public.email_delivery_events) <> 1 then
    raise exception 'sent_welcome_retried: %', v_result;
  end if;
  if has_function_privilege('anon', 'public.begin_public_purchase_welcome(uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.reserve_public_purchase_welcome(uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.finish_public_purchase_welcome(uuid,uuid,text,text)', 'EXECUTE') then
    raise exception 'welcome_rpc_acl_failed';
  end if;
end;
$$;

begin;
update public.public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '6 minutes'
where id='30000000-0000-4000-8000-000000000001';
do $$
declare v_result jsonb;
begin
  v_result := public.reserve_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim');
  if v_result->>'status' <> 'activation_fence_lost' then
    raise exception 'stale_welcome_owner_passed: %', v_result;
  end if;
end;
$$;
rollback;

begin;
update public.email_delivery_events set status='sending';
do $$
declare v_result jsonb;
begin
  v_result := private_sales.reconcile_public_purchase_welcome(
    '30000000-0000-4000-8000-000000000001',
    'qa-operator', 'Provider accepted synthetic message', 'sent');
  if v_result->>'status' <> 'sent'
    or (select welcome_reconciled_by from public.email_delivery_events) <> 'qa-operator' then
    raise exception 'welcome_manual_reconcile_failed: %', v_result;
  end if;
end;
$$;
rollback;

do $$
begin
  if has_function_privilege('service_role',
    'private_sales.reconcile_public_purchase_welcome(uuid,text,text,text)', 'EXECUTE')
    or has_function_privilege('anon',
      'private_sales.reconcile_public_purchase_welcome(uuid,text,text,text)', 'EXECUTE') then
    raise exception 'operator_reconciliation_exposed_to_api';
  end if;
end;
$$;
