-- Synthetic-only member identity/role checks for the local QA draft.
\set ON_ERROR_STOP on

do $$
declare v_result jsonb;
begin
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'status' <> 'created' or v_result->>'role' <> 'manager' then
    raise exception 'member_create_failed: %', v_result;
  end if;
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'status' <> 'existing' then
    raise exception 'member_idempotency_failed: %', v_result;
  end if;
  if (select count(*) from public.client_members) <> 1 then
    raise exception 'member_duplicate_inserted';
  end if;
  if has_function_privilege('anon', 'public.ensure_public_purchase_buyer_member(uuid,text,uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.ensure_public_purchase_buyer_member(uuid,text,uuid,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.ensure_public_purchase_buyer_member(uuid,text,uuid,text)', 'EXECUTE') then
    raise exception 'member_rpc_acl_failed';
  end if;
end;
$$;

update public.client_members set role='tester';
do $$
declare v_result jsonb;
begin
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'role' <> 'tester'
    or (select role from public.client_members) <> 'tester' then
    raise exception 'member_role_escalated: %', v_result;
  end if;
end;
$$;

begin;
insert into public.client_members (client_id,user_id,email,role)
values ('10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002', 'buyer@example.invalid', 'member');
do $$
declare v_result jsonb;
begin
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'status' <> 'member_identity_conflict' then
    raise exception 'duplicate_email_was_adopted: %', v_result;
  end if;
end;
$$;
rollback;

begin;
update public.public_purchase_intents set protocol='legacy_complete'
where id='30000000-0000-4000-8000-000000000001';
do $$
declare v_result jsonb;
begin
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'status' <> 'purchase_tail_manual_review' then
    raise exception 'legacy_member_rpc_was_allowed: %', v_result;
  end if;
end;
$$;
rollback;

begin;
update public.public_purchase_intents
set activation_claimed_at=clock_timestamp()-interval '6 minutes'
where id='30000000-0000-4000-8000-000000000001';
do $$
declare v_result jsonb;
begin
  v_result := public.ensure_public_purchase_buyer_member(
    '30000000-0000-4000-8000-000000000001', 'synthetic-claim',
    '40000000-0000-4000-8000-000000000001', 'Synthetic Buyer'
  );
  if v_result->>'status' <> 'activation_fence_lost' then
    raise exception 'stale_member_owner_wrote: %', v_result;
  end if;
end;
$$;
rollback;
