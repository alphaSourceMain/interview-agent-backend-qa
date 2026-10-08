'use strict';
// Synthetic profile/destination/recipient proofs only: no production credentials.
const test = require('node:test'), assert = require('node:assert/strict');
const { getRuntimeProfile, assertRuntimeProfile, QA_PROFILE, safeExternalSender } = require('../src/runtime-profile');
const { validateRuntimeEnvironment, validateRuntimeKeys } = require('../src/runtime-config');
const { createRuntimeStore } = require('../src/runtime-store');
const { recognizeRuntimeClient } = require('../src/runtime-membership');
const { buildQaMime, verifyQaSent } = require('../src/qa-mime');
const { SIGNOFF } = require('../../src/lib/supportEmailPolicy');
const { sameRuntimeRecord } = require('../src/runtime-record');
const base = { RENDER:'true', RENDER_SERVICE_NAME:'alphascreen-alphy-mail-prod', RENDER_SERVICE_ID:'crn-'+'a'.repeat(20),
  SUPABASE_URL:'https://rytlclkkcvvnkoncfaid.supabase.co', SUPPORT_EMAIL_ENVIRONMENT:'production',
  SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'true', SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED:'true',
  SUPPORT_EMAIL_CUSTOMER_RESPONSES_APPROVED:'true', SUPPORT_EMAIL_OWNER_TEST_ONLY:'false',
  SUPPORT_EMAIL_OWNER_TEST_SENDER:'jason@gardner.ltd', SUPPORT_EMAIL_MAILBOX:'alphy@alphasourceai.com',
  SUPPORT_EMAIL_WORKER_ENABLED:'true', SUPPORT_EMAIL_WORKER_MODE:'production-auto',
  SUPPORT_EMAIL_WORKER_SEND_APPROVED:'true', SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED:'true', SUPPORT_EMAIL_SECRET_MOUNT_APPROVED:'true' };
const profile = getRuntimeProfile(base);
const owner = mode => ({ ...base, SUPPORT_EMAIL_WORKER_MODE:mode, SUPPORT_EMAIL_OWNER_TEST_ONLY:'true', SUPPORT_EMAIL_CUSTOMER_RESPONSES_APPROVED:'false' });
test('enabled runtime requires explicit selector; no forged profile allowed', () => {
  for(const env of [{},{SUPPORT_EMAIL_ENVIRONMENT:'unknown'},{...base,SUPPORT_EMAIL_ENVIRONMENT:undefined}]) assert.throws(()=>getRuntimeProfile(env));
  assert.equal(assertRuntimeProfile(profile),profile); assert.throws(()=>assertRuntimeProfile({...profile}));
});
test('master off ignores any bad production binding before profile/files/network', () => {
  assert.equal(validateRuntimeEnvironment({SUPPORT_EMAIL_WORKER_ENABLED:'false',SUPPORT_EMAIL_ENVIRONMENT:'unknown'}),null);
  assert.equal(validateRuntimeEnvironment({...base,SUPPORT_EMAIL_WORKER_ENABLED:'false',SUPABASE_URL:'https://bad.invalid'}),null);
});
test('production modes explicitly bind audience, no missing send flag downgrades auto', () => {
  assert.equal(validateRuntimeEnvironment(base).profile.ownerOnly,false);
  for(const mode of ['production-draft','production-canary']) {
    const config=validateRuntimeEnvironment(owner(mode)); assert.equal(config.profile.ownerOnly,true);
    assert.equal(config.mode,mode==='production-draft'?'qa-draft':'qa-owner-auto');
  }
  for(const key of ['SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED','SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED',
    'SUPPORT_EMAIL_CUSTOMER_RESPONSES_APPROVED','SUPPORT_EMAIL_WORKER_SEND_APPROVED','SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED'])
    for(const value of [undefined,'false']) assert.throws(()=>validateRuntimeEnvironment({...base,[key]:value}));
  for(const key of ['SUPPORT_EMAIL_WORKER_SEND_APPROVED','SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED'])
    assert.throws(()=>validateRuntimeEnvironment({...owner('production-canary'),[key]:undefined}));
});
test('service, DB, owner flags, mailbox and cross modes must match exact compiled profile', () => {
  for(const [key,value] of [['RENDER_SERVICE_NAME','alphascreen-alphy-mail-qa'],['SUPABASE_URL',QA_PROFILE.url],
    ['SUPPORT_EMAIL_WORKER_MODE','qa-owner-auto'],['SUPPORT_EMAIL_OWNER_TEST_ONLY','true'],['SUPPORT_EMAIL_OWNER_TEST_ONLY',undefined],
    ['SUPPORT_EMAIL_OWNER_TEST_SENDER','visitor@example.invalid'],['SUPPORT_EMAIL_MAILBOX','other@alphasourceai.com']])
    assert.throws(()=>validateRuntimeEnvironment({...base,[key]:value}));
  for(const mode of ['production-canary','production-draft'])
    assert.throws(()=>validateRuntimeEnvironment({...owner(mode),SUPPORT_EMAIL_OWNER_TEST_ONLY:'false'}));
  const qa={...base,RENDER_SERVICE_NAME:QA_PROFILE.name,SUPABASE_URL:QA_PROFILE.url,SUPPORT_EMAIL_ENVIRONMENT:'qa',
    SUPPORT_EMAIL_WORKER_MODE:'qa-owner-auto',SUPPORT_EMAIL_OWNER_TEST_ONLY:'true',SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'false'};
  assert.equal(validateRuntimeEnvironment(qa).profile,QA_PROFILE);
  for(const [key,value] of [['SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED','true'],['SUPPORT_EMAIL_OWNER_TEST_ONLY','false'],['SUPPORT_EMAIL_MAILBOX_RETIRED','true']])
    assert.throws(()=>validateRuntimeEnvironment({...qa,[key]:value}));
});
test('service-role JWT must match same profile; key never enters model data', () => {
  const token = ref => 'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role:'service_role',ref,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.synthetic';
  const keys = ref => ({supabaseServiceRoleKey:token(ref),xaiApiKey:'synthetic-api-key-1234567890'});
  assert.ok(validateRuntimeKeys(keys(profile.ref),profile));
  assert.throws(()=>validateRuntimeKeys(keys(QA_PROFILE.ref),profile));
  assert.throws(()=>validateRuntimeKeys(keys(profile.ref),QA_PROFILE));
});
test('customer sender canonical external only; reject controls/list/internal/bounce', () => {
  assert.equal(safeExternalSender('visitor@example.invalid'),true);
  for(const s of ['VISITOR@example.invalid','visitor@example.invalid\r\nBcc: x@y.invalid','a@b.invalid,c@d.invalid',
    'Name <visitor@example.invalid>','staff@alphasourceai.com','noreply@example.invalid','mailer-daemon@example.invalid','']) assert.equal(safeExternalSender(s),false);
});
test('fresh verified record binds all original details and keeps owner restriction in QA/canary', () => {
  const record={sender:'visitor@example.invalid',senderVerified:true,fingerprint:'a',text:'Static question',subject:'Synthetic',
    threadKey:'b',messageKey:'c',gmailKey:'d',gmailId:'123',threadId:'456',rfcMessageId:'<initial@example.invalid>'};
  assert.equal(sameRuntimeRecord(record,{...record},profile),true);
  for(const key of ['sender','fingerprint','text','subject','threadKey','messageKey','gmailKey','gmailId','threadId','rfcMessageId'])
    assert.equal(sameRuntimeRecord(record,{...record,[key]:'changed'},profile),false);
  assert.equal(sameRuntimeRecord(record,{...record,senderVerified:false},profile),false);
  for(const p of [QA_PROFILE,getRuntimeProfile(owner('production-canary'))]) assert.equal(sameRuntimeRecord(record,{...record},p),false);
});
test('same production object fixes RPC and membership destination; unknown is public, failures throw', async () => {
  const previous=global.fetch, requests=[];
  try {
    global.fetch=async(url,options)=>{requests.push({url,options});return Response.json(null);};
    assert.equal(await recognizeRuntimeClient('synthetic-key','visitor@example.invalid',Date.now()+60000,profile),false);
    assert.equal(await createRuntimeStore('synthetic-key',Date.now()+60000,'qa-owner-auto',profile).call('health'),null);
    assert.equal(requests.length,2);
    assert.equal(requests[0].url,profile.url+'/rest/v1/rpc/support_email_confirmed_user');
    assert.deepEqual(JSON.parse(requests[0].options.body),{p_email:'visitor@example.invalid'});
    assert.equal(requests[1].url,profile.url+'/rest/v1/rpc/support_email_qa_worker');
    global.fetch=async()=>Response.json({code:'PRIVATE'},{status:500});
    await assert.rejects(recognizeRuntimeClient('synthetic-key','visitor@example.invalid',Date.now()+60000,profile));
  } finally {global.fetch=previous;}
});
test('production MIME binds To only to verified record; readback rejects extra/rewritten recipients', () => {
  const record={sender:'visitor@example.invalid',senderVerified:true,gmailId:'123',threadId:'456',rfcMessageId:'<initial@example.invalid>',
    subject:'Synthetic',replyTo:'attacker@example.invalid',cc:'attacker@example.invalid'};
  const wire=buildQaMime(record,'Static product guidance.'+SIGNOFF,profile);
  assert.equal(wire.headers.to,record.sender); assert.ok(!/^(?:cc|bcc|reply-to):/im.test(wire.raw.toString()));
  const result={id:'789',threadId:'456'},thread={id:'456',messages:[{id:'123',threadId:'456'},{id:'789',threadId:'456'}]};
  const envelope=raw=>({id:'789',threadId:'456',historyId:'200',internalDate:String(Date.now()),labelIds:['SENT'],raw:Buffer.from(raw).toString('base64url')});
  assert.equal(verifyQaSent(envelope(wire.raw),result,wire,thread),true);
  for(const raw of [wire.raw.toString().replace('to: '+record.sender,'to: attacker@example.invalid'),'cc: attacker@example.invalid\r\n'+wire.raw])
    assert.throws(()=>verifyQaSent(envelope(raw),result,wire,thread));
  assert.throws(()=>buildQaMime({...record,senderVerified:false},'Static product guidance.'+SIGNOFF,profile));
  for(const p of [QA_PROFILE,getRuntimeProfile(owner('production-canary')),getRuntimeProfile(owner('production-draft'))])
    assert.throws(()=>buildQaMime(record,'Static product guidance.'+SIGNOFF,p));
  wire.raw.fill(0);
});
