'use strict';
const { buildFixture } = require('./northstar');
const { DEMO_CLIENT_ID } = require('../src/lib/salesDemo');
function migrationSql() {
  const baseline = JSON.stringify(buildFixture(new Date('2026-10-08T21:00:00Z'))).replace(/'/g, "''");
  return `-- QA-only. Operator must SET LOCAL sales_demo.qa_project before applying.
do $guard$ begin
  if current_setting('sales_demo.qa_project',true) is distinct from 'yjjxzxoghlpguquknyso' then raise exception 'QA project assertion required'; end if;
end $guard$;
create schema if not exists private;
create table private.sales_demo_baseline (id boolean primary key default true check(id), fixture jsonb not null);
alter table private.sales_demo_baseline enable row level security;
revoke all on private.sales_demo_baseline from public,anon,authenticated,service_role;
insert into private.sales_demo_baseline values (true,'${baseline}'::jsonb);

create function private.sales_demo_control(p_operation text,p_target uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v jsonb; t text; row_data jsonb; cols text; updates text; conflict_count integer; unexpected integer; changed integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(3872026,1008);
  select fixture into strict v from private.sales_demo_baseline where id;
  if p_operation='role_status' then
    if p_target::text not in (select x->>'id' from pg_catalog.jsonb_array_elements(v->'roles') x)
      or p_status not in ('active','inactive') or p_status is null then raise exception 'invalid_demo_role_status'; end if;
    update public.roles set status=p_status, closed_at=case when p_status='inactive' then now() else null end,
      inactive_reason=case when p_status='inactive' then 'Closed during sales demo' else null end
      where id=p_target and client_id='${DEMO_CLIENT_ID}'::uuid;
    get diagnostics changed=row_count;
    if changed<>1 then raise exception 'demo_role_missing'; end if;
    return jsonb_build_object('ok',true,'status',p_status);
  end if;
  if p_operation<>'reset' or p_operation is null then raise exception 'invalid_demo_operation'; end if;
  if exists(select 1 from public.clients where parent_client_id='${DEMO_CLIENT_ID}'::uuid) then raise exception 'demo_child_scope_not_allowed'; end if;
  -- Validate the complete closed fixture BEFORE any upsert. Foreign collisions and
  -- unexpected rows abort the whole transaction; no arbitrary rows are deleted.
  foreach t in array array['clients','roles','candidates','interviews','reports'] loop
    if t='clients' then
      if exists(select 1 from public.clients where id='${DEMO_CLIENT_ID}'::uuid and (email<>'demo@northstar.example.invalid' or parent_client_id is not null)) then raise exception 'demo_client_collision'; end if;
    else
      execute format('select count(*) from public.%I where id::text in (select x->>''id'' from jsonb_array_elements($1) x) and client_id is distinct from $2',t)
        into conflict_count using v->t,'${DEMO_CLIENT_ID}'::uuid;
      execute format('select count(*) from public.%I where client_id=$2 and id::text not in (select x->>''id'' from jsonb_array_elements($1) x)',t)
        into unexpected using v->t,'${DEMO_CLIENT_ID}'::uuid;
      if conflict_count<>0 or unexpected<>0 then raise exception 'demo_fixture_not_closed'; end if;
    end if;
  end loop;
  foreach t in array array['clients','roles','candidates','interviews','reports'] loop
    for row_data in select value from pg_catalog.jsonb_array_elements(v->t) loop
      select string_agg(format('%I',key),',' order by key),string_agg(format('%1$I=excluded.%1$I',key),',' order by key)
        into cols,updates from pg_catalog.jsonb_object_keys(row_data) key where key<>'id'
          and exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t and c.column_name=key and c.is_generated='NEVER');
      execute format('insert into public.%1$I(id,%2$s) select id,%2$s from jsonb_populate_record(null::public.%1$I,$1) on conflict(id) do update set %3$s',t,cols,updates) using row_data;
    end loop;
  end loop;
  return jsonb_build_object('ok',true,'roles',2,'candidates',6);
end $fn$;
alter function private.sales_demo_control(text,uuid,text) owner to postgres;
revoke all on function private.sales_demo_control(text,uuid,text) from public,anon,authenticated,service_role;
-- The narrowly granted wrapper executes as postgres solely to reach the private
-- implementation, whose direct EXECUTE privilege is revoked even from service_role.
create function public.sales_demo_control(p_operation text,p_target uuid default null,p_status text default null)
returns jsonb language sql security definer set search_path='' as $wrapper$
  select private.sales_demo_control(p_operation,p_target,p_status)
$wrapper$;
alter function public.sales_demo_control(text,uuid,text) owner to postgres;
revoke all on function public.sales_demo_control(text,uuid,text) from public,anon,authenticated;
grant execute on function public.sales_demo_control(text,uuid,text) to service_role;

-- Deny direct API mutations in every existing public table with a demo-scope
-- column (including child tables), leaving existing read predicates untouched.
do $policies$ declare r record; predicate text; command text; pname text; begin
  for r in select table_name, string_agg(format('coalesce(%I::text,'''') !~ %L',column_name,'^d38ade00-2026-4000-8000-'),' and ') predicate
    from information_schema.columns where table_schema='public' and column_name in ('client_id','parent_client_id','role_id','candidate_id','interview_id')
      and table_name in(select tablename from pg_tables where schemaname='public') group by table_name loop
    predicate:=r.predicate;
    if r.table_name='clients' or r.table_name='roles' or r.table_name='candidates' or r.table_name='interviews' or r.table_name='reports' then
      predicate:=predicate || ' and id::text !~ ''^d38ade00-2026-4000-8000-''';
    end if;
    if not (select relrowsecurity from pg_class where oid=('public.'||quote_ident(r.table_name))::regclass) then raise exception 'existing_RLS_required: %',r.table_name; end if;
    foreach command in array array['insert','update','delete'] loop
      pname:='sales_demo_no_direct_'||command;
      execute format('create policy %I on public.%I as restrictive for %s to anon,authenticated %s',pname,r.table_name,command,
        case when command='insert' then 'with check ('||predicate||')' when command='update' then 'using ('||predicate||') with check ('||predicate||')' else 'using ('||predicate||')' end);
    end loop;
  end loop;
end $policies$;
select public.sales_demo_control('reset');
`;
}
module.exports = { migrationSql };
