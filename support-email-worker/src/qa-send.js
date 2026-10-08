'use strict';
// Closed one owner-attended send; no dependencies/options/paths supplied by callers.
const {createHash}=require('node:crypto');
const {loadSendConfig}=require('./send-config');
const {MAILBOX,OWNER}=require('./qa-config');
const {createSendStore}=require('./send-store');
const {createSendOAuth}=require('./send-oauth');
const {refreshSendReadonly}=require('./send-readonly-refresh');
const {readKnowledgeFiles}=require('../../src/lib/supportVoiceKnowledge');
const {SIGNOFF,validateDraft}=require('../../src/lib/supportEmailPolicy');
const {readVerifiedInitial,inspectVerified}=require('./verified-gmail');
const {listOwnerMessages}=require('./qa-list');
const {boundedJson,hex}=require('./gmail-read');
const {readJson}=require('./qa-store');
const {buildQaMime,verifyQaSent}=require('./qa-mime');
const fail=()=>{throw Error('SUPPORT_EMAIL_SEND_HALTED');};
function same(a,b){return b.senderVerified===true&&b.sender===OWNER&&['fingerprint','sender','text','subject','threadKey','messageKey','gmailKey','gmailId','threadId','rfcMessageId'].every(k=>a[k]===b[k]);}
function validateList(value){if(!value||value.nextPageToken||(value.messages!==undefined&&!Array.isArray(value.messages)))fail();
  const ids=(value.messages||[]).map(m=>m?.id);if(ids.length>25||ids.some(id=>!hex(id))||new Set(ids).size!==ids.length)fail();return ids;}
async function runQaSend(){
  if(arguments.length)fail();const deadline=Date.now()+180000,initial=loadSendConfig('send');
  function check(reserve=0){if(Date.now()+reserve>=deadline||loadSendConfig('send').binding!==initial.binding)fail();}
  const knowledge=readKnowledgeFiles(),store=createSendStore(initial.env.SUPABASE_SERVICE_ROLE_KEY,deadline),draft=await store.read(knowledge);check();
  if(draft.duplicate)return Object.freeze({status:'duplicate_no_send'});
  if(!draft.body.endsWith(SIGNOFF)||validateDraft({answer:draft.body.slice(0,-SIGNOFF.length),human_review:true}).body!==draft.body)fail();
  const readAuth=await refreshSendReadonly(initial.readClient,initial.readGrant.refreshToken);check(120000);
  if(readAuth.mailbox!==MAILBOX||(readAuth.refreshToken&&readAuth.refreshToken!==initial.readGrant.refreshToken)||readAuth.expiresAt<deadline+60000)fail();
  const ids=validateList(await listOwnerMessages({accessToken:readAuth.accessToken,cutoverMs:initial.env.cutoverMs,deadline}));
  let record;
  for(const id of ids){check(105000);const proof=await readVerifiedInitial({accessToken:readAuth.accessToken,id,cutoverMs:initial.env.cutoverMs,baselineHistoryId:initial.readGrant.baselineHistoryId});
    if(!proof.eligible)continue;const value=inspectVerified(proof);
    if(value.threadKey===draft.thread_key&&value.messageKey===draft.message_key&&value.gmailKey===draft.gmail_key){if(record||!value.senderVerified||value.sender!==OWNER)fail();record=value;}}
  if(!record)fail();check(85000);
  const sendAuth=await createSendOAuth({client:initial.sendClient}).refresh(initial.sendGrant.refreshToken);check(55000);
  if(sendAuth.mailbox!==MAILBOX||sendAuth.expiresAt<deadline+60000)fail();
  const wire=buildQaMime(record,draft.body),wireHash=createHash('sha256').update(wire.raw).digest('hex');let nonce,started=false,finishAttempted=false;
  async function fresh(){check(15000);const proof=await readVerifiedInitial({accessToken:readAuth.accessToken,id:record.gmailId,cutoverMs:initial.env.cutoverMs,baselineHistoryId:initial.readGrant.baselineHistoryId});
    if(!proof.eligible||!same(record,inspectVerified(proof)))fail();check();const current=readKnowledgeFiles();if(current.hash!==knowledge.hash||current.version!==knowledge.version)fail();}
  try{
    await fresh();check(80000);nonce=await store.reserve(record,wireHash);if(nonce===null)return Object.freeze({status:'duplicate_no_send'});
    await fresh();check(55000);await store.start(nonce,record,wireHash);started=true;check(40000);
    // Exactly ONE POST. No retry, redirect, callback-selected endpoint or readonly token.
    const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+sendAuth.accessToken,'Content-Type':'application/json'},body:JSON.stringify({raw:wire.raw.toString('base64url'),threadId:wire.threadId})});
    if(response.status!==200||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))fail();
    const result=await readJson(response);if(!hex(result.id)||result.threadId!==wire.threadId)fail();check(15000);
    const readDeadline=Math.min(deadline-10000,Date.now()+10000),profile=await boundedJson('profile',readAuth.accessToken,readDeadline);
    if(profile.emailAddress!==MAILBOX)fail();
    const envelope=await boundedJson('messages/'+result.id+'?format=raw',readAuth.accessToken,readDeadline);
    const thread=await boundedJson('threads/'+wire.threadId+'?format=minimal',readAuth.accessToken,readDeadline);
    verifyQaSent(envelope,result,wire,thread);check(10000);finishAttempted=true;await store.finish(nonce,'accepted',result);
    return Object.freeze({status:'sent_copy_verified_owner_receipt_pending'});
  }catch(_){
    // Ambiguous finish is never retried. A lost start response might have already
    // committed submitting; cancel CAS then fails, preserving its tombstone.
    if(nonce&&!finishAttempted){try{check(10000);await(started?store.finish(nonce,'unknown'):store.cancel(nonce));}catch(_){/* Hold permanent intent; never resume. */}}
    fail();
  }finally{wire.raw.fill(0);}
}
module.exports={runQaSend,same};
