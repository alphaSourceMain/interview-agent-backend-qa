'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateRuntimeEnvironment,validateManifest,validateRuntimeKeys,NAME,PATHS}=require('../src/runtime-config');
const {validateHistory}=require('../src/runtime-history');
const env={SUPPORT_EMAIL_WORKER_ENABLED:'true',RENDER:'true',RENDER_SERVICE_NAME:NAME,RENDER_SERVICE_ID:'crn-'+ 'a'.repeat(20),
  SUPABASE_URL:'https://yjjxzxoghlpguquknyso.supabase.co',SUPPORT_EMAIL_ENVIRONMENT:'qa',SUPPORT_EMAIL_MAILBOX:'alphy@alphasourceai.com',
  SUPPORT_EMAIL_OWNER_TEST_ONLY:'true',SUPPORT_EMAIL_OWNER_TEST_SENDER:'jason@gardner.ltd',SUPPORT_EMAIL_WORKER_MODE:'qa-owner-auto',
  SUPPORT_EMAIL_SECRET_MOUNT_APPROVED:'true',SUPPORT_EMAIL_WORKER_SEND_APPROVED:'true',SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED:'true'};
test('strict hosted config defaults off and requires compiled QA target',()=>{
  assert.equal(validateRuntimeEnvironment({}),null);assert.equal(validateRuntimeEnvironment({...env,SUPPORT_EMAIL_WORKER_ENABLED:'false'}),null);
  assert.equal(validateRuntimeEnvironment(env).mode,'qa-owner-auto');
  for(const [key,value]of [['SUPABASE_URL','https://rytlclkkcvvnkoncfaid.supabase.co'],['SUPPORT_EMAIL_ENVIRONMENT','production'],['RENDER','false'],['SUPPORT_EMAIL_OWNER_TEST_SENDER','other@example.invalid'],['SUPPORT_EMAIL_OWNER_TEST_ONLY','false'],['RENDER_SERVICE_NAME','ia-backend-prod'],['SUPPORT_EMAIL_SECRET_MOUNT_APPROVED','false']])assert.throws(()=>validateRuntimeEnvironment({...env,[key]:value}));
});
test('no race/sending approval falls back draft-only',()=>{for(const key of ['SUPPORT_EMAIL_HUMAN_CC_RULE_APPROVED','SUPPORT_EMAIL_WORKER_SEND_APPROVED'])assert.equal(validateRuntimeEnvironment({...env,[key]:'false'}).mode,'qa-draft');});
test('manifest pins exact fixed-file tuples; malformed/extra entries fail',()=>{
  const m=Object.fromEntries(Object.keys(PATHS).map(k=>[k,{uid:0,mode:'0644'}]));assert.deepEqual(validateManifest(JSON.stringify(m)),m);
  for(const v of [{}, {...m,extra:{uid:0,mode:'0644'}},{...m,readGrant:{uid:0,mode:'0666'}},{...m,keys:{uid:-1,mode:'0600'}},{...m,sendGrant:{uid:0,mode:'0600',extra:true}}])assert.throws(()=>validateManifest(JSON.stringify(v)));
});
test('runtime service token binding rejects prod ref and expired credentials',()=>{
  const token=claims=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
  const good={role:'service_role',ref:'yjjxzxoghlpguquknyso',exp:Math.floor(Date.now()/1000)+3600};
  assert.ok(validateRuntimeKeys({supabaseServiceRoleKey:token(good),xaiApiKey:'synthetic-key-1234567890'}));
  for(const c of [{...good,ref:'rytlclkkcvvnkoncfaid'},{...good,role:'authenticated'},{...good,exp:0}])assert.throws(()=>validateRuntimeKeys({supabaseServiceRoleKey:token(c),xaiApiKey:'synthetic-key-1234567890'}));
});
const message={message:{id:'abc',threadId:'abc',labelIds:['INBOX']}};
test('history uses numeric ordering, exact new-message shape, deduped bounded page',()=>{
  assert.deepEqual(validateHistory({historyId:'100',history:[{id:'11',messagesAdded:[message,message]},{id:'99',messagesAdded:[message]}]},'10'),{next:'100',ids:['abc']});
  assert.deepEqual(validateHistory({historyId:'10'},'10'),{next:'10',ids:[]});
});
test('history backlog/cursor reversal/malformed record all hold',()=>{
  for(const p of [{historyId:'9'},{historyId:'11',nextPageToken:'next'},{historyId:'11',history:[{id:'9',messagesAdded:[message]}]},
    {historyId:'11',history:[{id:'11',messagesAdded:[{message:{id:'abc',threadId:'abc'}}]}]},
    {historyId:'99',history:Array.from({length:26},(_,n)=>({id:String(n+11),messagesAdded:[message]}))},
    {historyId:'99',history:[{id:'11',messagesAdded:Array.from({length:26},(_,n)=>({message:{id:n.toString(16),threadId:'abc',labelIds:[]}}))}]}])assert.throws(()=>validateHistory(p,'10'));
});
