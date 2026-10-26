'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync,spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const enabled=process.env.RETAIL_SALES_POLICY_DISPOSABLE==='true';
const pg='/opt/homebrew/opt/postgresql@17/bin/psql';
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
function sql(s){return execFileSync(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{input:s,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
function denied(s,re){assert.throws(()=>sql(s),e=>re.test(String(e.stderr)));}
function set(e,v,a=actor){return JSON.parse(sql(`set role service_role;select public.set_retail_sales_enabled(${e},${v},'${a}');`));}
before(()=>{
  if(!enabled)return;
  assert.ok(process.env.PGHOST?.startsWith('/private/tmp/retail-sales-policy-'));
  sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key);insert into auth.users values('${actor}'),('${other}');
    create table public.admins(user_id uuid primary key,is_active boolean);insert into public.admins values('${actor}',true);
    create table public.public_purchase_intents(id bigint generated always as identity primary key,channel text not null default 'retail',status text not null default 'pending');
    insert into public.public_purchase_intents(status) values('existing');
    grant usage on schema public to service_role;grant select on public.admins to service_role;
    grant select,insert,update on public.public_purchase_intents to service_role;grant usage on sequence public.public_purchase_intents_id_seq to service_role;`);
  sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261026145931_retail_sales_policy.sql'),'utf8'));
});
test('native OFF blocks only new retail, leaves saved intent updates/sales-assisted untouched',{skip:!enabled},()=>{
  denied("set role service_role;insert into public.public_purchase_intents default values;",/retail_sales_disabled/);
  sql("set role service_role;update public.public_purchase_intents set status='paid' where id=1;insert into public.public_purchase_intents(channel) values('sales_assisted');");
  assert.equal(sql('select status from public.public_purchase_intents where id=1;'),'paid');
  assert.equal(sql("select count(*) from public.public_purchase_intents where channel='retail';"),'1');
});
test('native confirmed ON/OFF and CAS preserve history/existing records with service-only grants',{skip:!enabled},()=>{
  assert.equal(set(true,0).version,1);sql("set role service_role;insert into public.public_purchase_intents default values;");
  const hash=sql('select md5(jsonb_agg(to_jsonb(i) order by id)::text) from public.public_purchase_intents i;');
  assert.equal(set(false,1).version,2);assert.equal(set(false,2).version,2);
  denied("set role service_role;insert into public.public_purchase_intents default values;",/retail_sales_disabled/);
  assert.equal(sql('select md5(jsonb_agg(to_jsonb(i) order by id)::text) from public.public_purchase_intents i;'),hash);
  denied(`set role service_role;select public.set_retail_sales_enabled(true,1,'${actor}');`,/retail_sales_policy_changed/);
  denied(`set role service_role;select public.set_retail_sales_enabled(true,2,'33333333-3333-4333-8333-333333333333');`,/foreign key/);
  for(const role of ['anon','authenticated']){
    denied(`set role ${role};select * from public.retail_sales_policy_events;`,/permission denied/);
    denied(`set role ${role};select public.set_retail_sales_enabled(true,2,'${actor}');`,/permission denied/);
  }
  denied('update public.retail_sales_policy_events set enabled=true;',/retail_sales_policy_immutable/);
  denied('delete from public.retail_sales_policy_events;',/retail_sales_policy_immutable/);
});
test('native intake shared lock serializes OFF after an admitted intake transaction',{skip:!enabled},async()=>{
  const on=set(true,2); // Failed inserts may consume identity sequence values.
  const child=spawn(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{stdio:['pipe','pipe','pipe']});
  const locked=new Promise((resolve,reject)=>{child.stdout.on('data',c=>{if(String(c).includes('ADMITTED'))resolve();});child.on('error',reject)});
  const ended=new Promise(resolve=>child.on('close',resolve));
  child.stdin.end("begin;set role service_role;insert into public.public_purchase_intents default values;select 'ADMITTED';select pg_sleep(1.5);commit;");
  await locked;const start=Date.now();assert.ok(set(false,on.version).version>on.version);assert.ok(Date.now()-start>=1000);assert.equal(await ended,0);
  denied("set role service_role;insert into public.public_purchase_intents default values;",/retail_sales_disabled/);
});
