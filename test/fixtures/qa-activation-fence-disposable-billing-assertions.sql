-- Synthetic-only smoke assertions for the unapplied QA billing RPC draft.
-- Requires qa-activation-fence-disposable-bootstrap.sql and the draft migration.
\set ON_ERROR_STOP on

insert into public.clients (id, name, email, plan_tier, billing_interval)
values ('10000000-0000-4000-8000-000000000001', 'Synthetic QA', 'buyer@example.invalid', 'basic', 'monthly');

insert into public.membership_agreements (id, client_id, status, checkout_status, admin_email)
values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'signed', 'paid', 'buyer@example.invalid');

insert into public.public_purchase_intents (
  id, agreement_id, client_id, status, activation_claim_key, activation_claimed_at,
  selected_plan_key, selected_billing_cadence, package_snapshot,
  first_role_prepay_selected, first_role_prepay_credit_type,
  first_role_normal_role_fee_cents, first_role_prepay_amount_cents,
  first_role_prepay_discount_percent, stripe_checkout_session_id, buyer_email
) values (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'completed', 'synthetic-claim', clock_timestamp(), 'basic', 'monthly',
  '{"platform_fee":299,"per_role_fee":399,"included_interviews_per_role":20,"additional_interview_fee":30,"max_interview_minutes":10,"first_role_prepay":{"selected":true,"credit_type":"first_role_prepay","normal_role_fee_cents":39900,"discounted_credit_amount_cents":35900,"discount_percent":10,"non_refundable":true,"expires":false}}'::jsonb,
  true, 'first_role_prepay', 39900, 35900, 10, 'cs_synthetic_qa', 'buyer@example.invalid'
);

create function public.synthetic_apply_qa_billing(p_cancel_at_term_end boolean default false, p_intent_id uuid default '30000000-0000-4000-8000-000000000001')
returns jsonb language sql as $$
  select public.apply_public_purchase_billing(
    p_intent_id => p_intent_id,
    p_claim_key => 'synthetic-claim',
    p_client_id => '10000000-0000-4000-8000-000000000001',
    p_billing_client_id => '10000000-0000-4000-8000-000000000001',
    p_stripe_customer_id => 'cus_synthetic_qa',
    p_stripe_subscription_id => 'sub_synthetic_qa',
    p_subscription_status => 'active',
    p_billing_status => 'active',
    p_billing_interval => 'monthly',
    p_plan_tier => 'basic',
    p_current_term_end => '2026-11-01T00:00:00Z',
    p_cancel_at_term_end => p_cancel_at_term_end,
    p_auto_renew => true,
    p_cancel_effective_at => null,
    p_contract_start_at => '2026-10-01T00:00:00Z',
    p_contract_end_at => '2027-10-01T00:00:00Z',
    p_platform_fee => 299,
    p_per_role_fee => 399,
    p_included_interviews_per_role => 20,
    p_additional_interview_fee => 30,
    p_max_interview_minutes => 10,
    p_credit_selected => true,
    p_credit_type => 'first_role_prepay',
    p_credit_normal_role_fee_cents => 39900,
    p_credit_discounted_amount_cents => 35900,
    p_credit_discount_percent => 10,
    p_credit_non_refundable => true,
    p_credit_expires => false
  );
$$;

do $$
declare
  v_result jsonb;
  v_before_client jsonb;
  v_before_plan jsonb;
  v_before_credit jsonb;
  v_time_zone text := current_setting('TimeZone');
begin
  v_result := public.synthetic_apply_qa_billing();
  if v_result->>'status' <> 'applied' then
    raise exception 'first_apply_failed: %', v_result;
  end if;
  if (select count(*) from public.client_plan_settings) <> 1
    or (select count(*) from public.client_role_credits) <> 1 then
    raise exception 'first_apply_row_count_failed';
  end if;

  update public.client_role_credits set status = 'claimed';
  select to_jsonb(c) into v_before_client from public.clients c;
  select to_jsonb(p) into v_before_plan from public.client_plan_settings p;
  select to_jsonb(c) into v_before_credit from public.client_role_credits c;

  v_result := public.synthetic_apply_qa_billing();
  if v_result->>'status' <> 'already_applied' then
    raise exception 'consumed_credit_replay_failed: %', v_result;
  end if;
  perform set_config('TimeZone', 'Pacific/Honolulu', true);
  v_result := public.synthetic_apply_qa_billing();
  if v_result->>'status' <> 'already_applied' then
    raise exception 'timezone_changed_digest: %', v_result;
  end if;
  if jsonb_build_array(299::numeric(20,4))::text is distinct from
     jsonb_build_array(299.00::numeric(20,4))::text then
    raise exception 'numeric_scale_not_canonical';
  end if;
  perform set_config('TimeZone', v_time_zone, true);
  if v_before_client is distinct from (select to_jsonb(c) from public.clients c)
    or v_before_plan is distinct from (select to_jsonb(p) from public.client_plan_settings p)
    or v_before_credit is distinct from (select to_jsonb(c) from public.client_role_credits c) then
    raise exception 'equal_digest_replay_mutated_data';
  end if;

  begin
    perform public.synthetic_apply_qa_billing(true);
    raise exception 'different_digest_was_accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'billing_payload_conflict' then
      raise;
    end if;
  end;

  v_result := public.synthetic_apply_qa_billing(false, '00000000-0000-4000-8000-000000000001');
  if v_result->>'status' <> 'billing_protocol_manual_review' then
    raise exception 'legacy_protocol_wrote_or_passed: %', v_result;
  end if;
end;
$$;

begin;
update public.public_purchase_intents set protocol='legacy_complete'
where id='30000000-0000-4000-8000-000000000001';
do $$
declare v_result jsonb;
begin
  v_result := public.claim_public_purchase_activation(
    '20000000-0000-4000-8000-000000000001',
    'synthetic-legacy-claim-0000000000000001');
  if v_result->>'status' <> 'historical_complete' then
    raise exception 'legacy_claim_was_allowed: %', v_result;
  end if;
end;
$$;
rollback;
