'use strict';
const {QA}=require('./qa-config');
const {DRAFT,MD5,SHA256}=require('./send-config');
const {readJson}=require('./qa-store');
const {createHash}=require('node:crypto');
const fail=()=>{throw Error('SUPPORT_EMAIL_SEND_STORE');};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function validateSendDraft(draft,knowledge) {
  if(!draft||Object.keys(draft).sort().join(',')!=='audience,body,body_expires_at,gmail_key,has_intent,human_review,id,knowledge_hash,knowledge_version,message_key,status,thread_key'||
    draft.id!==DRAFT||typeof draft.has_intent!=='boolean')fail();
  // Any previous intent is terminal no-send, even after the body expires/purges.
  if(draft.has_intent)return Object.freeze({duplicate:true});
  if(draft.status!=='draft'||draft.human_review!==true||draft.audience!=='client'||typeof draft.body!=='string'||Buffer.byteLength(draft.body)>4500||
    !Number.isSafeInteger(Date.parse(draft.body_expires_at))||Date.parse(draft.body_expires_at)<=Date.now()+180000||
    ![draft.thread_key,draft.message_key,draft.gmail_key].every(hash)||draft.knowledge_version!==knowledge.version||draft.knowledge_hash!==knowledge.hash||
    createHash('md5').update(draft.body,'utf8').digest('hex')!==MD5||createHash('sha256').update(draft.body,'utf8').digest('hex')!==SHA256)fail();
  return Object.freeze(draft);
}
function createSendStore(token,deadline) {
  async function rpc(name,body) {
    if(Date.now()+10000>deadline)fail();
    const response=await fetch(QA+'/rest/v1/rpc/'+name,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{apikey:token,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))fail();return readJson(response);
  }
  return Object.freeze({
    async read(knowledge){return validateSendDraft(await rpc('read_support_email_send_draft',{p_id:DRAFT}),knowledge);},
    async reserve(record,wireHash){if(!hash(record.fingerprint)||!hash(wireHash)||!/^[a-f0-9]{1,40}$/.test(record.threadId||''))fail();
      const nonce=await rpc('reserve_support_email_send',{p_id:DRAFT,p_fingerprint:record.fingerprint,p_thread_id:record.threadId,p_wire_hash:wireHash});
      if(nonce!==null&&!uuid(nonce))fail();return nonce;},
    async start(nonce,record,wireHash){if(!uuid(nonce)||!hash(record.fingerprint)||!hash(wireHash))fail();
      const value=await rpc('start_support_email_send',{p_id:DRAFT,p_nonce:nonce,p_fingerprint:record.fingerprint,p_wire_hash:wireHash});if(value!==true)fail();},
    async cancel(nonce){if(!uuid(nonce))fail();if(await rpc('cancel_support_email_send',{p_id:DRAFT,p_nonce:nonce})!==true)fail();},
    async finish(nonce,status,result){if(!uuid(nonce)||!['accepted','unknown'].includes(status)||
      (status==='accepted'&&(!/^[a-f0-9]{1,40}$/.test(result?.id||'')||!/^[a-f0-9]{1,40}$/.test(result?.threadId||''))))fail();
      if(await rpc('finish_support_email_send',{p_id:DRAFT,p_nonce:nonce,p_status:status,p_gmail_id:status==='accepted'?result.id:null,p_thread_id:status==='accepted'?result.threadId:null})!==true)fail();},
  });
}
module.exports={validateSendDraft,createSendStore};
