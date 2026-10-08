'use strict';
// Sender-specific readonly refresh. No revoke API; reviewed readonly connector
// stays unchanged, including its separate original failure-cleanup behavior.
const {CLIENT}=require('../../src/lib/supportEmailInstaller');
const {readJson}=require('./qa-store');
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const fail=()=>{throw Error('SUPPORT_EMAIL_SEND_READONLY');};
const value=v=>typeof v==='string'&&/^[\x21-\x7e]{1,8192}$/.test(v);
async function refreshSendReadonly(client,refreshToken){
  if(client?.clientId!==CLIENT||!value(client.clientSecret)||client.clientSecret.length<20||client.clientSecret.length>256||!value(refreshToken))fail();
  async function request(url,options={}){try{
    const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||''))fail();const result=await readJson(response);
    if(!result||typeof result!=='object'||Array.isArray(result))fail();return result;
  }catch(_){fail();}}
  const issuedAt=Date.now(),tokens=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:CLIENT,client_secret:client.clientSecret,grant_type:'refresh_token',refresh_token:refreshToken}).toString()});
  if(!value(tokens.access_token)||typeof tokens.token_type!=='string'||tokens.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(tokens.expires_in)||
    tokens.expires_in<1||tokens.expires_in>7200||(tokens.scope!==undefined&&tokens.scope!==SCOPE)||
    (tokens.refresh_token!==undefined&&tokens.refresh_token!==refreshToken))fail();
  const info=await request('https://oauth2.googleapis.com/tokeninfo?access_token='+encodeURIComponent(tokens.access_token));
  if(info.aud!==CLIENT||info.azp!==CLIENT||info.scope!==SCOPE||(info.audience!==undefined&&info.audience!==CLIENT)||(info.issued_to!==undefined&&info.issued_to!==CLIENT)||
    !/^\d{1,5}$/.test(String(info.expires_in))||Number(info.expires_in)<1||Number(info.expires_in)>7200||!/^\d{1,12}$/.test(String(info.exp))||
    Number(info.exp)*1000<=Date.now()||Number(info.exp)*1000>Date.now()+7200000)fail();
  const profile=await request('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:'Bearer '+tokens.access_token}});
  if(profile.emailAddress!=='alphy@alphasourceai.com'||typeof profile.historyId!=='string'||!/^\d{1,30}$/.test(profile.historyId))fail();
  return Object.freeze({accessToken:tokens.access_token,expiresAt:Math.min(issuedAt+tokens.expires_in*1000,Date.now()+Number(info.expires_in)*1000,Number(info.exp)*1000),mailbox:profile.emailAddress});
}
module.exports={refreshSendReadonly};
