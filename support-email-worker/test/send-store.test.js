'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSendStore,validateSendDraft}=require('../src/send-store');
const {DRAFT}=require('../src/send-config'),{QA}=require('../src/qa-config');
const nonce='12345678-1234-4234-8234-123456789abc',record={fingerprint:'a'.repeat(64),threadId:'abc123'},wireHash='b'.repeat(64);
const duplicate={id:DRAFT,status:'draft',body:null,audience:'client',human_review:true,knowledge_version:null,knowledge_hash:null,body_expires_at:null,thread_key:null,message_key:null,gmail_key:null,has_intent:true};
async function harness(run,response=true){const old=global.fetch,calls=[];
  global.fetch=async(url,options)=>{calls.push({url,options});assert.ok(url.startsWith(QA+'/rest/v1/rpc/'));assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-service');
    if(response instanceof Error)throw response;return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});};
  try{return {result:await run(createSendStore('synthetic-service',Date.now()+180000)),calls};}finally{global.fetch=old;}}
test('existing intent blocks even purged/expired body, with no hash or knowledge bypass to a send',()=>{assert.deepEqual(validateSendDraft(duplicate,{}),{duplicate:true});});
test('wrong id/extra keys and unapproved body fail closed',()=>{
  for(const d of [{...duplicate,id:nonce},{...duplicate,extra:true},{...duplicate,has_intent:false,body:'unapproved text',body_expires_at:new Date(Date.now()+3600000).toISOString()}])assert.throws(()=>validateSendDraft(d,{}),/SEND_STORE/);
});
test('read uses pinned draft id only',async()=>{const r=await harness(s=>s.read({}),duplicate);assert.deepEqual(r.result,{duplicate:true});assert.deepEqual(JSON.parse(r.calls[0].options.body),{p_id:DRAFT});});
test('reserve pins id, proof and wire; conflict is null not retry',async()=>{
  const r=await harness(s=>s.reserve(record,wireHash),nonce);assert.equal(r.result,nonce);assert.equal(r.calls.length,1);
  assert.deepEqual(JSON.parse(r.calls[0].options.body),{p_id:DRAFT,p_fingerprint:record.fingerprint,p_thread_id:record.threadId,p_wire_hash:wireHash});
  assert.equal((await harness(s=>s.reserve(record,wireHash),null)).result,null);
});
test('invalid reserve input or non-v4 response stops',async()=>{
  await assert.rejects(harness(s=>s.reserve({...record,fingerprint:'invalid'},wireHash)),/SEND_STORE/);
  await assert.rejects(harness(s=>s.reserve(record,wireHash),'12345678-1234-1234-8234-123456789abc'),/SEND_STORE/);
});
test('state transitions require true; no retry for ambiguous response',async()=>{
  for(const fn of [s=>s.start(nonce,record,wireHash),s=>s.cancel(nonce),s=>s.finish(nonce,'accepted',{id:'def456',threadId:'abc123'}),s=>s.finish(nonce,'unknown')]){
    assert.equal((await harness(fn)).calls.length,1);await assert.rejects(harness(fn,false),/SEND_STORE/);await assert.rejects(harness(fn,new Error('ambiguous')));
  }
});
test('unknown stores no result IDs',async()=>{const r=await harness(s=>s.finish(nonce,'unknown',{id:'def456',threadId:'abc123'}));const body=JSON.parse(r.calls[0].options.body);assert.equal(body.p_gmail_id,null);assert.equal(body.p_thread_id,null);});
test('deadline prevents fetch; accepted result is strict',async()=>{
  await assert.rejects(createSendStore('synthetic-service',Date.now()).read({}),/SEND_STORE/);
  await assert.rejects(harness(s=>s.finish(nonce,'accepted',{id:'unsafe',threadId:'abc123'})),/SEND_STORE/);
});
