const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSupportEmailOAuth, REDIRECT } = require('../src/lib/supportEmailOAuth');
const { READONLY_SCOPE } = require('../src/lib/supportEmailAdapters');
const { config } = require('../src/lib/supportEmailDrafts');
const fs = require('node:fs');
const path = require('node:path');
const env = { SUPPORT_EMAIL_OAUTH_ENABLED: 'true', SUPPORT_EMAIL_ENABLED: 'false', SUPPORT_EMAIL_MODE: 'qa-draft', SUPPORT_EMAIL_ENVIRONMENT: 'qa',
  SUPABASE_URL: 'https://yjjxzxoghlpguquknyso.supabase.co', SUPPORT_EMAIL_MAILBOX: 'alphy@alphasourceai.com', SUPPORT_EMAIL_GOOGLE_CLIENT_ID: '123456-synthetic.apps.googleusercontent.com',
  SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret-no-real-credential', SUPPORT_EMAIL_GOOGLE_REDIRECT_URI: REDIRECT };
function setup(overrides = {}) {
  let time = 1000000;
  const calls = [];
  const defaults = { token: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, scope: READONLY_SCOPE },
    info: { aud: env.SUPPORT_EMAIL_GOOGLE_CLIENT_ID, azp: env.SUPPORT_EMAIL_GOOGLE_CLIENT_ID, scope: READONLY_SCOPE, expires_in: '3599', exp: '4599' }, profile: { emailAddress: env.SUPPORT_EMAIL_MAILBOX, historyId: '1234' } };
  const oauth = createSupportEmailOAuth({ env, now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/revoke')) {
      if(overrides.revokeThrows)throw new Error('synthetic-refresh must not leak');
      return new Response(overrides.revokeBody || '', {status:overrides.revokeStatus || 200});
    }
    const kind = url.endsWith('/token') ? 'token' : url.includes('/tokeninfo?') ? 'info' : 'profile';
    if (overrides.throw) throw new Error('synthetic credential deliberately must not leak');
    return overrides.response || new Response(JSON.stringify(overrides[kind] || defaults[kind]));
  } });
  const start = () => new URL(oauth.begin());
  return { oauth, calls, defaults, start, advance: ms => { time += ms; } };
}
for (const [key, value] of [['SUPPORT_EMAIL_OAUTH_ENABLED', 'false'], ['SUPPORT_EMAIL_MODE', 'send'], ['SUPPORT_EMAIL_ENVIRONMENT', 'production'],
  ['SUPABASE_URL', 'https://rytlclkkcvvnkoncfaid.supabase.co'], ['SUPPORT_EMAIL_MAILBOX', 'jason@alphasourceai.com'], ['SUPPORT_EMAIL_GOOGLE_REDIRECT_URI', 'https://example.invalid/callback'],
  ['SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET', 'short'], ['SUPPORT_EMAIL_GOOGLE_CLIENT_ID', 'invalid']]) {
  test(`reject ${key} before network`, () => assert.throws(() => createSupportEmailOAuth({ env: { ...env, [key]: value }, fetchImpl: () => assert.fail('network') }), /SUPPORT_EMAIL_OAUTH_(OFF|CONFIG)/));
}
test('setup does not require polling to be enabled or baseline before consent', () => { assert.doesNotThrow(() => createSupportEmailOAuth({ env })); assert.equal(config(env).enabled,false); });
test('authorization pins exact readonly and alphy with one-use PKCE', async () => {
  const h = setup(), url = h.start(), p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ scope: READONLY_SCOPE, redirect_uri: REDIRECT, login_hint: env.SUPPORT_EMAIL_MAILBOX,
    access_type: 'offline', response_type: 'code', include_granted_scopes: 'false', prompt: 'select_account consent', code_challenge_method: 'S256' })) assert.equal(p.get(key), value);
  assert.match(p.get('state'), /^[A-Za-z0-9_-]{43}$/); assert.throws(()=> h.oauth.begin(), /PENDING/);
  const result = await h.oauth.complete({ state: p.get('state'), code: 'synthetic-code' });
  const form = new URLSearchParams(h.calls[0].options.body);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), p.get('code_challenge'));
  assert.equal(form.get('client_secret'), env.SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET);
  assert.equal(form.get('redirect_uri'),REDIRECT);assert.equal(p.get('scope'),'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(p.has('client_secret'),false);assert.equal(p.has('code_verifier'),false);
  assert.equal(h.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(result.mailbox, env.SUPPORT_EMAIL_MAILBOX); assert.equal(result.baselineHistoryId, '1234');
  assert.equal(result.expiresAt, 4599000);
  assert.equal(h.calls.some(c=>c.url.endsWith('/revoke')),false);
  for (const call of h.calls) for (const secret of [env.SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET,form.get('code_verifier'),'synthetic-code','synthetic-refresh']) assert.equal(call.url.includes(secret),false);
  await assert.rejects(h.oauth.complete({state:p.get('state'),code:'synthetic-code'}), /STATE/);
  assert.notEqual(h.start().searchParams.get('state'),p.get('state'));
});
for (const condition of ['missing', 'mismatch', 'expired', 'denied', 'bad_code']) test(`callback ${condition} never exchanges`, async () => {
  const h = setup(), state = h.start().searchParams.get('state'); if(condition==='expired') h.advance(300000);
  await assert.rejects(h.oauth.complete({ state: condition==='missing' ? undefined : condition==='mismatch' ? 'x'.repeat(43) : state,
    code: condition==='bad_code' ? 'bad\ncode' : 'synthetic-code', ...(condition==='denied'?{error:'access_denied'}:{}) }), /STATE|DENIED/);
  assert.equal(h.calls.length,0); await assert.rejects(h.oauth.complete({state,code:'synthetic-code'}), /STATE/);
});
test('concurrent callbacks exchange only once', async () => {
  const h=setup(),state=h.start().searchParams.get('state');
  const results=await Promise.allSettled([h.oauth.complete({state,code:'synthetic'}),h.oauth.complete({state,code:'synthetic'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.calls.filter(c=>c.url.endsWith('/token')).length,1);
});
for(const condition of ['owner','wrong_client','wrong_azp','missing_azp','wrong_audience','wrong_issued_to','overbroad','modify','full_mail','expired_info','expired_token','expired_absolute','missing_absolute','far_absolute','bad_type','numeric_type','numeric_mailbox','missing_refresh']) test(`reject token ${condition}`,async()=>{
  const base=setup().defaults,overrides={};
  if(condition==='owner')overrides.profile={...base.profile,emailAddress:'jason@alphasourceai.com'};
  if(condition==='wrong_client')overrides.info={...base.info,aud:'another-client'};
  if(condition==='wrong_azp')overrides.info={...base.info,azp:'another-client'};
  if(condition==='missing_azp'){overrides.info={...base.info};delete overrides.info.azp;}
  if(condition==='wrong_audience')overrides.info={...base.info,audience:'another-client'};
  if(condition==='wrong_issued_to')overrides.info={...base.info,issued_to:'another-client'};
  if(condition==='overbroad')overrides.info={...base.info,scope:READONLY_SCOPE+' https://www.googleapis.com/auth/gmail.send'};
  if(condition==='modify')overrides.info={...base.info,scope:'https://www.googleapis.com/auth/gmail.modify'};
  if(condition==='full_mail')overrides.info={...base.info,scope:'https://mail.google.com/'};
  if(condition==='expired_info')overrides.info={...base.info,expires_in:'0'};
  if(condition==='expired_token')overrides.token={...base.token,expires_in:0};
  if(condition==='expired_absolute')overrides.info={...base.info,exp:'1'};
  if(condition==='missing_absolute'){overrides.info={...base.info};delete overrides.info.exp;}
  if(condition==='far_absolute')overrides.info={...base.info,exp:'9000'};
  if(condition==='bad_type')overrides.token={...base.token,token_type:'Other'};
  if(condition==='numeric_type')overrides.token={...base.token,token_type:123};
  if(condition==='numeric_mailbox')overrides.profile={...base.profile,emailAddress:123};
  if(condition==='missing_refresh'){overrides.token={...base.token};delete overrides.token.refresh_token;}
  const h=setup(overrides),state=h.start().searchParams.get('state');
  await assert.rejects(h.oauth.complete({state,code:'synthetic'}),e=>/WRONG_MAILBOX|WRONG_CLIENT|SCOPE|INVALID_TOKEN/.test(e.message)&&!e.message.includes('synthetic'));
  const revokes=h.calls.filter(c=>c.url.endsWith('/revoke'));assert.equal(revokes.length,1);
  const form=new URLSearchParams(revokes[0].options.body);assert.equal(form.get('token'),condition==='missing_refresh'?'synthetic-access':'synthetic-refresh');assert.equal(form.has('client_secret'),false);
  assert.equal(revokes[0].options.redirect,'error');assert.ok(revokes[0].options.signal instanceof AbortSignal);
});
test('refresh validates the token and allows omitted refresh-token/scope fields', async()=>{
  const h=setup({token:{access_token:'synthetic-renewed',token_type:'Bearer',expires_in:3600}});
  const result=await h.oauth.refresh('synthetic-refresh');assert.equal(result.refreshToken,undefined);
  assert.equal(result.baselineHistoryId,undefined);assert.equal(result.currentHistoryId,'1234');
  const form=new URLSearchParams(h.calls[0].options.body);assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),'synthetic-refresh');
  assert.equal(h.calls.some(c=>c.url.includes('synthetic-refresh')),false);
});
test('provider failures never expose error payload or retry',async()=>{
  const h=setup({throw:true});await assert.rejects(h.oauth.refresh('synthetic-refresh'),e=>e.message==='SUPPORT_EMAIL_OAUTH_PROVIDER');assert.equal(h.calls.length,1);
});
for(const mode of ['old','rotated'])test(`definitive refresh rejection revokes ${mode} grant once`,async()=>{
  const base=setup().defaults;const h=setup({token:{...base.token,...(mode==='old'?{refresh_token:undefined}:{refresh_token:'synthetic-rotated'})},profile:{...base.profile,emailAddress:'jason@alphasourceai.com'}});
  await assert.rejects(h.oauth.refresh('synthetic-old'),/WRONG_MAILBOX/);
  const revokes=h.calls.filter(c=>c.url.endsWith('/revoke'));assert.equal(revokes.length,1);assert.equal(new URLSearchParams(revokes[0].options.body).get('token'),mode==='old'?'synthetic-old':'synthetic-rotated');
});
for(const mode of ['non200','throw','oversize'])test(`unconfirmed revoke ${mode} returns no credentials`,async()=>{
  const base=setup().defaults;const h=setup({profile:{...base.profile,emailAddress:'jason@alphasourceai.com'},...(mode==='non200'?{revokeStatus:400}:mode==='throw'?{revokeThrows:true}:{revokeBody:'a'.repeat(40000)})});
  await assert.rejects(h.oauth.refresh('synthetic-refresh'),e=>e.message==='SUPPORT_EMAIL_OAUTH_REVOKE_UNCONFIRMED');assert.equal(h.calls.filter(c=>c.url.endsWith('/revoke')).length,1);
});
test('tokeninfo outage preserves an existing good grant',async()=>{
  const calls=[];const base=setup().defaults;
  const h=createSupportEmailOAuth({env,fetchImpl:async(url)=>{calls.push(url);if(url.endsWith('/token'))return new Response(JSON.stringify(base.token));throw new Error('synthetic secret must not leak');}});
  await assert.rejects(h.refresh('synthetic-refresh'),e=>e.message==='SUPPORT_EMAIL_OAUTH_PROVIDER');assert.equal(calls.length,2);assert.equal(calls.some(url=>url.endsWith('/revoke')),false);
});
test('OAuth source has no sending, listener, persistence, or route registration',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/lib/supportEmailOAuth.js'),'utf8');
  assert.ok(!/messages\/send|drafts\/|gmail\.(?:send|modify|compose)|mail\.google\.com|smtp|\.listen\(|createServer|app\.(?:get|post|use)\(|console\.|writeFile/i.test(source));
});
for (const body of ['a'.repeat(40000),'not json','[]']) test(`provider body bounded ${body.length}`,async()=>{
  const h=setup({response:new Response(body)});await assert.rejects(h.oauth.refresh('synthetic-refresh'),/OAUTH_PROVIDER/);
});
test('redirects denied, deadlines set; helper never sends email',async()=>{
  const h=setup();await h.oauth.refresh('synthetic-refresh');
  assert.ok(h.calls.every(c=>c.options.redirect==='error'&&c.options.signal instanceof AbortSignal));
  assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
  assert.ok(h.calls.every(c=>!c.url.includes('/messages')&&!c.url.includes('/drafts')));
});
