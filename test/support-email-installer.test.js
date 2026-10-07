const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CLIENT, PROJECT, HOST, ORIGIN, loadClient, prepareStore, storeGrant, createInstaller, listenInstaller } = require('../src/lib/supportEmailInstaller');
const { REDIRECT } = require('../src/lib/supportEmailOAuth');
const { READONLY_SCOPE } = require('../src/lib/supportEmailAdapters');
const env = () => ({ SUPPORT_EMAIL_CONNECTION_APPROVED: 'true', SUPPORT_EMAIL_OAUTH_ENABLED: 'true', SUPPORT_EMAIL_ENABLED: 'false', SUPPORT_EMAIL_MODE: 'qa-draft',
  SUPPORT_EMAIL_ENVIRONMENT: 'qa', SUPABASE_URL: 'https://yjjxzxoghlpguquknyso.supabase.co', SUPPORT_EMAIL_MAILBOX: 'alphy@alphasourceai.com' });
const client = { clientId: CLIENT, clientSecret: 'synthetic-client-secret-never-real' };
const jsonClient = () => ({ web: { client_id: CLIENT, client_secret: client.clientSecret, project_id: PROJECT,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth', auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: [REDIRECT] } });
const grant = () => ({ refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access', baselineHistoryId: '12345',
  mailbox: env().SUPPORT_EMAIL_MAILBOX, scope: READONLY_SCOPE, expiresAt: Date.now() + 3599000 });
function temp(t) {
  // realpath is required on macOS where /var is an alias of /private/var.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'alphy-installer-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function file(t, data = jsonClient(), mode = 0o600) {
  const filename = path.join(temp(t), 'client.json');
  fs.writeFileSync(filename, JSON.stringify(data), { mode }); return filename;
}
test('read only exact pinned owner-only client without exposing the secret', t => assert.deepEqual(loadClient(file(t), env()), client));
for (const variant of ['project', 'client', 'installed', 'token', 'auth', 'cert','extra-top','extra-client','redirect', 'origins', 'secret', 'mode', 'oversize', 'symlink', 'hardlink']) {
  test(`reject client ${variant}`, t => {
    const data = jsonClient();
    if (variant === 'project') data.web.project_id = 'another-project';
    if (variant === 'client') data.web.client_id = '123456-unrelated.apps.googleusercontent.com';
    if (variant === 'installed') data.installed = {};
    if (variant === 'token') data.web.token_uri = 'https://example.invalid/token';
    if (variant === 'auth') data.web.auth_uri = 'https://example.invalid/auth';
    if (variant === 'cert') data.web.auth_provider_x509_cert_url = 'https://example.invalid/certs';
    if (variant === 'extra-top') data.extra = {};
    if (variant === 'extra-client') data.web.extra = 'no';
    if (variant === 'redirect') data.web.redirect_uris.push('http://localhost:43871/oauth/callback');
    if (variant === 'origins') data.web.javascript_origins = ['https://example.invalid'];
    if (variant === 'secret') data.web.client_secret = 'short';
    const filename = file(t, data, variant === 'mode' ? 0o644 : 0o600);
    if (variant === 'oversize') fs.appendFileSync(filename, ' '.repeat(8193));
    if (variant === 'hardlink') fs.linkSync(filename, filename + '.link');
    let target = filename;
    if (variant === 'symlink') { target += '.link'; fs.symlinkSync(filename, target); }
    assert.throws(() => loadClient(target, env()), e => e.message === 'SUPPORT_EMAIL_INSTALLER_CONFIG');
  });
}
test('reject symlink and writable client ancestor', t => {
  const dir = temp(t), real = path.join(dir, 'real'); fs.mkdirSync(real, {mode:0o700});
  const filename = path.join(real, 'client.json'); fs.writeFileSync(filename,JSON.stringify(jsonClient()),{mode:0o600});
  fs.symlinkSync(real,path.join(dir,'alias')); assert.throws(()=>loadClient(path.join(dir,'alias/client.json'),env()),/CONFIG/);
  fs.chmodSync(real,0o777); assert.throws(()=>loadClient(filename,env()),/CONFIG/);
});
for (const [key,value] of [['SUPPORT_EMAIL_CONNECTION_APPROVED',undefined],['SUPPORT_EMAIL_ENABLED','true'],['SUPPORT_EMAIL_ENABLED',undefined],['SUPPORT_EMAIL_OAUTH_ENABLED','false'],
  ['SUPPORT_EMAIL_ENVIRONMENT','production'],['SUPPORT_EMAIL_MODE','send'],['SUPPORT_EMAIL_MAILBOX','jason@alphasourceai.com'],
  ['SUPABASE_URL','https://rytlclkkcvvnkoncfaid.supabase.co']]) test(`installer initial gate ${key} ${value}`,()=>{
    assert.throws(()=>createInstaller({env:{...env(),[key]:value},client,destination:'/not-used'}),/CONFIG/);
  });
test('store refresh only in exclusive owner-only file with baseline and fixed metadata', t => {
  const destination = path.join(temp(t),'grant-dir/grant.json');
  storeGrant(destination,grant(),env());
  const s = fs.statSync(destination), d = fs.statSync(path.dirname(destination)), saved = JSON.parse(fs.readFileSync(destination,'utf8'));
  assert.equal(s.mode & 0o777,0o600);assert.equal(s.nlink,1);assert.equal(s.uid,process.getuid());assert.equal(d.mode & 0o777,0o700);
  assert.equal(saved.refreshToken,'synthetic-refresh');assert.equal(saved.clientId,CLIENT);assert.equal(saved.baselineHistoryId,'12345');
  assert.equal(saved.accessToken,undefined);assert.equal(saved.expiresAt,undefined);assert.ok(!fs.readFileSync(destination,'utf8').includes('synthetic-access'));
  assert.match(saved.capturedAt,/^\d{4}-/);assert.equal(saved.accessTokenExpiresAt> Date.now(),true);assert.deepEqual(fs.readdirSync(path.dirname(destination)),['grant.json']);
  assert.deepEqual(Object.keys(saved).sort(),['clientId','mailbox','scope','refreshToken','baselineHistoryId','capturedAt','accessTokenExpiresAt'].sort());
  assert.throws(()=>storeGrant(destination,{...grant(),refreshToken:'replacement'},env()),/CONFIG/);
  assert.equal(JSON.parse(fs.readFileSync(destination,'utf8')).refreshToken,'synthetic-refresh');
});
for (const variant of ['symlink','hardlink','dangling','broad-dir','relative','expired','wrong-mailbox','wrong-scope']) test(`store rejects ${variant}`, t=>{
  const dir=temp(t),folder=path.join(dir,'store');fs.mkdirSync(folder,{mode:0o700});let destination=path.join(folder,'grant.json');
  const g=grant();
  if(variant==='symlink'||variant==='hardlink'){const original=path.join(dir,'existing');fs.writeFileSync(original,'original',{mode:0o600});fs[variant==='symlink'?'symlinkSync':'linkSync'](original,destination);}
  if(variant==='dangling')fs.symlinkSync(path.join(dir,'absent'),destination);
  if(variant==='broad-dir')fs.chmodSync(folder,0o755);
  if(variant==='relative')destination='relative/grant.json';
  if(variant==='expired')g.expiresAt=1;
  if(variant==='wrong-mailbox')g.mailbox='jason@alphasourceai.com';
  if(variant==='wrong-scope')g.scope='https://www.googleapis.com/auth/gmail.send';
  assert.throws(()=>storeGrant(destination,g,env()),/CONFIG/);
});

function harness(overrides={}) {
  let time=Date.now();const currentEnv=env(),calls=[],saves=[];
  const i=createInstaller({env:currentEnv,client,destination:'/synthetic-not-written',now:()=>time,
    save:(...args)=>{if(overrides.storage){const e=new Error('synthetic-refresh must not leak');e.committed=!!overrides.committed;throw e;}saves.push(args);},
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      if(url.endsWith('/revoke'))return new Response('',{status:overrides.revokeFailed?500:200});
      if(overrides.delay)await overrides.delay();
      if(url.endsWith('/profile') && overrides.afterProfile) overrides.afterProfile(currentEnv,ms=>{time+=ms;});
      const value=url.endsWith('/token')?{access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:3600,scope:READONLY_SCOPE}:
        url.includes('/tokeninfo?')?{aud:CLIENT,azp:CLIENT,scope:READONLY_SCOPE,expires_in:'3599',exp:String(Math.floor(time/1000)+3599)}:
        {emailAddress:overrides.wrongMailbox?'jason@alphasourceai.com':env().SUPPORT_EMAIL_MAILBOX,historyId:'12345'};
      return new Response(JSON.stringify(value));
    }});
  const request=(method,url,h={},body='')=>i.handle({method,url,headers:{host:HOST,...h},body});
  async function start(){const r=await request('GET',new URL(i.bootstrapUrl).pathname,{'sec-fetch-site':'none'});
    const cookie=r.headers['Set-Cookie'].split(';')[0],csrf=r.body.match(/name="csrf" value="([^"]+)"/)[1];return{cookie,csrf,r};}
  async function authorize(){const s=await start();const r=await request('POST','/oauth/connect',{cookie:s.cookie,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},'csrf='+s.csrf);
    return{...s,auth:r,state:new URL(r.headers.Location).searchParams.get('state')};}
  return{i,request,start,authorize,calls,saves,currentEnv,advance:ms=>{time+=ms;}};
}
test('local connect form has cookie and restrictive headers, bootstrap is one-use',async()=>{
  const h=harness(),s=await h.start();assert.equal(s.r.status,200);
  assert.match(s.r.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Lax; Path=\/oauth/);assert.equal(s.r.headers['Cache-Control'],'no-store');assert.equal(s.r.headers['Referrer-Policy'],'no-referrer');
  assert.match(s.r.headers['Content-Security-Policy'],/frame-ancestors 'none'/);
  assert.equal((await h.request('GET',new URL(h.i.bootstrapUrl).pathname)).status,403);assert.equal(h.calls.length,0);
});
for(const variant of ['host','cross-site','origin','absolute','oversize','query','method'])test(`bootstrap rejects ${variant} without consuming session`,async()=>{
  const h=harness(),url=new URL(h.i.bootstrapUrl).pathname;
  const r=await h.request(variant==='method'?'POST':'GET',variant==='absolute'?h.i.bootstrapUrl:variant==='oversize'?'/'+ 'a'.repeat(8192):variant==='query'?url+'?extra=1':url,
    variant==='host'?{host:'evil.invalid:43871'}:variant==='origin'?{origin:'https://evil.invalid'}:variant==='cross-site'?{'sec-fetch-site':'cross-site'}:{});
  assert.equal(r.status,403);assert.equal((await h.start()).r.status,200);assert.equal(h.calls.length,0);
});
for(const variant of ['no-cookie','duplicate-cookie','wrong-origin','no-origin','wrong-csrf','duplicate-csrf','extra-field','oversize','wrong-type'])test(`authorize rejects ${variant}`,async()=>{
  const h=harness(),s=await h.start(),headers={cookie:s.cookie,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'};let body='csrf='+s.csrf;
  if(variant==='no-cookie')delete headers.cookie;if(variant==='duplicate-cookie')headers.cookie+='; '+s.cookie;
  if(variant==='wrong-origin')headers.origin='https://evil.invalid';if(variant==='no-origin')delete headers.origin;
  if(variant==='wrong-csrf')body='csrf='+ 'x'.repeat(43);if(variant==='duplicate-csrf')body+='&'+body;
  if(variant==='extra-field')body+='&extra=1';if(variant==='oversize')body+='a'.repeat(256);if(variant==='wrong-type')headers['content-type']='application/json';
  assert.equal((await h.request('POST','/oauth/connect',headers,body)).status,403);assert.equal(h.calls.length,0);
});
test('single callback stores verified QA grant with no credential in response',async()=>{
  const h=harness(),s=await h.authorize();assert.equal(s.auth.status,303);assert.equal(new URL(s.auth.headers.Location).searchParams.get('scope'),READONLY_SCOPE);
  const url='/oauth/callback?state='+s.state+'&code=synthetic-code&scope='+encodeURIComponent(READONLY_SCOPE)+'&authuser=2&prompt=consent&iss=https%3A%2F%2Faccounts.google.com';
  const r=await h.request('GET',url,{cookie:s.cookie});assert.equal(r.terminal,'CONNECTED');assert.equal(h.saves.length,1);assert.equal(h.saves[0][1].mailbox,env().SUPPORT_EMAIL_MAILBOX);
  const exposed=JSON.stringify(r);for(const value of ['synthetic-refresh','synthetic-access','synthetic-code',s.state,client.clientSecret])assert.equal(exposed.includes(value),false);
  assert.equal((await h.request('GET',url,{cookie:s.cookie})).status,403);assert.equal(h.calls.filter(c=>c.url.endsWith('/token')).length,1);
});
for(const variant of ['no-cookie','duplicate-state','unknown-key','both-code-error','missing-state','wrong-method','wrong-iss'])test(`callback rejects ${variant} without exchange`,async()=>{
  const h=harness(),s=await h.authorize();let url='/oauth/callback?state='+s.state+'&code=synthetic-code';
  if(variant==='duplicate-state')url+='&state='+s.state;if(variant==='unknown-key')url+='&token=secret';if(variant==='both-code-error')url+='&error=access_denied';
  if(variant==='missing-state')url='/oauth/callback?code=synthetic-code';
  if(variant==='wrong-iss')url+='&iss=https://evil.invalid';
  const r=await h.request(variant==='wrong-method'?'POST':'GET',url,variant==='no-cookie'?{}:{cookie:s.cookie});
  assert.equal(r.status,['no-cookie','wrong-method'].includes(variant)?403:400);assert.equal(h.calls.length,0);assert.equal(h.saves.length,0);
  if(!['no-cookie','wrong-method'].includes(variant))assert.equal(r.terminal,'FAILED');
});
for(const at of ['before-begin','before-callback','expiry'])test(`runtime gate checked ${at}`,async()=>{
  const h=harness();let s;
  if(at==='before-begin'){s=await h.start();h.currentEnv.SUPPORT_EMAIL_ENABLED='true';assert.equal((await h.request('POST','/oauth/connect',{cookie:s.cookie,origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},'csrf='+s.csrf)).terminal,'CONFIG_CHANGED');}
  else{s=await h.authorize();if(at==='expiry')h.advance(300000);else h.currentEnv.SUPPORT_EMAIL_ENVIRONMENT='production';const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});assert.equal(r.terminal,at==='expiry'?'EXPIRED':'CONFIG_CHANGED');}
  assert.equal(h.calls.length,0);assert.equal(h.saves.length,0);
});
for(const variant of ['gate','expiry'])test(`change during grant ${variant} revokes issued grant without storing`,async()=>{
  const h=harness({afterProfile:(env,advance)=>{if(variant==='gate')env.SUPPORT_EMAIL_ENABLED='true';else advance(300000);}}),s=await h.authorize();
  const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});
  assert.equal(r.terminal,'FAILED');assert.equal(h.saves.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,1);
});
for(const variant of ['storage','revokeFailed','wrongMailbox'])test(`callback failure ${variant} never stores or leaks credentials`,async()=>{
  const h=harness({storage:variant!=='wrongMailbox',revokeFailed:variant==='revokeFailed',wrongMailbox:variant==='wrongMailbox'}),s=await h.authorize();
  const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});
  assert.equal(r.terminal,variant==='revokeFailed'?'REVOKE_UNCONFIRMED':'FAILED');assert.equal(h.saves.length,0);assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,1);
  assert.equal(JSON.stringify(r).includes('synthetic'),false);
});
test('concurrent callbacks never duplicate exchange or store',async()=>{
  const h=harness(),s=await h.authorize(),url='/oauth/callback?state='+s.state+'&code=synthetic-code';
  const r=await Promise.all([h.request('GET',url,{cookie:s.cookie}),h.request('GET',url,{cookie:s.cookie})]);
  assert.equal(r.filter(v=>v.terminal==='CONNECTED').length,1);assert.equal(h.saves.length,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/token')).length,1);
});
test('committed storage cleanup failure does not revoke or erase the committed grant',async()=>{
  const h=harness({storage:true,committed:true}),s=await h.authorize();
  const r=await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie});
  assert.equal(r.terminal,'FAILED');assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,0);
});
test('favicon and wrong path do not consume an authorized attempt',async()=>{
  const h=harness(),s=await h.authorize();
  for(const url of ['/favicon.ico','/wrong?state='+s.state+'&code=synthetic-code'])assert.equal((await h.request('GET',url,{cookie:s.cookie})).status,403);
  assert.equal(h.calls.length,0);assert.equal((await h.request('GET','/oauth/callback?state='+s.state+'&code=synthetic-code',{cookie:s.cookie})).terminal,'CONNECTED');
});
test('listener binds only fixed IPv4 loopback, no external request',async t=>{
  const h=harness(),listener=await listenInstaller(h.i);t.after(()=>listener.close());assert.deepEqual(listener.address,{address:'127.0.0.1',family:'IPv4',port:43871});
  const r=await fetch(h.i.bootstrapUrl);assert.equal(r.status,200);assert.match(await r.text(),/No sending or automatic processing/);assert.equal(h.calls.length,0);
  listener.close();assert.equal(await listener.done,'CLOSED');
});
test('listener collision fails generically and does not leave a timer',async t=>{
  const first=await listenInstaller(harness().i);t.after(()=>first.close());
  await assert.rejects(listenInstaller(harness().i),e=>e.message==='SUPPORT_EMAIL_INSTALLER_LISTEN');first.close();
});
