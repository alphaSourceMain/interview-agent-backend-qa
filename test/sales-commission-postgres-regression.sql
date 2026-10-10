-- Run against an isolated PostgreSQL database after the sales commission migration.
-- This transaction is rolled back so the fixture never becomes a ledger entry.
begin;
do $$
declare
  tested_intent uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  tested_rep uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  reviewer uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  first_commission bigint;
  later_commission bigint;
  tested_receipt uuid;
  late_rejected boolean := false;
  self_service_rejected boolean := false;
  adjustment_rejected boolean := false;
  payout_rejected boolean := false;
begin
  -- More than one page of incomplete sales must not hide the older, active sale.
  insert into public.public_purchase_intents (id, status, activated_at)
  select gen_random_uuid(), 'checkout_pending', null from generate_series(1, 501);
  insert into public.clients (id, billing_status, subscription_status)
    values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'active', 'active');
  insert into public.membership_agreements
    (id, client_id, status, checkout_status, signed_at, checkout_paid_at)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'signed', 'paid',
            '2026-01-10T17:00:00Z', '2026-01-10T18:00:00Z');
  insert into public.public_purchase_intents
    (id, client_id, agreement_id, company_legal_name, buyer_email,
     selected_plan_key, selected_billing_cadence, created_by_user_id,
     activated_at, status, channel)
    values (tested_intent, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Synthetic QA',
            'qa@example.invalid', 'basic', 'monthly', tested_rep,
            '2026-01-10T18:00:00Z', 'completed', 'sales_assisted');
  if (select count(*) from public.sales_commission_review_candidates) <> 1 then
    raise exception 'active completed sale omitted from review view';
  end if;
  if (select id from public.sales_commission_review_candidates
      order by activated_at desc limit 500) <> tested_intent then
    raise exception 'qualifying sale hidden behind incomplete page';
  end if;

  insert into public.sales_commission_receipts
    (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
     payment_success_at, funds_received_at, qualification_closed_at,
     first_term_start_at, first_term_end_at, gross_membership_cents,
     discount_cents, provider_fee_cents, statement_week_start,
     evidence_reference, reviewed_by_user_id)
  values
    (tested_intent, tested_rep, 'stripe', 'pi_pg_first_month', 'monthly',
     '2026-01-10T18:00:00Z', '2026-01-11T18:00:00Z', '2026-01-10T18:00:00Z',
     '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
     0, 897, '2026-01-12', 'first month provider receipt', reviewer)
  returning commission_cents into first_commission;

  insert into public.sales_commission_receipts
    (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
     payment_success_at, funds_received_at, qualification_closed_at,
     first_term_start_at, first_term_end_at, gross_membership_cents,
     discount_cents, provider_fee_cents, statement_week_start,
     evidence_reference, reviewed_by_user_id)
  values
    (tested_intent, tested_rep, 'stripe', 'pi_pg_later_month', 'monthly',
     '2026-03-10T18:00:00Z', '2026-03-11T18:00:00Z', '2026-01-10T18:00:00Z',
     '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
     1000, 897, '2026-03-16', 'later month provider receipt', reviewer)
  returning commission_cents into later_commission;

  if first_commission <> 14502 or later_commission <> 14002 then
    raise exception 'monthly commissions incorrect: %, %', first_commission, later_commission;
  end if;
  if (select count(*) from public.sales_commission_receipts where purchase_intent_id = tested_intent) <> 2 then
    raise exception 'expected two independent first-term monthly receipts';
  end if;

  insert into public.public_purchase_intents(id, status, channel, created_by_user_id)
    values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'completed', 'self_service', tested_rep);
  begin
    insert into public.sales_commission_receipts
      (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
       payment_success_at, funds_received_at, qualification_closed_at,
       first_term_start_at, first_term_end_at, gross_membership_cents,
       statement_week_start, evidence_reference, reviewed_by_user_id)
    values ('ffffffff-ffff-4fff-8fff-ffffffffffff', tested_rep, 'stripe',
      'pi_self_service_rejected', 'monthly', '2026-02-10T18:00:00Z',
      '2026-02-11T18:00:00Z', '2026-01-10T18:00:00Z', '2026-01-01T07:00:00Z',
      '2027-01-01T07:00:00Z', 29900, '2026-02-16', 'must not pay self service', reviewer);
  exception when raise_exception then
    if sqlerrm <> 'commission_sale_not_sales_assisted' then raise; end if;
    self_service_rejected := true;
  end;
  if not self_service_rejected then raise exception 'self_service_receipt_accepted'; end if;

  select id into tested_receipt from public.sales_commission_receipts
    where purchase_intent_id = tested_intent order by payment_success_at limit 1;
  update public.public_purchase_intents set channel = 'self_service' where id = tested_intent;
  begin
    insert into public.sales_commission_adjustments
      (receipt_id, adjustment_type, provider_event_id, net_membership_delta_cents,
       commission_delta_cents, effective_at, statement_week_start, evidence_reference, reviewed_by_user_id)
    values (tested_receipt, 'refund', 'evt_wrong_channel', -100, -50,
      '2026-01-15T18:00:00Z', '2026-01-19', 'must reject wrong channel', reviewer);
  exception when raise_exception then
    if sqlerrm <> 'commission_sale_not_sales_assisted' then raise; end if;
    adjustment_rejected := true;
  end;
  if not adjustment_rejected then raise exception 'self_service_adjustment_accepted'; end if;
  begin
    insert into public.sales_commission_payouts
      (receipt_id, amount_cents, ach_reference, paid_at, evidence_reference, recorded_by_user_id)
    values (tested_receipt, 100, 'ach_wrong_channel', '2026-01-30T18:00:00Z',
      'must reject wrong channel', reviewer);
  exception when raise_exception then
    if sqlerrm <> 'commission_sale_not_sales_assisted' then raise; end if;
    payout_rejected := true;
  end;
  if not payout_rejected then raise exception 'self_service_payout_accepted'; end if;
  update public.public_purchase_intents set channel = 'sales_assisted' where id = tested_intent;

  begin
    insert into public.sales_commission_receipts
      (purchase_intent_id, rep_user_id, provider, provider_payment_id, payment_kind,
       payment_success_at, funds_received_at, qualification_closed_at,
       first_term_start_at, first_term_end_at, gross_membership_cents,
       discount_cents, provider_fee_cents, statement_week_start,
       evidence_reference, reviewed_by_user_id)
    values
      (tested_intent, tested_rep, 'stripe', 'pi_pg_renewal_month', 'monthly',
       '2027-01-01T07:00:00Z', '2027-01-02T07:00:00Z', '2026-01-10T18:00:00Z',
       '2026-01-01T07:00:00Z', '2027-01-01T07:00:00Z', 29900,
       0, 897, '2027-01-04', 'renewal must be excluded', reviewer);
  exception when check_violation then late_rejected := true;
  end;
  if not late_rejected then raise exception 'renewal payment was accepted'; end if;

  update public.clients set billing_status = 'past_due'
  where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  if exists (select 1 from public.sales_commission_review_candidates where id = tested_intent) then
    raise exception 'inactive client shown as commission-review candidate';
  end if;
end;
$$;
rollback;
