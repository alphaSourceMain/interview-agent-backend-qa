'use strict';
// Never accepts URLs or hosted credentials. Each test gets a fresh synthetic DB.
// Exact shipping SQL compiles first; only the two body pins are then replaced IN
// THE DISPOSABLE DATABASE to exercise successful transitions with a fake body.
const test=require('node:test'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),{readFile}=require('node:fs/promises'),{createHash}=require('node:crypto');
const run=promisify(execFile),socket=process.env.SUPPORT_EMAIL_SEND_TEST_SOCKET;
const disposable=/^\/private\/tmp\/alphy-send-db-test\.[a-zA-Z0-9]+$/.test(socket||'');
const draft='1afe67e6-78e7-4df9-a69a-cbb066351d9d',body='Synthetic database fixture only.',fingerprint='a'.repeat(64),wire='b'.repeat(64),thread='abc123';
let number=0;
async function sql(database,query){const result=await run('/opt/homebrew/bin/psql',['-h',socket,'-p','55475','-U','support_email_test','-d',database,'-v','ON_ERROR_STOP=1','-qAtc',query],{maxBuffer:1048576});return result.stdout.trim().split('\n').at(-1);}
async function fixture(){const db='send_fixture_'+process.pid+'_'+(++number);await sql('postgres','create database '+db);
  await sql(db,await readFile('test/fixtures/support-email-db-bootstrap.sql','utf8').then(s=>s.replace(/create role (anon|authenticated|service_role)(?: bypassrls)?;\n/g,'')));
  await sql(db,await readFile('supabase/migrations/20261007202154_support_email_draft_guard.sql','utf8'));
  const exact=await readFile('supabase/migrations/20261008022721_support_email_qa_send_guard.sql','utf8');await sql(db,exact);
  // Distinct fake-body pins only; never writes the shipping migration file.
  const adjusted=exact.replaceAll('3b5b4fcd3e944481c150ba00eb3ff5a2',createHash('md5').update(body).digest('hex')).replaceAll('25796fcabdd1ea631b88a60e83d9c7bc0351c6b1f08acc6f36e3e2bdbdfb6f38',createHash('sha256').update(body).digest('hex'));
  for(const name of ['reserve_send','start_send']){const match=adjusted.match(new RegExp('create function private_support_email\\.'+name+'[\\s\\S]+?\\n\\$\\$;'));assert.ok(match);await sql(db,match[0].replace('create function','create or replace function'));}
  await sql(db,`insert into private_support_email.drafts(id,thread_key,message_key,gmail_key,status,body,audience,human_review,knowledge_version,knowledge_hash) values ('${draft}',repeat('c',64),repeat('d',64),repeat('e',64),'draft','${body}','client',true,'2026-09-11.5','0239a37514af14d82144450226469790f64e37f5bc5123b4d0edb0bb64332925');`);
  return db;
}
const reserve=`select public.reserve_support_email_send('${draft}','${fingerprint}','${thread}','${wire}');`;
const start=nonce=>`select public.start_support_email_send('${draft}','${nonce}','${fingerprint}','${wire}');`;
const finish=(nonce,state='accepted',id="'def456'",returned="'abc123'")=>`select public.finish_support_email_send('${draft}','${nonce}','${state}',${id},${returned});`;
const service=(db,query)=>sql(db,'set role service_role; '+query);
test('exact SQL compiles; browser RPC and all direct service table operations denied', {skip:!disposable},async()=>{
  const db=await fixture();assert.equal(await sql(db,"select relrowsecurity from pg_class where oid='private_support_email.send_intents'::regclass"),'t');
  assert.equal(await sql(db,"select count(*) from pg_policies where schemaname='private_support_email' and tablename='send_intents'"),'0');
  for(const role of ['anon','authenticated'])for(const query of [reserve,`select public.read_support_email_send_draft('${draft}');`,`select * from private_support_email.send_intents;`])await assert.rejects(sql(db,`set role ${role}; `+query),e=>/permission denied/.test(e.stderr));
  for(const query of ['select * from private_support_email.send_intents','delete from private_support_email.send_intents','update private_support_email.send_intents set state=\'reserved\'',`insert into private_support_email.send_intents(draft_id,fingerprint,original_thread_id,wire_hash) values ('${draft}','${fingerprint}','${thread}','${wire}')`])await assert.rejects(service(db,query),e=>/permission denied/.test(e.stderr));
  await assert.rejects(sql(db,reserve),e=>/denied/.test(e.stderr));
  assert.equal(await service(db,reserve.replace(draft,'12345678-1234-4234-8234-123456789abc')),'');
});
test('eight concurrent reserves and starts each have exactly one winner; accepted permanently terminal',{skip:!disposable},async()=>{
  const db=await fixture(),results=await Promise.all(Array.from({length:8},()=>service(db,reserve))),nonces=results.filter(Boolean);assert.equal(nonces.length,1);
  const nonce=nonces[0],starts=await Promise.all(Array.from({length:8},()=>service(db,start(nonce))));assert.equal(starts.filter(x=>x==='t').length,1);
  assert.equal(await service(db,finish(nonce,'accepted',"'def456'","'wrong'")),'f');
  assert.equal(await service(db,finish(nonce)),'t');assert.equal(await service(db,finish(nonce)),'f');assert.equal(await service(db,finish(nonce,'unknown','null','null')),'f');
  assert.equal(await service(db,reserve),'');assert.equal(await service(db,start(nonce)),'f');
  assert.equal(await sql(db,"select state from private_support_email.send_intents"),'accepted');assert.equal(await service(db,`select public.read_support_email_send_draft('${draft}')->>'has_intent'`),'true');
});
test('unknown is terminal; expired reservation cannot start or be reused, cancelled cannot resume',{skip:!disposable},async()=>{
  const db=await fixture(),nonce=await service(db,reserve);assert.equal(await service(db,start(nonce)),'t');assert.equal(await service(db,finish(nonce,'unknown','null','null')),'t');assert.equal(await service(db,finish(nonce)),'f');assert.equal(await service(db,reserve),'');
  const expired=await fixture(),old=await service(expired,reserve);await sql(expired,"update private_support_email.send_intents set lease_expires_at=now()-interval '1 second'");
  assert.equal(await service(expired,start(old)),'f');assert.equal(await service(expired,reserve),'');assert.equal(await service(expired,`select public.cancel_support_email_send('${draft}','${old}')`),'t');assert.equal(await service(expired,start(old)),'f');assert.equal(await service(expired,reserve),'');
});
test('reserve and start recheck body/expiry/knowledge/human review and nonce',{skip:!disposable},async()=>{
  for(const update of ["body='changed'","body_expires_at=now()-interval '1 second'","human_review=false","knowledge_version='stale'","knowledge_hash='stale'","audience='public'","status='review'"]){
    const db=await fixture(),nonce=await service(db,reserve);await sql(db,'update private_support_email.drafts set '+update);assert.equal(await service(db,start(nonce)),'f');assert.equal(await service(db,reserve),'');
  }
  const db=await fixture();await sql(db,"update private_support_email.drafts set body='not approved'");assert.equal(await service(db,reserve),'');
  const good=await fixture(),nonce=await service(good,reserve);assert.equal(await service(good,start('12345678-1234-4234-8234-123456789abc')),'f');assert.equal(await service(good,start(nonce).replace(wire,'f'.repeat(64))),'f');
});
