do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create table public.sales_team_members (
  id uuid primary key,
  status text not null
);

create table public.sales_phone_numbers (
  id uuid primary key,
  e164 text not null unique,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.sales_phone_assignments (
  id uuid primary key,
  team_member_id uuid not null references public.sales_team_members(id),
  phone_number_id uuid not null references public.sales_phone_numbers(id),
  status text not null
);

insert into public.sales_team_members (id, status) values
  ('22000000-0000-4000-8000-000000000001', 'active'),
  ('22000000-0000-4000-8000-000000000002', 'active');

insert into public.sales_phone_numbers (id, e164) values
  ('21000000-0000-4000-8000-000000000001', '+17207904187'),
  ('21000000-0000-4000-8000-000000000002', '+17198818074'),
  ('21000000-0000-4000-8000-000000000003', '+17192592989'),
  ('21000000-0000-4000-8000-000000000004', '+17192495855');

insert into public.sales_phone_assignments (id, team_member_id, phone_number_id, status) values
  ('23000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'active'),
  ('23000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'active');

grant select on public.sales_team_members, public.sales_phone_numbers to service_role;
grant select, update on public.sales_phone_assignments to service_role;
