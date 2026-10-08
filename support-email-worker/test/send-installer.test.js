'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSendInstaller,listenSendInstaller,HOST,ORIGIN}=require('../src/send-installer');
const {CLIENT,SCOPE}=require('../src/send-oauth');
function harness(change={}){
  let time=Date.now(),changed=false;const calls=[],saves=[],initial={binding:'fixed',sendClient:{clientId:CLIENT,clientSecret:'synthetic-send-client-secret'}};
  const i=createSendInstaller({initial,load:()=>({...initial,binding:changed?'changed':'fixed'}),now:()=>time,save:(...args)=>{if(change.storage){const e=Error('not logged');e.committed=!!change.committed;throw e;}saves.push(args);},fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url.endsWith('/revoke'))return new Response('',{status:200});
    const value=url.endsWith('/token')?{access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600,scope:SCOPE}:url.includes('/tokeninfo?')?{aud:CLIENT,azp:CLIENT,scope:SCOPE,exp:String(Math.floor(time/1000)+3599),expires_in:'3599'}:{email:'alphy@alphasourceai.com',verified_email:true};
    if(url.endsWith('/userinfo')&&change.offDuringGrant)changed=true;
    return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  }});
  const request=(method,url,headers={},body='')=>i.handle({method,url,headers:{host:HOST,...headers},body});
  async function start(){const r=await request('GET',new URL(i.bootstrapUrl).pathname);return{r,cookie:r.headers['Set-Cookie'].split(';')[0],csrf:r.body.match(/name="csrf" value="([^"]+)"/)[1]};}
  async function auth(){const s=await start(),r=await request('POST','/oauth/connect',{cookie:s.cookie,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},'csrf='+s.csrf),url=new URL(r.body.match(/href="([^"]+)"/)[1].replace(/&amp;/g,'&'));
    return{...s,state:url.searchParams.get('state'),url};}
  return{i,calls,saves,request,start,auth,change:()=>{changed=true;},expire:()=>{time+=300000;}};
}
test('separate one-use bootstrap, CSRF and exact-scope authorization, single committed grant',async()=>{
  const h=harness(),s=await h.auth();assert.equal(s.url.searchParams.get('scope'),SCOPE);assert.match(s.r.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax/);
  const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});assert.equal(r.terminal,'CONNECTED');assert.equal(h.saves.length,1);
  assert.equal(JSON.stringify(r).includes('synthetic'),false);assert.equal((await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie})).status,403);
});
for(const variant of ['cookie','origin','csrf','extra','host','method'])test('connect rejects '+variant+' without provider call',async()=>{
  const h=harness(),s=await h.start(),headers={cookie:s.cookie,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'};let body='csrf='+s.csrf;
  if(variant==='cookie')delete headers.cookie;if(variant==='origin')headers.origin='https://evil.invalid';if(variant==='csrf')body='csrf='+ 'x'.repeat(43);if(variant==='extra')body+='&extra=1';if(variant==='host')headers.host='evil.invalid';
  assert.equal((await h.request(variant==='method'?'GET':'POST','/oauth/connect',headers,body)).status,403);assert.equal(h.calls.length,0);
});
for(const variant of ['missing-state','duplicate-state','extra','wrong-iss','no-cookie'])test('callback rejects '+variant+' before exchange',async()=>{
  const h=harness(),s=await h.auth();let url='/oauth/callback?state='+s.state+'&code=synthetic-code';if(variant==='missing-state')url='/oauth/callback?code=synthetic-code';if(variant==='duplicate-state')url+='&state='+s.state;if(variant==='extra')url+='&token=secret';if(variant==='wrong-iss')url+='&iss=https://evil.invalid';
  const r=await h.request('GET',url,variant==='no-cookie'?{}:{cookie:s.cookie});assert.equal(r.status,variant==='no-cookie'?403:400);assert.equal(h.calls.length,0);
});
test('qualifying Chrome null Origin requires same-origin document and CSRF',async()=>{
  const h=harness(),s=await h.start();assert.equal((await h.request('POST','/oauth/connect',{cookie:s.cookie,origin:'null','sec-fetch-site':'same-origin','sec-fetch-mode':'navigate','sec-fetch-dest':'document','content-type':'application/x-www-form-urlencoded'},'csrf='+s.csrf)).status,200);
});
for(const change of [{storage:true},{offDuringGrant:true},{storage:true,committed:true}])test('post-grant failure cleanup respects exclusive commit',async()=>{
  const h=harness(change),s=await h.auth();const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});assert.equal(r.terminal,'FAILED');assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,change.committed?0:1);
});
test('gate change and expiry stop before exchange',async()=>{for(const variant of ['change','expire']){const h=harness(),s=await h.auth();h[variant]();const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});assert.equal(r.terminal,variant==='change'?'CONFIG_CHANGED':'EXPIRED');assert.equal(h.calls.length,0);}});
test('concurrent callbacks exchange once',async()=>{const h=harness(),s=await h.auth(),url='/oauth/callback?state='+s.state+'&code=synthetic-code';await Promise.all([h.request('GET',url,{cookie:s.cookie}),h.request('GET',url,{cookie:s.cookie})]);assert.equal(h.saves.length,1);});
test('listener binds only fixed loopback with no provider traffic',async t=>{const h=harness(),listener=await listenSendInstaller(h.i);t.after(()=>listener.close());assert.deepEqual(listener.address,{address:'127.0.0.1',family:'IPv4',port:43873});assert.equal((await fetch(h.i.bootstrapUrl)).status,200);listener.close();assert.equal(await listener.done,'CLOSED');assert.equal(h.calls.length,0);});
