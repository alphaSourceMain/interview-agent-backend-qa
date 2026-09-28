-- Which money columns on client_plan_settings are dollars and which are cents.
--
-- The table mixes the two, and nothing in the schema said so. A reader seeing
-- platform_fee 1200 next to usage_interview_fee_cents 2500 has no way to tell
-- that the first is twelve hundred dollars and the second is twenty-five, and
-- reading one as the other is a hundredfold error in a client's bill.
--
-- The units are not changed here — existing rows and the code that writes them
-- are left exactly as they are. This migration only records what they mean.
--
-- public.client_plan_settings is not created by any migration in this
-- repository, so every statement is guarded on the column existing. Comments
-- are idempotent: re-running simply sets the same text again.

do $$
declare
  money_column record;
begin
  for money_column in
    select *
    from (values
      ('platform_fee',
       'DOLLARS. The recurring membership fee. Numeric dollars, not cents — 1200 means $1,200.00.'),
      ('per_role_fee',
       'DOLLARS. Charge to open a role. Numeric dollars, not cents — 6.99 means $6.99. May be 0.'),
      ('additional_interview_fee',
       'DOLLARS. Price of one top-up interview bought in advance. Numeric dollars, not cents — 30 means $30.00. May be 0. Not used on the usage model, which bills after the fact.'),
      ('usage_interview_fee_cents',
       'CENTS. Enterprise per-interview price for metered interviews, in whole cents — 2500 means $25.00. Null means no price is set and nothing is billed for usage.')
    ) as t(column_name, column_comment)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'client_plan_settings'
        and column_name = money_column.column_name
    ) then
      execute format(
        'comment on column public.client_plan_settings.%I is %L',
        money_column.column_name,
        money_column.column_comment
      );
    end if;
  end loop;
end $$;

-- The two counts alongside them, so the money columns are not the only ones a
-- reader has to guess at.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'included_interviews_per_role'
  ) then
    comment on column public.client_plan_settings.included_interviews_per_role is
      'COUNT. Interviews each role may run before anything is charged. 0 is a valid setting: an Enterprise client with 0 is billed from their interview pool and then the meter, from their first interview.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_plan_settings'
      and column_name = 'rollover_days'
  ) then
    comment on column public.client_plan_settings.rollover_days is
      'DAYS. How long credit minted from a closed role stays spendable, on the rollover model. Defaults to 90.';
  end if;
end $$;
