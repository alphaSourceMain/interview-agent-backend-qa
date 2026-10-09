'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildWorkspace}=require('../demo/workspace');
const {buildFixture}=require('../demo/northstar');
const {DEMO_CLIENT_ID,QA_URL,safeDemoRequest,assertDemoPrincipal}=require('../src/lib/salesDemo');

test('authored manager workspace reconciles amounts, candidates and capacity with no provider identifiers',()=>{
  const d=buildWorkspace(),fixture=buildFixture();
  assert.equal(d.synthetic,true);assert.equal(d.read_only,true);assert.equal(d.client_id,DEMO_CLIENT_ID);
  assert.equal(d.entities.length,3);assert.equal(d.members.length,3);
  for(const row of d.billing.invoices){assert.equal(row.total_cents,row.platform_cents+row.role_cents);assert.equal(row.status,'Paid (example)');}
  assert.equal(d.billing.roles.reduce((s,r)=>s+r.used,0),fixture.candidates.length);
  for(const q of d.automation.queue){const c=fixture.candidates.find(c=>c.id===q.candidate_id);assert.ok(c);const report=fixture.reports.find(r=>r.candidate_id===c.id);assert.equal(q.score,report.overall_score);assert.ok(report.resume_score>=d.automation.resume_min&&report.interview_score>=d.automation.interview_min&&q.score>=d.automation.overall_min);}
  for(const row of [...d.entities,...d.members,d.client,d.profile])assert.match(row.email,/@northstar\.example\.invalid$/);
  assert.ok(!/stripe_|cus_|sub_|pi_|invitation_token|https:\/\//.test(JSON.stringify(d)));
  d.members[0].name='Changed';assert.equal(buildWorkspace().members[0].name,'Alex Northstar');
});
test('manager preview does not widen side-effect or foreign-scope allowlists',()=>{
  const user={app_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}};
  assert.equal(assertDemoPrincipal({method:'GET',originalUrl:'/demo/workspace'},user,{SUPABASE_URL:QA_URL}),null);
  assert.equal(assertDemoPrincipal({method:'GET',originalUrl:'/demo/workspace'},user,{SUPABASE_URL:'https://rytlclkkcvvnkoncfaid.supabase.co'}),'demo_access_denied');
  for(const path of ['/demo/workspace','/clients/entities','/client-members/add','/clients/billing/portal-session','/clients/billing/additional-interviews/checkout-session','/automation/config','/auth/profile/sync'])assert.equal(safeDemoRequest({method:'POST',originalUrl:path}),false,path);
});
test('actual snapshot route is guarded, rejects foreign/array selectors, and never touches a provider',async()=>{
  const authPath=require.resolve('../src/middleware/auth'),dbPath=require.resolve('../src/lib/supabaseClient'),routePath=require.resolve('../routes/salesDemo');
  const previous=[authPath,dbPath,routePath].map(p=>require.cache[p]);const old=process.env.SUPABASE_URL;
  let authChecks=0,scopeChecks=0;
  require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{requireAuth(req,res,next){authChecks++;next()},withClientScope(req,res,next){scopeChecks++;next()}}};
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:new Proxy({}, {get(){throw Error('snapshot cannot call provider')}})}};
  delete require.cache[routePath];process.env.SUPABASE_URL=QA_URL;
  try {
    const router=require(routePath);
    function call(overrides={},path='/workspace'){const index=router.stack.findIndex(l=>l.route?.path===path);assert.ok(index>=0);const req={isSalesDemo:true,clientIds:[DEMO_CLIENT_ID],memberships:[{client_id:DEMO_CLIENT_ID,role:'manager'}],query:{client_id:DEMO_CLIENT_ID},...overrides};const res={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this},status(n){this.statusCode=n;return this},json(body){this.body=body;return this},end(){return this}};for(const layer of router.stack.slice(0,index).filter(l=>!l.route)){let next=false;layer.handle(req,res,()=>{next=true});if(!next)return res;}router.stack[index].route.stack[0].handle(req,res);return res;}
    assert.equal(call().body.synthetic,true);assert.equal(call({query:{client_id:DEMO_CLIENT_ID}}).statusCode,200);
    for(const query of [{},{client_id:'other'},{client_id:[DEMO_CLIENT_ID,'other']},{client_id:''}]){const result=call({query});assert.equal(result.statusCode,403);assert.equal(result.body,undefined);}
    for(const overrides of [{isSalesDemo:false},{clientIds:[DEMO_CLIENT_ID,'other']},{memberships:[{client_id:DEMO_CLIENT_ID,role:'member'}]}])assert.equal(call(overrides).statusCode,403);
    const admin={isSalesDemo:false,isGlobalAdmin:true,memberships:[],clientIds:[DEMO_CLIENT_ID]};
    assert.equal(call(admin).body.synthetic,true);assert.equal(call(admin).headers['Cache-Control'],'private, no-store');
    for(const query of [{},{client_id:'other'},{client_id:[DEMO_CLIENT_ID]}])assert.equal(call({...admin,query}).statusCode,403);
    for(const overrides of [{isGlobalAdmin:true},{...admin,isGlobalAdmin:'true'},{isSalesDemo:false,body:{isGlobalAdmin:true}},{isSalesDemo:false,query:{client_id:DEMO_CLIENT_ID,isGlobalAdmin:true}},{clientIds:['other']}])assert.equal(call(overrides).statusCode,403);
    assert.equal(call(admin,'/reset').statusCode,403);assert.equal(call(admin,'/:kind/:id').statusCode,403);
    process.env.SUPABASE_URL='https://rytlclkkcvvnkoncfaid.supabase.co';assert.equal(call().statusCode,403);assert.equal(call(admin).statusCode,403);assert.ok(authChecks>0&&scopeChecks>0);
  } finally {if(old===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=old;[authPath,dbPath,routePath].forEach((p,i)=>{if(previous[i])require.cache[p]=previous[i];else delete require.cache[p]});}
});
