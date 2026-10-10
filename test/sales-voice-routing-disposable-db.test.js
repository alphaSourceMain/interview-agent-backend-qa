'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const DATABASE = process.env.SALES_VOICE_ROUTING_DISPOSABLE_DATABASE || '';
const ENABLED = DATABASE === 'alphascreen_sales_voice_disposable';
const TEMP_DATABASE = `alphascreen_sales_voice_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'sales-voice-routing-disposable-bootstrap.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260922112921_shared_sales_voice_routing.sql');

const LINE_1 = '21000000-0000-4000-8000-000000000001';
const LINE_2 = '21000000-0000-4000-8000-000000000002';

function psqlArgs(database = TEMP_DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database || 'postgres', '-At'];
}

function sql(statement, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(options.database || TEMP_DATABASE), '-c', statement], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) assert.fail(result.stderr || result.stdout);
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

function databaseCommand(command, database) {
  return spawnSync(command, ['-h', '/tmp', '-p', '5432', database], { encoding: 'utf8' });
}

function applyFile(database, filename) {
  const result = spawnSync('psql', [...psqlArgs(database), '-f', filename], { encoding: 'utf8' });
  if (result.status !== 0) assert.fail(`apply ${path.basename(filename)} failed: ${result.stderr || result.stdout}`);
}

before(() => {
  if (!ENABLED) return;
  assert.equal(sql("select current_database()='alphascreen_sales_voice_disposable';", { database: DATABASE }).stdout, 't');
  databaseCommand('dropdb', TEMP_DATABASE);
  const created = databaseCommand('createdb', TEMP_DATABASE);
  assert.equal(created.status, 0, created.stderr);
  applyFile(TEMP_DATABASE, BOOTSTRAP);
  applyFile(TEMP_DATABASE, MIGRATION);
});

after(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', TEMP_DATABASE);
});

test('sales voice DB 1. migration keeps routing objects service-role-only', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_table_privilege('anon','public.sales_voice_route_events','select');").stdout, 'f');
  assert.equal(sql("select has_table_privilege('authenticated','public.sales_voice_call_contexts','select');").stdout, 'f');
  assert.equal(sql("select has_function_privilege('service_role','public.record_sales_voice_route(uuid,text)','execute');").stdout, 't');
  assert.equal(sql("select has_table_privilege('service_role','public.sales_voice_route_events','update');").stdout, 't');
  assert.equal(sql("select count(*) from public.sales_phone_numbers where shared_voice_entrypoint;").stdout, '1');
});

test('sales voice DB 2. same-line route retries are idempotent before context creation', { skip: !ENABLED }, () => {
  const result = sql(`set role service_role;
    with first as (select public.record_sales_voice_route('${LINE_1}', '+17205550101') as id),
         second as (select public.record_sales_voice_route('${LINE_1}', '+17205550101') as id)
    select first.id = second.id from first cross join second;`).stdout;
  assert.equal(result, 't');
  assert.equal(sql("select count(*) from public.sales_voice_route_events where caller_phone_e164='+17205550101';").stdout, '1');
});

test('sales voice DB 3. different-line routes for one caller fail closed as ambiguous', { skip: !ENABLED }, () => {
  sql(`set role service_role;
    select public.record_sales_voice_route('${LINE_1}', '+17205550102');
    select public.record_sales_voice_route('${LINE_2}', '+17205550102');`);
  const result = sql(`set role service_role;
    select * from public.create_sales_voice_call_context('+17205550102', repeat('a', 64));`, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sales_voice_route_ambiguous/i);
  assert.equal(sql("select count(*) from public.sales_voice_call_contexts where token_sha256=repeat('a',64);").stdout, '0');
});

test('sales voice DB 4. unrelated cleanup preserves a live context and its full claim window', { skip: !ENABLED }, () => {
  const eventId = sql(`set role service_role; select public.record_sales_voice_route('${LINE_1}', '+17205550103');`).stdout;
  assert.equal(sql("set role service_role; select assignment_id from public.create_sales_voice_call_context('+17205550103', repeat('b',64));").stdout, '23000000-0000-4000-8000-000000000001');
  sql(`reset role;
    update public.sales_voice_route_events set created_at=now()-interval '11 minutes', expires_at=now()-interval '1 second' where id='${eventId}';
    update public.sales_voice_call_contexts set created_at=now()-interval '1 minute', expires_at=now()+interval '14 minutes' where token_sha256=repeat('b',64);`);
  sql(`set role service_role; select public.record_sales_voice_route('${LINE_2}', '+17205550104');`);
  assert.equal(sql(`select count(*) from public.sales_voice_route_events where id='${eventId}';`).stdout, '1');
  assert.equal(sql("select assignment_id||'|'||caller_phone_e164 from public.claim_sales_voice_call_context(repeat('b',64));").stdout, '23000000-0000-4000-8000-000000000001|+17205550103');
  assert.equal(sql("select count(*) from public.claim_sales_voice_call_context(repeat('b',64));").stdout, '0');
});

test('sales voice DB 5. expired contexts and their expired route events are cleaned together', { skip: !ENABLED }, () => {
  const eventId = sql(`set role service_role; select public.record_sales_voice_route('${LINE_1}', '+17205550105');`).stdout;
  sql("set role service_role; select * from public.create_sales_voice_call_context('+17205550105', repeat('c',64));");
  sql(`reset role;
    update public.sales_voice_call_contexts set created_at=now()-interval '16 minutes', expires_at=now()-interval '1 second' where token_sha256=repeat('c',64);
    update public.sales_voice_route_events set created_at=now()-interval '20 minutes', expires_at=now()-interval '10 minutes' where id='${eventId}';`);
  sql(`set role service_role; select public.record_sales_voice_route('${LINE_2}', '+17205550106');`);
  assert.equal(sql("select count(*) from public.sales_voice_call_contexts where token_sha256=repeat('c',64);").stdout, '0');
  assert.equal(sql(`select count(*) from public.sales_voice_route_events where id='${eventId}';`).stdout, '0');
});
