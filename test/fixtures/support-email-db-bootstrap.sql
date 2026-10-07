create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, deleted_at timestamptz, banned_until timestamptz);
insert into auth.users values ('00000000-0000-4000-8000-000000000001','client@example.invalid',now(),null,null);
