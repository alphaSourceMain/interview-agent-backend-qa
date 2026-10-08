'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {refreshSendReadonly}=require('../src/send-readonly-refresh');
const {CLIENT}=require('../../src/lib/supportEmailInstaller');
const scope='https://www.googleapis.com/auth/gmail.readonly';
async function harness(change={}){
  const old=global.fetch,calls=[];
  global.fetch=async(url,options)=>{
    calls.push({url,options});assert.equal(options.redirect,'error');
    let value;
    if(url.endsWith('/token'))value={access_token:'synthetic-read-access',token_type:'Bearer',expires_in:3600,scope,...(change.rotation?{refresh_token:'rotated'}:{})};
    else if(url.includes('/tokeninfo?'))value={aud:CLIENT,azp:change.wrongClient?'wrong':CLIENT,scope:change.extraScope?scope+' openid':scope,exp:String(Math.floor(Date.now()/1000)+3599),expires_in:'3599'};
    else {assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/profile');assert.equal(options.headers.Authorization,'Bearer synthetic-read-access');value={emailAddress:change.wrongMailbox?'other@example.invalid':'alphy@alphasourceai.com',historyId:'100'};}
    if(change.transport)throw Error('SECRET TRANSPORT ERROR');
    return new Response(change.large?'x'.repeat(32769):JSON.stringify(value),{status:change.http?500:200,headers:{'Content-Type':'application/json'}});
  };
  try{return {result:await refreshSendReadonly({clientId:CLIENT,clientSecret:'synthetic-read-client-secret'},'synthetic-read-refresh'),calls};}
  catch(error){return {error:error.message,calls};}finally{global.fetch=old;}
}
test('sender readonly refresh checks original client/scope/mailbox without modifying committed grant',async()=>{
  const r=await harness();assert.equal(r.result.mailbox,'alphy@alphasourceai.com');assert.equal(r.calls.length,3);
  assert.ok(r.result.expiresAt>Date.now()+3500000);assert.equal(new URLSearchParams(r.calls[0].options.body).get('refresh_token'),'synthetic-read-refresh');
});
for(const name of ['rotation','wrongClient','extraScope','wrongMailbox','transport','http','large'])test(name+' never revokes either committed grant',async()=>{
  const r=await harness({[name]:true});assert.equal(r.error,'SUPPORT_EMAIL_SEND_READONLY');assert.ok(!r.calls.some(c=>c.url.includes('revoke')));
});
test('invalid readonly client stops without transport',async()=>{
  const old=global.fetch;global.fetch=()=>assert.fail('unexpected transport');
  try{await assert.rejects(refreshSendReadonly({clientId:'wrong',clientSecret:'synthetic-read-client-secret'},'synthetic-refresh'),/SEND_READONLY/);}finally{global.fetch=old;}
});
