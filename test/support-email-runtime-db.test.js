'use strict';
// Exact migration, local disposable PostgreSQL only, never hosted credentials.
const test=require('node:test'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),{readFile}=require('node:fs/promises'),{createHash}=require('node:crypto');
const run=promisify(execFile),socket=process.env.SUPPORT_EMAIL_RUNTIME_TEST_SOCKET;
const local=/^\/private\/tmp\/alphy-runtime-db-test\.[a-zA-Z0-9]+$/.test(socket||'');
let number=0;
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
async function sql(db,q){const r=await run('/opt/homebrew/bin/psql',['-h',socket,'-p','55476','-U','support_email_test','-d',db,'-v','ON_ERROR_STOP=1','-qAtc',q],{maxBuffer:1048576});return r.stdout.trim().split('\n').at(-1);}
async function fixture(){const db='runtime_'+process.pid+'_'+(++number);await sql('postgres','create database '+db);
  await sql(db,await readFile('test/fixtures/support-email-db-bootstrap.sql','utf8').then(s=>s.replace(/create role (anon|authenticated|service_role)(?: bypassrls)?;\n/g,'')));
  for(const name of ['20261007202154_support_email_draft_guard.sql','20261008022721_support_email_qa_send_guard.sql','20261008152921_support_email_qa_runtime.sql'])await sql(db,await readFile('supabase/migrations/'+name,'utf8'));
  return db;
}
async function rpc(db,op,nonce=null,data={},role='service_role'){return JSON.parse(await sql(db,`set role ${role}; select public.support_email_qa_worker(${quote(op)},${nonce?quote(nonce):'null'}::uuid,${quote(JSON.stringify({mode:'qa-owner-auto',...data}))}::jsonb);`)||'null');}
async function ready(db){await rpc(db,'control',null,{enabled:true});const first=await rpc(db,'acquire',null,{baseline:'1'});assert.equal(first.cursor,null);await rpc(db,'seed',first.nonce,{baseline:'1',current:'10'});return rpc(db,'acquire',null,{baseline:'1'});}
const hash=s=>createHash('sha256').update(s).digest('hex');
async function draft(db,lease,review=false){const id=await rpc(db,'claim',lease.nonce,{thread:'a'.repeat(64),message:'b'.repeat(64),gmail:'c'.repeat(64)});
  const body='Synthetic static support guidance.';await rpc(db,'draft',lease.nonce,{id,body,audience:'public',model_review:review,knowledge_hash:'d'.repeat(64),knowledge_version:'2026-09-11.5'});
  return {id,body_hash:hash(body),knowledge_hash:'d'.repeat(64),fingerprint:'e'.repeat(64),wire:'f'.repeat(64),thread_id:'abc'};
}
test('exact SQL compiles, defaults off; browser RPC and direct table grants denied',{skip:!local},async()=>{
  const db=await fixture();assert.equal((await rpc(db,'health')).enabled,false);assert.equal(await rpc(db,'acquire',null,{baseline:'1'}),null);
  for(const role of ['anon','authenticated'])await assert.rejects(rpc(db,'health',null,{},role),e=>/permission denied/.test(e.stderr));
  for(const role of ['anon','authenticated','service_role'])for(const table of ['qa_runtime','qa_runtime_items','qa_runtime_processed','qa_runtime_deliveries'])for(const q of [`select * from private_support_email.${table}`,`delete from private_support_email.${table}`])await assert.rejects(sql(db,`set role ${role}; `+q),e=>/permission denied/.test(e.stderr));
  assert.equal(await sql(db,"select count(*) from pg_class where relnamespace='private_support_email'::regnamespace and relname like 'qa_runtime%' and relrowsecurity"),'4');
  assert.equal(await sql(db,"select count(*) from pg_policies where schemaname='private_support_email' and tablename like 'qa_runtime%'"),'0');
  await assert.rejects(sql(db,"select public.support_email_qa_worker('health',null,'{}')"),e=>/denied/.test(e.stderr));
});
test('eight concurrent acquisitions have one winner; fence, mode and skew clocks available',{skip:!local},async()=>{
  const db=await fixture();await ready(db);await sql(db,"update private_support_email.qa_runtime set lease_until=clock_timestamp()-interval '1 second'");
  const leases=await Promise.all(Array.from({length:8},()=>rpc(db,'acquire',null,{baseline:'1'})));const won=leases.filter(Boolean);assert.equal(won.length,1);
  const l=won[0];assert.equal(l.cursor,'10');assert.ok(Math.abs(Date.now()-l.now_ms)<5000);assert.ok(l.lease_ms-l.now_ms>=175000);
  assert.equal(await rpc(db,'check','11111111-1111-4111-8111-111111111111'),null);
  assert.equal(await rpc(db,'check',l.nonce,{mode:'qa-draft'}),null);assert.equal(await rpc(db,'check',l.nonce),true);
  await rpc(db,'control',null,{enabled:false});assert.equal(await rpc(db,'check',l.nonce),null);
});
test('cursor seed is once; only completed fenced page advances, baseline immutable',{skip:!local},async()=>{
  const db=await fixture(),l=await ready(db);assert.equal(await rpc(db,'complete',l.nonce,{next:'20',counts:{sent:1}}),true);
  assert.equal(await rpc(db,'complete',l.nonce,{next:'30',counts:{}}),null);
  const next=await rpc(db,'acquire',null,{baseline:'1'});assert.equal(next.cursor,'20');
  await assert.rejects(rpc(db,'seed',next.nonce,{baseline:'1',current:'30'}));
  await assert.rejects(rpc(db,'complete',next.nonce,{next:'19',counts:{}}));
  await assert.rejects(rpc(db,'acquire',null,{baseline:'2'}));
  assert.equal(await sql(db,'select history_id from private_support_email.qa_runtime'),'20');
});
test('claim keys permanent across runs, processed skip does not consume a draft key',{skip:!local},async()=>{
  const db=await fixture(),l=await ready(db),data={thread:'a'.repeat(64),message:'b'.repeat(64),gmail:'c'.repeat(64)};
  assert.equal(await rpc(db,'processed',l.nonce,{gmail:'9'.repeat(64),reason:'not_owner'}),true);assert.equal(await sql(db,'select count(*) from private_support_email.drafts'),'0');
  const ids=await Promise.all(Array.from({length:8},()=>rpc(db,'claim',l.nonce,data)));assert.equal(ids.filter(Boolean).length,1);
  assert.equal(await rpc(db,'claim',l.nonce,data),null);assert.equal(await rpc(db,'seen',l.nonce,{gmail:'9'.repeat(64),gmail_id:'def'}),'processed');
});
test('one reserve/start/finish only; accepted and unknown permanently terminal',{skip:!local},async()=>{
  for(const state of ['accepted','unknown']){const db=await fixture(),l=await ready(db),b=await draft(db,l);
    const reserves=await Promise.all(Array.from({length:8},()=>rpc(db,'reserve',l.nonce,b)));assert.equal(reserves.filter(x=>x===true).length,1);
    const starts=await Promise.all(Array.from({length:8},()=>rpc(db,'start',l.nonce,b)));assert.equal(starts.filter(x=>x===true).length,1);
    assert.equal(await rpc(db,'finish',l.nonce,{id:b.id,state:'accepted',gmail_id:'def',thread_id:'wrong'}),null);
    assert.equal(await rpc(db,'finish',l.nonce,{id:b.id,state,...(state==='accepted'?{gmail_id:'def',thread_id:'abc'}:{})}),true);
    assert.equal(await rpc(db,'reserve',l.nonce,b),false);assert.equal(await rpc(db,'start',l.nonce,b),false);
    assert.equal(await rpc(db,'finish',l.nonce,{id:b.id,state:'unknown'}),false);
    assert.equal(await sql(db,'select state from private_support_email.qa_runtime_deliveries'),state);
  }
});
test('model review, later-run draft, modified body, expiry, wrong hashes and draft mode cannot send',{skip:!local},async()=>{
  const reviewed=await fixture(),a=await ready(reviewed),review=await draft(reviewed,a,true);assert.equal(await rpc(reviewed,'reserve',a.nonce,review),false);
  for(const update of ["body='changed'","body_expires_at=clock_timestamp()-interval '1 second'","human_review=false","knowledge_hash=repeat('9',64)"]){const db=await fixture(),l=await ready(db),b=await draft(db,l);assert.equal(await rpc(db,'reserve',l.nonce,b),true);await sql(db,'update private_support_email.drafts set '+update);assert.equal(await rpc(db,'start',l.nonce,b),false);}
  const later=await fixture(),l=await ready(later),b=await draft(later,l);await rpc(later,'complete',l.nonce,{next:'11',counts:{}});const next=await rpc(later,'acquire',null,{baseline:'1'});assert.equal(await rpc(later,'reserve',next.nonce,b),false);
  assert.equal(await rpc(later,'reserve',next.nonce,{...b,body_hash:'9'.repeat(64)}),false);
  await rpc(later,'control',null,{enabled:true,mode:'qa-draft'});const d=await rpc(later,'acquire',null,{mode:'qa-draft',baseline:'1'});assert.equal(await rpc(later,'reserve',d.nonce,{...b,mode:'qa-draft'}),null);
});
test('reserved cancellation is terminal; lease expiry invalidates start and cursor; emergency off fences',{skip:!local},async()=>{
  const db=await fixture(),l=await ready(db),b=await draft(db,l);assert.equal(await rpc(db,'reserve',l.nonce,b),true);
  assert.equal(await rpc(db,'cancel',l.nonce,{id:b.id}),true);assert.equal(await rpc(db,'start',l.nonce,b),false);assert.equal(await rpc(db,'reserve',l.nonce,b),false);
  const expired=await fixture(),e=await ready(expired),x=await draft(expired,e);assert.equal(await rpc(expired,'reserve',e.nonce,x),true);
  await sql(expired,"update private_support_email.qa_runtime set lease_until=clock_timestamp()-interval '1 second'");
  assert.equal(await rpc(expired,'start',e.nonce,x),null);assert.equal(await rpc(expired,'complete',e.nonce,{next:'20',counts:{}}),null);
  assert.equal(await sql(expired,'select history_id from private_support_email.qa_runtime'),'10');
});
