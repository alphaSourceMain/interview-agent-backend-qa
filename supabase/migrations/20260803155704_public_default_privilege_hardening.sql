begin;

-- Deny-by-default for every known creator of application objects in public.
-- Application migrations must explicitly grant only their reviewed runtime ACLs.

alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated;

-- Hosted Supabase does not let the project postgres role assume the managed
-- supabase_admin role. The Dashboard's "Automatically expose new tables"
-- control must be disabled before this migration on hosted projects. Apply the
-- same revokes directly when the migration identity is allowed to manage that
-- role (for example, in the disposable validation database).
do $managed_defaults$
begin
  if current_user = 'supabase_admin'
    or pg_has_role(current_user, 'supabase_admin', 'USAGE')
  then
    execute 'alter default privileges for role supabase_admin in schema public revoke all privileges on tables from public, anon, authenticated';
    execute 'alter default privileges for role supabase_admin revoke all privileges on tables from public, anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all privileges on sequences from public, anon, authenticated';
    execute 'alter default privileges for role supabase_admin revoke all privileges on sequences from public, anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon, authenticated';
    execute 'alter default privileges for role supabase_admin revoke execute on functions from public, anon, authenticated';
  end if;
end
$managed_defaults$;

-- Fail closed unless both known creators now produce private-by-default
-- tables, sequences, and functions. Schema-scoped defaults are additive to
-- global defaults, so both scopes are inspected. For functions, acldefault()
-- also detects PostgreSQL's implicit global PUBLIC EXECUTE when no override
-- row exists.
do $verify_defaults$
declare
  unsafe_defaults text;
begin
  with creators as (
    select oid, rolname
    from pg_roles
    where rolname in ('postgres', 'supabase_admin')
  ),
  object_kinds(objtype, object_kind) as (
    values ('r'::"char", 'table'),
           ('S'::"char", 'sequence'),
           ('f'::"char", 'function')
  ),
  client_roles as (
    select 0::oid as oid
    union all
    select oid from pg_roles where rolname in ('anon', 'authenticated')
  ),
  global_grants as (
    select c.rolname, k.object_kind, x.grantee, x.privilege_type
    from creators c
    cross join object_kinds k
    left join pg_default_acl d
      on d.defaclrole = c.oid
     and d.defaclnamespace = 0
     and d.defaclobjtype = k.objtype
    cross join lateral aclexplode(
      coalesce(d.defaclacl, acldefault(k.objtype, c.oid))
    ) x
  ),
  schema_grants as (
    select c.rolname, k.object_kind, x.grantee, x.privilege_type
    from creators c
    join pg_default_acl d
      on d.defaclrole = c.oid
     and d.defaclnamespace = 'public'::regnamespace
    join object_kinds k on k.objtype = d.defaclobjtype
    cross join lateral aclexplode(d.defaclacl) x
  ),
  unsafe as (
    select * from global_grants
    where grantee in (select oid from client_roles)
    union all
    select * from schema_grants
    where grantee in (select oid from client_roles)
  )
  select string_agg(
    format('%s:%s:%s', rolname, object_kind, privilege_type),
    ', ' order by rolname, object_kind, privilege_type
  )
  into unsafe_defaults
  from unsafe;

  if unsafe_defaults is not null then
    raise exception 'unsafe public Data API defaults remain: %', unsafe_defaults;
  end if;
end
$verify_defaults$;

commit;
