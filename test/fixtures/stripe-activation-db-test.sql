-- Execute after stripe-activation-db-schema.sql and the recovery migration in
-- a disposable PostgreSQL database. Any failed assertion stops psql.
do $$
declare
  v_agreement uuid := '10000000-0000-4000-8000-000000000001';
  v_intent uuid := '20000000-0000-4000-8000-000000000001';
  v_client uuid := '30000000-0000-4000-8000-000000000001';
  v_fence text := 'qa-fence-11111111-1111-4111-8111-111111111111';
  v_replay text := 'qa-fence-22222222-2222-4222-8222-222222222222';
  v_result jsonb;
begin
  insert into public.membership_agreements(id) values (v_agreement);
  insert into public.public_purchase_intents(id, agreement_id) values (v_intent, v_agreement);

  v_result := public.claim_public_purchase_activation(v_agreement, v_fence);
  if v_result->>'status' <> 'claimed' then raise exception 'first claim failed: %', v_result; end if;
  v_result := public.claim_public_purchase_activation(v_agreement, v_replay);
  if v_result->>'status' <> 'activation_in_progress' then raise exception 'fresh lease was stolen: %', v_result; end if;
  if not public.heartbeat_public_purchase_activation(v_intent, v_fence) then raise exception 'heartbeat failed'; end if;

  v_result := public.complete_public_purchase_activation(
    v_agreement, v_fence, '2026-09-30T18:00:00Z', 'cs_qa_1', v_client,
    true, 'basic', 'monthly', '2026-09-30', '2027-09-30'
  );
  if v_result->>'status' <> 'completed' then raise exception 'completion failed: %', v_result; end if;
  v_result := public.claim_public_purchase_activation(v_agreement, v_replay);
  if v_result->>'status' <> 'activation_in_progress' then raise exception 'completed tail was not fenced: %', v_result; end if;
  if not public.release_public_purchase_activation(v_intent, v_fence) then raise exception 'owner release failed'; end if;
  v_result := public.claim_public_purchase_activation(v_agreement, v_replay);
  if v_result->>'status' <> 'claimed' then raise exception 'completed replay did not claim: %', v_result; end if;
  v_result := public.complete_public_purchase_activation(
    v_agreement, v_replay, '2026-10-02T18:00:00Z', 'cs_qa_later', v_client,
    false, 'basic', 'monthly', '2026-10-02', '2027-10-02'
  );
  if v_result->>'status' <> 'completed' then raise exception 'replay completion failed: %', v_result; end if;
  if (select count(*) from public.clients where id = v_client) <> 1 then raise exception 'duplicate client created'; end if;
  if (select checkout_paid_at from public.membership_agreements where id = v_agreement) <> '2026-09-30T18:00:00Z'::timestamptz
    then raise exception 'original paid timestamp changed'; end if;
  if (select activated_at from public.public_purchase_intents where id = v_intent) <> '2026-09-30T18:00:00Z'::timestamptz
    then raise exception 'original activation timestamp changed'; end if;
  if (select initial_term_start from public.membership_agreements where id = v_agreement) <> '2026-09-30'::date
    then raise exception 'term start changed'; end if;
  if (select initial_renewal_date from public.membership_agreements where id = v_agreement) <> '2027-09-30'::date
    then raise exception 'renewal date changed'; end if;
  perform public.release_public_purchase_activation(v_intent, v_replay);
end;
$$;

do $$
declare
  v_agreement uuid := '10000000-0000-4000-8000-000000000002';
  v_intent uuid := '20000000-0000-4000-8000-000000000002';
  v_user uuid := '40000000-0000-4000-8000-000000000002';
  v_old text := 'qa-fence-33333333-3333-4333-8333-333333333333';
  v_new text := 'qa-fence-44444444-4444-4444-8444-444444444444';
  v_result jsonb;
begin
  insert into public.membership_agreements(id) values (v_agreement);
  insert into public.public_purchase_intents(id, agreement_id, created_by_user_id) values (v_intent, v_agreement, v_user);
  perform public.claim_public_purchase_activation(v_agreement, v_old);
  v_result := public.cancel_sales_assisted_purchase(v_intent, v_agreement, v_user);
  if v_result->>'status' <> 'refused' then raise exception 'live lease canceled: %', v_result; end if;
  update public.public_purchase_intents set activation_claimed_at = '2026-09-01T00:00:00Z' where id = v_intent;
  v_result := public.claim_public_purchase_activation(v_agreement, v_new);
  if v_result->>'status' <> 'claimed' then raise exception 'stale lease not reclaimed: %', v_result; end if;
  if public.release_public_purchase_activation(v_intent, v_old) then raise exception 'old owner released new lease'; end if;
  v_result := public.complete_public_purchase_activation(v_agreement, v_old, now(), null,
    '30000000-0000-4000-8000-000000000002', true, 'basic', 'monthly', current_date, current_date + 365);
  if v_result->>'status' <> 'activation_fence_lost' then raise exception 'zombie completed: %', v_result; end if;
  update public.public_purchase_intents set activation_claimed_at = '2026-09-01T00:00:00Z' where id = v_intent;
  v_result := public.cancel_sales_assisted_purchase(v_intent, v_agreement, v_user);
  if v_result->>'status' <> 'canceled' then raise exception 'stale lease cancel failed: %', v_result; end if;
  v_result := public.claim_public_purchase_activation(v_agreement, v_new);
  if v_result->>'status' <> 'agreement_superseded' and v_result->>'status' <> 'purchase_canceled'
    then raise exception 'canceled purchase reclaimed: %', v_result; end if;
  if (select checkout_status from public.membership_agreements where id = v_agreement) = 'paid'
    then raise exception 'canceled agreement marked paid'; end if;
end;
$$;

do $$
declare
  v_old_agreement uuid := '10000000-0000-4000-8000-000000000003';
  v_new_agreement uuid := '10000000-0000-4000-8000-000000000004';
  v_intent uuid := '20000000-0000-4000-8000-000000000003';
  v_old text := 'qa-fence-55555555-5555-4555-8555-555555555555';
  v_result jsonb;
begin
  insert into public.membership_agreements(id, status) values (v_old_agreement, 'signed'), (v_new_agreement, 'draft');
  insert into public.public_purchase_intents(id, agreement_id) values (v_intent, v_old_agreement);
  perform public.claim_public_purchase_activation(v_old_agreement, v_old);
  if public.replace_sales_assisted_agreement(v_intent, v_old_agreement, v_new_agreement, now() + interval '1 day')
    then raise exception 'live lease replaced'; end if;
  update public.public_purchase_intents set activation_claimed_at = '2026-09-01T00:00:00Z' where id = v_intent;
  if not public.replace_sales_assisted_agreement(v_intent, v_old_agreement, v_new_agreement, now() + interval '1 day')
    then raise exception 'stale lease replacement failed'; end if;
  v_result := public.claim_public_purchase_activation(v_old_agreement, v_old);
  if v_result->>'status' <> 'agreement_superseded' then raise exception 'old agreement claim proceeded: %', v_result; end if;
  if (select checkout_status from public.membership_agreements where id = v_old_agreement) = 'paid'
    then raise exception 'superseded agreement marked paid'; end if;
end;
$$;
