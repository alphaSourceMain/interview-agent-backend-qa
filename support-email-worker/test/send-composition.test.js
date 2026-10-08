'use strict';
// Synthetic module replacements only: the closed CLI has no injection interface.
const test=require('node:test'),assert=require('node:assert/strict');
const {OWNER,MAILBOX}=require('../src/qa-config'),{SIGNOFF}=require('../../src/lib/supportEmailPolicy');
const record={sender:OWNER,senderVerified:true,text:'General test question',subject:'Owner QA test',fingerprint:'a'.repeat(64),threadKey:'b'.repeat(64),messageKey:'c'.repeat(64),gmailKey:'d'.repeat(64),gmailId:'abc123',threadId:'def456',rfcMessageId:'<synthetic@example.invalid>'};
async function harness(change={}){
  const events=[],finishes=[];let reads=0,changed=false,raw;const cfg={binding:'fixed',env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',cutoverMs:1},readClient:{},sendClient:{},readGrant:{refreshToken:'synthetic-read-refresh',baselineHistoryId:'1'},sendGrant:{refreshToken:'synthetic-send-refresh'}};
  const modules={
    '../src/send-config':{loadSendConfig(){events.push('config');return {...cfg,binding:changed?'changed':'fixed'};}},
    '../src/send-store':{createSendStore:()=>({
      async read(){events.push('read');return change.duplicate?{duplicate:true}:{body:'General guidance only.'+SIGNOFF,thread_key:record.threadKey,message_key:record.messageKey,gmail_key:record.gmailKey};},
      async reserve(){events.push('reserve');if(change.reserveError)throw Error('ambiguous');return change.reserveConflict?null:'synthetic-nonce';},
      async start(){events.push('start');if(change.startError)throw Error('ambiguous');if(change.offAtStart)changed=true;},
      async cancel(){events.push('cancel');},async finish(_nonce,state){events.push('finish-'+state);finishes.push(state);if(change.finishError)throw Error('ambiguous');},
    })},
    '../src/send-readonly-refresh':{async refreshSendReadonly(){events.push('read-refresh');return {accessToken:'synthetic-read-access',mailbox:MAILBOX,expiresAt:Date.now()+3600000};}},
    '../src/send-oauth':{createSendOAuth:()=>({async refresh(){events.push('send-refresh');return {accessToken:'synthetic-send-access',mailbox:change.mailbox?'wrong':MAILBOX,expiresAt:Date.now()+3600000};}})},
    '../../src/lib/supportVoiceKnowledge':{readKnowledgeFiles(){events.push('knowledge');return {hash:'e'.repeat(64),version:'test-version'};}},
    '../src/qa-list':{async listOwnerMessages(){events.push('list');return change.largeList?{nextPageToken:'more'}:{messages:[{id:record.gmailId}]};}},
    '../src/verified-gmail':{async readVerifiedInitial(){events.push('verify');reads++;return {eligible:!(change.replyAt===reads)};},inspectVerified(){return {...record,...(change.mismatchAt===reads?{fingerprint:'changed'}:{})};}},
    '../src/qa-mime':{buildQaMime(){events.push('mime');raw=Buffer.from('synthetic MIME');return {raw,threadId:record.threadId};},verifyQaSent(){events.push('verify-sent');if(change.sentMismatch)throw Error('mismatch');}},
    '../src/gmail-read':{hex:value=>typeof value==='string'&&/^[a-f0-9]+$/.test(value),async boundedJson(path){events.push('get-'+path.split('/')[0]);return path==='profile'?{emailAddress:MAILBOX}:{};}},
  };
  const saved=new Map(),target=require.resolve('../src/qa-send'),oldFetch=global.fetch;saved.set(target,require.cache[target]);delete require.cache[target];
  global.fetch=async(url,options)=>{events.push('send');assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');assert.equal(options.headers.Authorization,'Bearer synthetic-send-access');assert.equal(options.redirect,'error');
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),['raw','threadId']);if(change.sendError)throw Error('ambiguous');return new Response(JSON.stringify({id:'fed321',threadId:change.wrongThread?'bad':record.threadId}),{status:change.sendHttp?500:200,headers:{'Content-Type':'application/json'}});};
  try{for(const [name,exports]of Object.entries(modules)){const key=require.resolve(name);saved.set(key,require.cache[key]);require.cache[key]={id:key,filename:key,loaded:true,exports};}
    let result,error;try{result=await require(target).runQaSend();}catch(e){error=e.message;}return {result,error,events,finishes,raw};
  }finally{global.fetch=oldFetch;for(const[key,value]of saved){if(value)require.cache[key]=value;else delete require.cache[key];}}
}
test('one send only after two fresh proofs; accepted only after Sent proof and persistence',async()=>{
  const r=await harness();assert.equal(r.error,undefined);assert.equal(r.result.status,'sent_copy_verified_owner_receipt_pending');assert.equal(r.events.filter(x=>x==='send').length,1);
  assert.equal(r.events.filter(x=>x==='verify').length,3);assert.ok(r.events.indexOf('mime')<r.events.indexOf('reserve'));assert.ok(r.events.indexOf('start')<r.events.indexOf('send'));
  assert.ok(r.events.indexOf('verify-sent')<r.events.indexOf('finish-accepted'));assert.deepEqual(r.finishes,['accepted']);assert.ok(r.raw.every(x=>x===0));
});
test('existing intent does not authenticate, list, reserve or send',async()=>{const r=await harness({duplicate:true});assert.equal(r.result.status,'duplicate_no_send');assert.ok(!r.events.includes('read-refresh'));assert.ok(!r.events.includes('send'));});
test('conflicting concurrent reservation never submits',async()=>{const r=await harness({reserveConflict:true});assert.equal(r.result.status,'duplicate_no_send');assert.ok(!r.events.includes('start'));assert.ok(!r.events.includes('send'));});
for(const change of [{replyAt:1},{replyAt:2},{mismatchAt:2},{mailbox:true},{largeList:true},{reserveError:true}])test('pre-reservation '+Object.keys(change)[0]+' causes no send',async()=>{const r=await harness(change);assert.equal(r.error,'SUPPORT_EMAIL_SEND_HALTED');assert.ok(!r.events.includes('send'));assert.equal(r.finishes.length,0);});
for(const change of [{replyAt:3},{mismatchAt:3},{startError:true}])test('reserved failure cancels once and never sends',async()=>{const r=await harness(change);assert.equal(r.error,'SUPPORT_EMAIL_SEND_HALTED');assert.equal(r.events.filter(x=>x==='cancel').length,1);assert.ok(!r.events.includes('send'));});
for(const change of [{sendError:true},{sendHttp:true},{wrongThread:true},{sentMismatch:true}])test('ambiguous send/readback held unknown without second POST',async()=>{const r=await harness(change);assert.equal(r.error,'SUPPORT_EMAIL_SEND_HALTED');assert.equal(r.events.filter(x=>x==='send').length,1);assert.deepEqual(r.finishes,['unknown']);});
test('lost accepted persistence is never retried or rewritten unknown',async()=>{const r=await harness({finishError:true});assert.equal(r.events.filter(x=>x==='send').length,1);assert.deepEqual(r.finishes,['accepted']);assert.equal(r.error,'SUPPORT_EMAIL_SEND_HALTED');});
test('disabled config after start prevents POST and leaves permanent intent',async()=>{const r=await harness({offAtStart:true});assert.equal(r.error,'SUPPORT_EMAIL_SEND_HALTED');assert.ok(!r.events.includes('send'));assert.equal(r.finishes.length,0);});
