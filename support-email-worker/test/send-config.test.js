'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateSendEnvironment,validateSendGrant,readSendClient,SEND_CLIENT,SEND_GRANT}=require('../src/send-config');
const {PROJECT,PROJECT_NUMBER,CLIENT,REDIRECT,SCOPE}=require('../src/send-oauth');
const now=Date.now(),readGrant={baselineHistoryId:'123',capturedAt:new Date(now-1000).toISOString()};
const env={SUPABASE_URL:'https://yjjxzxoghlpguquknyso.supabase.co',SUPPORT_EMAIL_ENVIRONMENT:'qa',SUPPORT_EMAIL_MODE:'qa-draft',SUPPORT_EMAIL_MAILBOX:'alphy@alphasourceai.com',
  SUPPORT_EMAIL_OWNER_TEST_ONLY:'true',SUPPORT_EMAIL_OWNER_TEST_SENDER:'jason@gardner.ltd',SUPPORT_EMAIL_ENABLED:'false',SUPPORT_EMAIL_CONNECTION_APPROVED:'false',
  SUPPORT_EMAIL_OAUTH_ENABLED:'false',SUPPORT_EMAIL_SEND_OAUTH_ENABLED:'true',SUPPORT_EMAIL_SEND_CONNECTION_APPROVED:'true',SUPPORT_EMAIL_SEND_ONCE_ENABLED:'false',
  SUPPORT_EMAIL_BASELINE_HISTORY_ID:'123',SUPPORT_EMAIL_CUTOVER_AT:readGrant.capturedAt};
const grant={clientId:CLIENT,mailbox:'alphy@alphasourceai.com',scope:SCOPE,refreshToken:'synthetic-refresh',capturedAt:readGrant.capturedAt,accessTokenExpiresAt:now+3600000};
test('connection gates keep sending/processing/readonly connection off',()=>assert.equal(validateSendEnvironment(env,readGrant,'connect').SUPPORT_EMAIL_ENABLED,'false'));
for(const [key,value] of [['SUPABASE_URL','https://production.supabase.co'],['SUPPORT_EMAIL_ENABLED','true'],['SUPPORT_EMAIL_CONNECTION_APPROVED','true'],['SUPPORT_EMAIL_SEND_ONCE_ENABLED','true'],['SUPPORT_EMAIL_SEND_CONNECTION_APPROVED','false'],['SUPPORT_EMAIL_SEND_OAUTH_ENABLED','false'],['SUPPORT_EMAIL_OAUTH_ENABLED','true'],['SUPPORT_EMAIL_OWNER_TEST_SENDER','other@example.invalid'],['SUPPORT_EMAIL_BASELINE_HISTORY_ID','124'],['SUPPORT_EMAIL_ENVIRONMENT','production']])test('reject connection gate '+key,()=>assert.throws(()=>validateSendEnvironment({...env,[key]:value},readGrant,'connect')));
test('send gates use genuine readonly refresh with processing off, separate sender on',()=>{
  const jwt='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role:'service_role',ref:'yjjxzxoghlpguquknyso',exp:Math.floor(now/1000)+3600})).toString('base64url')+'.synthetic';
  const e={...env,SUPPORT_EMAIL_OAUTH_ENABLED:'true',SUPPORT_EMAIL_SEND_CONNECTION_APPROVED:'false',SUPPORT_EMAIL_SEND_ONCE_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:jwt};
  assert.equal(validateSendEnvironment(e,readGrant,'send').SUPPORT_EMAIL_ENABLED,'false');assert.throws(()=>validateSendEnvironment({...e,SUPPORT_EMAIL_SEND_CONNECTION_APPROVED:'true'},readGrant,'send'));
});
test('stored send grant is exact separate client/scope/identity/time shape',()=>{assert.equal(validateSendGrant({...grant}).clientId,CLIENT);
  for(const change of [{clientId:'readonly-client'},{scope:SCOPE+' openid'},{mailbox:'jason@alphasourceai.com'},{extra:true},{capturedAt:'bad'},{accessTokenExpiresAt:now+99999999}])assert.throws(()=>validateSendGrant({...grant,...change}));});
test('pinned send client secure reader rejects scope path/client tampering',t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'alphy-send-client-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'client.json'),data={web:{client_id:CLIENT,project_id:PROJECT,client_secret:'synthetic-send-client-secret',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs',redirect_uris:[REDIRECT]}};
  fs.writeFileSync(file,JSON.stringify(data),{mode:0o600});assert.equal(readSendClient(file).clientId,CLIENT);
  fs.chmodSync(file,0o644);assert.throws(()=>readSendClient(file));fs.chmodSync(file,0o600);
  fs.symlinkSync(file,file+'.link');assert.throws(()=>readSendClient(file+'.link'));
  fs.linkSync(file,file+'.hard');assert.throws(()=>readSendClient(file));fs.unlinkSync(file+'.hard');
  for(const c of [{client_id:'wrong'},{project_id:'wrong'},{client_id:CLIENT.replace(PROJECT_NUMBER,'940084368446')},{redirect_uris:[REDIRECT,'https://other.invalid/callback']},{javascript_origins:['https://other.invalid']},{token_uri:'https://other.invalid/token'}]){fs.writeFileSync(file,JSON.stringify({web:{...data.web,...c}}));assert.throws(()=>readSendClient(file));}
});
test('actual sender project and exclusive new storage paths are pinned independently of intake',()=>{
  assert.equal(PROJECT,'alphascreen-alphy-qa-sending');assert.equal(PROJECT_NUMBER,'581820238541');assert.equal(CLIENT.split('-')[0],PROJECT_NUMBER);
  assert.equal(SEND_CLIENT,'/Users/jasongardner/Downloads/alphy-support-qa/isolated-send-client.json');
  assert.equal(SEND_GRANT,'/Users/jasongardner/Downloads/alphy-support-qa/isolated-send-grant.json');
  assert.notEqual(PROJECT,'alphascreen-alphy-support');
});
test('original project and both original-project clients are ineligible for sending',t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'alphy-send-isolation-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'client.json');
  const metadata={auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs',redirect_uris:[REDIRECT],client_secret:'synthetic-send-client-secret'};
  const oldProject='alphascreen-alphy-support',newProject='alphascreen-alphy-qa-sending';
  const oldSender='940084368446-m88ok6st3vkts8vbk61sh0ue59qdgakr.apps.googleusercontent.com';
  const oldReader='940084368446-rmd990rkphtbbshq85tk357kcd3dl0t8.apps.googleusercontent.com';
  const newSender='581820238541-evup8b38vdio8f53rultitdifc4dmmdl.apps.googleusercontent.com';
  for(const [project_id,client_id] of [[oldProject,oldSender],[oldProject,oldReader],[oldProject,newSender],[newProject,oldSender],[newProject,oldReader]]){
    fs.writeFileSync(file,JSON.stringify({web:{...metadata,project_id,client_id}}),{mode:0o600});
    assert.throws(()=>readSendClient(file),'same-project or mixed credentials must fail closed');
  }
});
