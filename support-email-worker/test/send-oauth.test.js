'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CLIENT,REDIRECT,SCOPE,SCOPES,exactScopes,createSendOAuth}=require('../src/send-oauth');
function harness(change={}) {
  const calls=[],time=Date.now();
  const oauth=createSendOAuth({client:{clientId:CLIENT,clientSecret:'synthetic-new-send-client-secret'},now:()=>time,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/revoke'))return new Response('',{status:change.revokeFail?500:200});
    if(url.endsWith('/token'))return new Response(JSON.stringify({access_token:'synthetic-access-token',refresh_token:change.rotation?'different-synthetic-refresh':'new-synthetic-refresh',token_type:'Bearer',expires_in:3600,scope:change.tokenScope||SCOPE}),{headers:{'Content-Type':'application/json'}});
    if(url.includes('/tokeninfo?'))return new Response(JSON.stringify({aud:change.client||CLIENT,azp:CLIENT,scope:change.scope||SCOPE,exp:String(Math.floor(time/1000)+3599),expires_in:'3599'}),{headers:{'Content-Type':'application/json'}});
    assert.equal(url,'https://www.googleapis.com/oauth2/v2/userinfo');
    assert.equal(options.headers.Authorization,'Bearer synthetic-access-token');
    return new Response(JSON.stringify({email:change.mailbox||'alphy@alphasourceai.com',verified_email:change.unverified?false:true}),{headers:{'Content-Type':'application/json'}});
  }});
  const auth=new URL(oauth.begin());
  return {oauth,calls,auth,complete:()=>oauth.complete({state:auth.searchParams.get('state'),code:'synthetic-code'})};
}
test('three canonical scopes with only optional Google email alias; never broaden',()=>{
  assert.deepEqual(SCOPES,['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/userinfo.email','openid']);
  assert.equal(exactScopes([...SCOPES].reverse().join(' ')),true);
  assert.equal(exactScopes('email '+SCOPE),true);
  assert.equal(exactScopes(SCOPE+' email'),true);
  for(const scope of [SCOPE+' openid',SCOPE+' '+SCOPES[0],SCOPES[0],'https://mail.google.com/'])assert.equal(exactScopes(scope),false);
  for(const scope of [SCOPE+' email email',SCOPE.replace(SCOPES[1],'email'),SCOPE.replace('openid',''),SCOPE+' profile',SCOPE+' https://www.googleapis.com/auth/userinfo.profile',SCOPE+' https://www.googleapis.com/auth/gmail.compose',SCOPE+' https://www.googleapis.com/auth/gmail.modify',SCOPE+' https://www.googleapis.com/auth/drive'])assert.equal(exactScopes(scope),false);
});
test('actual Google email alias coexistence verifies and stores canonical scopes only',async()=>{
  const h=harness({tokenScope:SCOPE+' email',scope:'email '+SCOPE});const grant=await h.complete();
  assert.equal(grant.scope,SCOPE);assert.equal(grant.mailbox,'alphy@alphasourceai.com');assert.equal(h.calls.length,3);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,0);
});
test('authorization binds new client, sole loopback, PKCE, exact scopes, no accumulated grants',async()=>{
  const h=harness();assert.equal(h.auth.searchParams.get('client_id'),CLIENT);assert.equal(h.auth.searchParams.get('redirect_uri'),REDIRECT);
  assert.equal(h.auth.searchParams.get('scope'),SCOPE);assert.equal(h.auth.searchParams.get('include_granted_scopes'),'false');assert.equal(h.auth.searchParams.get('code_challenge_method'),'S256');
  const g=await h.complete();assert.equal(g.mailbox,'alphy@alphasourceai.com');assert.equal(g.scope,SCOPE);assert.equal(h.calls.length,3);
  await assert.rejects(h.complete(),/CALLBACK/);assert.equal(h.calls.length,3);
  h.oauth.committed(g.refreshToken);await assert.rejects(h.oauth.revokeUncommitted(g.refreshToken),/REVOKE_UNCONFIRMED/);assert.equal(h.calls.length,3);
});
for(const change of [{scope:SCOPE+' openid'},{scope:SCOPE+' profile'},{scope:SCOPE.replace(SCOPES[1],'email')},{tokenScope:SCOPE.replace('openid','')},{scope:SCOPES[0]},{tokenScope:SCOPE+' https://www.googleapis.com/auth/gmail.readonly'},{client:'wrong.apps.googleusercontent.com'},{mailbox:'jason@alphasourceai.com'},{unverified:true}])test('invalid NEW grant revokes only its new token',async()=>{
  const h=harness(change);await assert.rejects(h.complete());const revokes=h.calls.filter(c=>c.url.endsWith('/revoke'));assert.equal(revokes.length,1);assert.equal(new URLSearchParams(revokes[0].options.body).get('token'),'new-synthetic-refresh');
});
for(const change of [{scope:SCOPE+' openid'},{rotation:true},{mailbox:'other@example.invalid'}])test('committed refresh failure or rotation NEVER revokes/writes',async()=>{
  const h=harness(change);await assert.rejects(h.oauth.refresh('new-synthetic-refresh'));assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,0);
});
test('foreign token cannot be passed to cleanup',async()=>{const h=harness();await assert.rejects(h.oauth.revokeUncommitted('readonly-synthetic-refresh'));assert.equal(h.calls.length,0);});
test('state mismatch terminates without token exchange',async()=>{const h=harness();await assert.rejects(h.oauth.complete({state:'x'.repeat(43),code:'synthetic-code'}));assert.equal(h.calls.length,0);await assert.rejects(h.complete());});
test('new grant revoke failure is surfaced safely',async()=>{const h=harness({unverified:true,revokeFail:true});await assert.rejects(h.complete(),/REVOKE_UNCONFIRMED/);});
