'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { before, after, test } = require('node:test');
const ENABLED = process.env.BILLING_MIGRATION_DISPOSABLE === 'true';
const SOCKET = process.env.PGHOST || '';
const PORT = process.env.PGPORT || '55439';
const DATABASE = `alphascreen_billing_migrations_${process.pid}`;
const ROOT = path.join(__dirname, '..');
const TABLES = ['interview_credits', 'usage_billing_ledger', 'billing_idempotency_keys', 'enterprise_pool_discounts', 'client_interview_pools'];
const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter(n => /^20261009\d{6}_/.test(n)).sort();
function command(name, args) {
  const result = spawnSync(name, ['-h', SOCKET, '-p', PORT, '-U', 'postgres', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function sql(statement) { return command('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', DATABASE, '-c', statement]); }
function apply() {
  for (const name of migrations) command('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DATABASE, '-f', path.join(ROOT, 'supabase/migrations', name)]);
}
before(() => {
  if (!ENABLED) return;
  assert.match(SOCKET, /^\/private\/tmp\/alphascreen-merge-pg[^/]*\.[A-Za-z0-9]+$/, 'only a task-owned disposable Unix socket is permitted');
  assert.equal(migrations.length, 9);
  command('createdb', [DATABASE]);
  sql(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.client_plan_settings(
      id uuid primary key default gen_random_uuid(), client_id uuid not null unique,
      plan_tier text not null, billing_interval text not null, platform_fee numeric,
      per_role_fee numeric not null, included_interviews_per_role integer not null,
      additional_interview_fee numeric not null, max_interview_minutes integer not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table public.interviews(id uuid primary key, client_id uuid, status text, interview_summary text, updated_at timestamptz);
    create table public.role_interview_purchases(id uuid primary key, status text check(status in ('pending','paid','voided','refunded')));
    grant usage on schema public to anon,authenticated,service_role;
    grant select on public.interviews to authenticated;
    alter table public.interviews enable row level security;
    create policy preserved_interview_read on public.interviews for select to authenticated using(true);
    insert into public.client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,additional_interview_fee,max_interview_minutes)
      values('10000000-0000-4000-8000-000000000001','pro','monthly',599,699,30,30,10);
    insert into public.interviews values('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Analyzed','Synthetic summary','2026-09-15T10:00:00Z');
  `);
  apply();
});
after(() => { if (ENABLED) command('dropdb', ['--if-exists', DATABASE]); });
test('nine billing migrations apply and safely replay without changing existing overrides or timestamps', { skip: !ENABLED }, () => {
  assert.equal(sql('select billing_model from client_plan_settings'), 'rollover');
  assert.equal(sql("select completed_at='2026-09-15T10:00:00Z'::timestamptz from interviews"), 't');
  sql("update client_plan_settings set billing_model='fixed'; update interviews set completed_at='2026-08-01T00:00:00Z';");
  apply();
  assert.equal(sql('select billing_model from client_plan_settings'), 'fixed');
  assert.equal(sql("select completed_at='2026-08-01T00:00:00Z'::timestamptz from interviews"), 't');
  assert.equal(sql('select count(*) from enterprise_pool_discounts'), '3');
});
test('new billing tables have RLS and service-only application grants', { skip: !ENABLED }, () => {
  for (const table of [...TABLES, 'client_plan_settings', 'role_interview_purchases']) {
    assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`), 't');
    for (const role of ['anon','authenticated']) {
      assert.equal(sql(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE')`), 'f');
    }
    assert.equal(sql(`select has_table_privilege('service_role','public.${table}','SELECT,INSERT,UPDATE,DELETE')`), 't');
  }
});
test('billing migrations preserve existing interview access', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_table_privilege('authenticated','public.interviews','SELECT')"), 't');
  assert.equal(sql("select count(*) from pg_policies where tablename='interviews' and policyname='preserved_interview_read'"), '1');
});
test('financial units are not rewritten and delayed payment failures are accepted', { skip: !ENABLED }, () => {
  assert.equal(sql('select platform_fee,per_role_fee,additional_interview_fee from client_plan_settings'), '599|699|30');
  sql("insert into role_interview_purchases values('10000000-0000-4000-8000-000000000003','failed')");
  assert.equal(sql('select status from role_interview_purchases'), 'failed');
});
