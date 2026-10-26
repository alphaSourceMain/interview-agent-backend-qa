-- New retail intake only. Existing agreements, billing and recovery are untouched.
begin;
set local lock_timeout='10s';
create table public.retail_sales_policy_events (
  version bigint generated always as identity primary key check(version between 1 and 9007199254740991),
  enabled boolean not null,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by_user_id uuid not null references auth.users(id) on delete restrict
);
alter table public.retail_sales_policy_events enable row level security;
revoke all on public.retail_sales_policy_events from public,anon,authenticated,service_role;
grant select,insert on public.retail_sales_policy_events to service_role;
revoke all on sequence public.retail_sales_policy_events_version_seq from public,anon,authenticated,service_role;
grant usage on sequence public.retail_sales_policy_events_version_seq to service_role;

create function public.reject_retail_sales_policy_mutation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'retail_sales_policy_immutable'; end $$;
create trigger retail_sales_policy_immutable before update or delete on public.retail_sales_policy_events
for each row execute function public.reject_retail_sales_policy_mutation();

create function public.set_retail_sales_enabled(p_enabled boolean,p_expected_version bigint,p_actor uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare v bigint; e boolean; changed timestamptz;
begin
  if current_user<>'service_role' or p_enabled is null or p_actor is null or p_expected_version is null
    or p_expected_version<0 or p_expected_version>9007199254740991
    then raise exception 'invalid_retail_sales_confirmation';end if;
  -- Actor is supplied by the existing authenticated active-admin route, not the
  -- request body. The Auth FK validates identity existence. Match the existing
  -- renewal-policy trust boundary; do not grant service_role Auth-table reads.
  perform pg_catalog.pg_advisory_xact_lock(17673944,26102026);
  select version,enabled,changed_at into v,e,changed from public.retail_sales_policy_events order by version desc limit 1;
  v:=coalesce(v,0);e:=coalesce(e,false);
  if v<>p_expected_version then raise exception 'retail_sales_policy_changed';end if;
  if e is distinct from p_enabled then
    insert into public.retail_sales_policy_events(enabled,changed_by_user_id) values(p_enabled,p_actor)
      returning version,enabled,changed_at into v,e,changed;
  end if;
  return jsonb_build_object('enabled',e,'version',v,'changed_at',changed);
end $$;

-- Close the intake/policy-change race at the original writer. Sales-assisted
-- inserts and every UPDATE (including accepted/payment/recovery records) remain unchanged.
create function public.guard_new_retail_sales_intake()
returns trigger language plpgsql security invoker set search_path=pg_catalog set lock_timeout='10s' as $$
declare e boolean;
begin
  if new.channel='retail' then
    perform pg_catalog.pg_advisory_xact_lock_shared(17673944,26102026);
    select enabled into e from public.retail_sales_policy_events order by version desc limit 1;
    if coalesce(e,false) is not true then raise exception 'retail_sales_disabled';end if;
  end if;
  return new;
end $$;
create trigger retail_sales_intake_policy before insert on public.public_purchase_intents
for each row execute function public.guard_new_retail_sales_intake();
revoke all on function public.reject_retail_sales_policy_mutation(),public.set_retail_sales_enabled(boolean,bigint,uuid),
  public.guard_new_retail_sales_intake() from public,anon,authenticated;
grant execute on function public.reject_retail_sales_policy_mutation(),public.set_retail_sales_enabled(boolean,bigint,uuid),
  public.guard_new_retail_sales_intake() to service_role;
commit;
