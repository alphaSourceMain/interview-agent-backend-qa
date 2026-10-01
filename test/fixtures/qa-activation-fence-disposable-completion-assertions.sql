-- Synthetic-only completion RPC regression for the local QA draft.
\set ON_ERROR_STOP on

insert into public.clients (id, name, email, plan_tier, billing_interval)
values
  ('10000000-0000-4000-8000-000000000002', 'Synthetic QA Two', 'two@example.invalid', 'basic', 'monthly'),
  ('10000000-0000-4000-8000-000000000003', 'Synthetic QA Three', 'three@example.invalid', 'basic', 'monthly');

insert into public.membership_agreements (id, client_id, status, checkout_status)
values
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'signed', 'pending_payment'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'signed', 'pending_payment');

insert into public.public_purchase_intents (
  id, agreement_id, client_id, status, activation_claim_key, activation_claimed_at,
  selected_plan_key, selected_billing_cadence
) values
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'checkout_pending', 'synthetic-complete-two', clock_timestamp(), 'basic', 'monthly'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'checkout_pending', 'synthetic-complete-three', clock_timestamp(), 'basic', 'monthly');

do $$
declare v_result jsonb;
begin
  v_result := public.complete_public_purchase_activation(
    '20000000-0000-4000-8000-000000000002',
    'synthetic-complete-two',
    '2026-10-01T12:00:00Z',
    'cs_synthetic_complete_two',
    '10000000-0000-4000-8000-000000000002',
    false, 'basic', 'monthly', '2026-10-01', '2027-10-01'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'completion_status_failed: %', v_result;
  end if;
  if (select checkout_status from public.membership_agreements where id='20000000-0000-4000-8000-000000000002') <> 'paid'
    or (select status from public.public_purchase_intents where id='30000000-0000-4000-8000-000000000002') <> 'completed' then
    raise exception 'completion_state_failed';
  end if;
  begin
    perform public.complete_public_purchase_activation(
      '20000000-0000-4000-8000-000000000003',
      'synthetic-complete-three', '2026-10-01T12:00:00Z', null,
      '10000000-0000-4000-8000-000000000003', false,
      'pro', 'monthly', '2026-10-01', '2027-10-01'
    );
    raise exception 'mismatched_plan_accepted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid_activation_input' then raise; end if;
  end;
  if (select checkout_status from public.membership_agreements
      where id='20000000-0000-4000-8000-000000000003') <> 'pending_payment' then
    raise exception 'invalid_completion_mutated_agreement';
  end if;
end;
$$;
