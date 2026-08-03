'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ENABLED = process.env.SUPABASE_CONTAINMENT_DISPOSABLE === 'true';
const DATABASE = `alphascreen_supabase_containment_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'supabase-public-api-containment-bootstrap.sql');
const CONTAINMENT = path.join(ROOT, 'supabase', 'migrations', '20260803155651_public_api_emergency_containment.sql');
const DEFAULTS = path.join(ROOT, 'supabase', 'migrations', '20260803155704_public_default_privilege_hardening.sql');

const TABLES = [
  'accommodation_requests',
  'billing_events',
  'client_plan_settings',
  'contract_cancellation_runs',
  'contract_processing_runs',
  'conversations',
  'digest_logs',
  'feedback_issues_catalog',
  'feedback_submissions',
  'feedback_suggestions_catalog',
  'otp_tokens',
  'pending_role_purchases',
  'request_rate_limits',
  'role_interview_purchases',
  'rubric_change_requests',
];

function psqlArgs(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database, '-At'];
}

function sql(statement, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(options.database || DATABASE), '-c', statement], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) assert.fail(result.stderr || result.stdout);
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function applyFile(filename) {
  const result = spawnSync('psql', [...psqlArgs(), '-f', filename], { encoding: 'utf8' });
  if (result.status !== 0) assert.fail(`apply ${path.basename(filename)} failed: ${result.stderr || result.stdout}`);
}

function databaseCommand(command, database) {
  return spawnSync(command, ['-h', '/tmp', '-p', '5432', database], { encoding: 'utf8' });
}

before(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', DATABASE);
  const created = databaseCommand('createdb', DATABASE);
  assert.equal(created.status, 0, created.stderr);
  applyFile(BOOTSTRAP);
});

after(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', DATABASE);
});

test('containment migrations declare the complete deny-by-default posture', () => {
  const fs = require('node:fs');
  const containment = fs.readFileSync(CONTAINMENT, 'utf8');
  const defaults = fs.readFileSync(DEFAULTS, 'utf8');

  for (const table of TABLES) {
    assert.match(containment, new RegExp(`public\\.${table.replaceAll('_', '\\_')}`, 'i'));
  }
  assert.match(containment, /drop view if exists public\.v_latest_otp_per_email_role/i);
  assert.match(containment, /revoke all privileges on table public\.role_candidate_counts/i);
  assert.match(containment, /revoke all privileges on sequence public\.billing_events_id_seq/i);
  assert.match(containment, /check_and_increment_rate_limit\(text, text, integer, integer\)/i);
  assert.doesNotMatch(containment, /using\s*\(\s*true\s*\)/i);
  assert.match(defaults, /for role postgres in schema public/i);
  assert.match(defaults, /for role supabase_admin in schema public/i);
  assert.doesNotMatch(defaults, /grant\s+.*\s+to\s+(anon|authenticated)/i);
});

test('containment migrations apply and safely reapply', { skip: !ENABLED }, () => {
  applyFile(CONTAINMENT);
  applyFile(DEFAULTS);
  applyFile(CONTAINMENT);
  applyFile(DEFAULTS);
});

test('all affected tables enable RLS, define no client policy, and revoke client CRUD', { skip: !ENABLED }, () => {
  for (const table of TABLES) {
    assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass;`).stdout, 't', table);
    assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}';`).stdout, '0', table);
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(sql(`select has_table_privilege('${role}','public.${table}','${privilege}');`).stdout, 'f', `${role} ${privilege} ${table}`);
      }
    }
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(sql(`select has_table_privilege('service_role','public.${table}','${privilege}');`).stdout, 't', `service_role ${privilege} ${table}`);
    }
  }

  assert.equal(sql(`
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and (
        has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'SELECT')
        or has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE')
      );
  `).stdout, '0', 'every Data API client-granted public table must have RLS');
});

test('actual anon and authenticated operations fail while service role remains functional', { skip: !ENABLED }, () => {
  for (const role of ['anon', 'authenticated']) {
    for (const statement of [
      'select * from public.otp_tokens',
      "insert into public.otp_tokens(candidate_email, role_id, code) values ('synthetic@example.test',1,'000000')",
      "update public.otp_tokens set code='111111'",
      'delete from public.otp_tokens',
    ]) {
      const denied = sql(`set role ${role}; ${statement};`, { allowFailure: true });
      assert.notEqual(denied.status, 0, `${role} unexpectedly ran ${statement}`);
      assert.match(denied.stderr, /permission denied/i);
    }
  }

  assert.equal(sql("set role service_role; select allowed from public.check_and_increment_rate_limit('synthetic-route','synthetic-subject',60000,3);").stdout, 't');
  for (const table of TABLES) {
    assert.equal(sql(`set role service_role; select count(*) >= 0 from public.${table};`).stdout, 't', table);
  }
});

test('views, sequence, and RPC have no client bypass', { skip: !ENABLED }, () => {
  assert.equal(sql("select to_regclass('public.v_latest_otp_per_email_role') is null;").stdout, 't');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(sql(`select has_table_privilege('${role}','public.role_candidate_counts','SELECT');`).stdout, 'f');
    assert.equal(sql(`select has_sequence_privilege('${role}','public.billing_events_id_seq','USAGE');`).stdout, 'f');
    assert.equal(sql(`select has_sequence_privilege('${role}','public.billing_events_id_seq','SELECT');`).stdout, 'f');
    assert.equal(sql(`select has_function_privilege('${role}','public.check_and_increment_rate_limit(text,text,integer,integer)','EXECUTE');`).stdout, 'f');
  }
  assert.equal(sql("select has_table_privilege('service_role','public.role_candidate_counts','SELECT');").stdout, 't');
  assert.equal(sql("select has_sequence_privilege('service_role','public.billing_events_id_seq','USAGE');").stdout, 't');
  assert.equal(sql("select has_function_privilege('service_role','public.check_and_increment_rate_limit(text,text,integer,integer)','EXECUTE');").stdout, 't');
});

test('new objects created by postgres and supabase_admin inherit no client access', { skip: !ENABLED }, () => {
  sql(`
    set role postgres;
    create table public.containment_postgres_table(id bigint);
    create sequence public.containment_postgres_sequence;
    create function public.containment_postgres_function() returns integer language sql as 'select 1';
    set role supabase_admin;
    create table public.containment_admin_table(id bigint);
    create sequence public.containment_admin_sequence;
    create function public.containment_admin_function() returns integer language sql as 'select 1';
    reset role;
  `);

  for (const creator of ['postgres', 'admin']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`select has_table_privilege('${role}','public.containment_${creator}_table','SELECT');`).stdout, 'f');
      assert.equal(sql(`select has_sequence_privilege('${role}','public.containment_${creator}_sequence','USAGE');`).stdout, 'f');
      assert.equal(sql(`select has_function_privilege('${role}','public.containment_${creator}_function()','EXECUTE');`).stdout, 'f');
    }
  }
});
