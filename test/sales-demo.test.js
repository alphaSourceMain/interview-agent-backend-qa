'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {buildFixture,people,roles}=require('../demo/northstar');
const {migrationSql}=require('../demo/migration');
const {DEMO_CLIENT_ID,QA_URL,isQa,safeDemoRequest,referencesDemo,assertDemoPrincipal,uuid}=require('../src/lib/salesDemo');

test('closed fictional fixture: one client, two roles, three candidates per role, six bound reports and transcripts',()=>{
  const f=buildFixture();
  assert.equal(f.clients.length,1);assert.equal(f.roles.length,2);
  assert.equal(f.candidates.length,6);assert.equal(f.interviews.length,6);assert.equal(f.reports.length,6);
  assert.equal(f.clients[0].parent_client_id,null);
  assert.equal(f.roles.every(r=>r.slug_or_token.startsWith('sales-demo-northstar-')),true);
  for(const r of roles){assert.equal(f.candidates.filter(c=>c.role_id===r.id).length,3);assert.equal(r.questions.reduce((s,q)=>s+q[2],0),100);}
  people.forEach((p,i)=>{
    const c=f.candidates[i],iv=f.interviews[i],rep=f.reports[i];
    assert.equal(c.client_id,DEMO_CLIENT_ID);assert.match(c.email,/@example\.invalid$/);assert.equal(c.phone,null);
    assert.equal(iv.candidate_id,c.id);assert.equal(rep.interview_id,iv.id);assert.equal(iv.attempt_number,rep.attempt_number);
    assert.equal(iv.video_url,null);assert.equal(iv.recording_status,'demo_placeholder');assert.equal(iv.perception_scores.unavailable,true);
    assert.equal(iv.transcript_scores.ai_aided_risk,null);
    assert.equal(rep.overall_score,Math.round((rep.resume_score+rep.interview_score)/2));
    assert.equal(rep.interview_score,Math.round(p.points.reduce((s,score,n)=>s+score*roles[p.role].questions[n][2]/100,0)));
    for(const a of p.answers){assert.ok(iv.transcript.includes(a));assert.ok(iv.interview_analysis_v2.evidence.some(e=>e.includes(a)));}
    assert.equal(p.answers.length,4);assert.ok(p.followUp);assert.ok(p.limitation);
    const pdf=fs.readFileSync(require('node:path').join(__dirname,'../demo/resumes',uuid(p.n)+'.pdf'));
    assert.match(pdf.toString('ascii',0,8),/^%PDF-/);
  });
});
test('QA pin and trusted metadata confinement reject prod and admin, never trust user_metadata',()=>{
  assert.equal(isQa({SUPABASE_URL:QA_URL}),true);assert.equal(isQa({SUPABASE_URL:'https://rytlclkkcvvnkoncfaid.supabase.co'}),false);
  const user={app_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}};
  assert.equal(assertDemoPrincipal({method:'GET',originalUrl:'/clients/my'},user,{SUPABASE_URL:QA_URL}),null);
  assert.equal(assertDemoPrincipal({method:'GET',originalUrl:'/clients/my',isGlobalAdmin:true},user,{SUPABASE_URL:QA_URL}),'demo_access_denied');
  assert.equal(assertDemoPrincipal({method:'GET',originalUrl:'/clients/my'},user,{}),'demo_access_denied');
  assert.equal(assertDemoPrincipal({method:'POST',originalUrl:'/clients/invite'},user,{SUPABASE_URL:QA_URL}),'demo_action_disabled');
  assert.equal(assertDemoPrincipal({}, {user_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}}, {}),null);
});
test('closed side-effect allowlist, case-insensitive public fence and no blanket admin bypass',()=>{
  for(const url of ['/clients/invite','/client-members/add','/create-tavus-interview','/clients/roles/checkout-session','/feedback/submit','/sales/new','/admin/clients','/automation/rules']) assert.equal(safeDemoRequest({method:'POST',originalUrl:url}),false,url);
  assert.equal(safeDemoRequest({method:'POST',originalUrl:'/demo/reset'}),true);
  assert.equal(safeDemoRequest({method:'PATCH',originalUrl:`/roles/${uuid(100)}/status?client_id=${DEMO_CLIENT_ID}`}),true);
  assert.equal(safeDemoRequest({method:'PATCH',originalUrl:'/roles/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/status'}),false);
  assert.equal(safeDemoRequest({method:'GET',originalUrl:'/admin/sales-team'}),false);
  assert.equal(referencesDemo({body:{roleId:uuid(100).toUpperCase()}}),true);
  assert.equal(referencesDemo({originalUrl:'/api/candidate/submit?role_id='+uuid(100)}),true);
});
test('database restore contains closure/collision assertions, one transaction lock, restrictive direct-write policies, and explicit ACLs',()=>{
  const sql=migrationSql();
  assert.equal(fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/20261008210715_sales_demo_qa_fixture.sql'),'utf8').trim(),sql.trim());
  for(const term of ['pg_advisory_xact_lock','demo_fixture_not_closed','demo_client_collision','as restrictive','to anon,authenticated','revoke all on function private.sales_demo_control','grant execute on function public.sales_demo_control','to service_role','set search_path=\'\''])assert.ok(sql.includes(term),term);
  assert.ok(!/delete from public\./i.test(sql));
  assert.ok(sql.includes("r.table_name='clients' or r.table_name='roles'"));
});
test('batch workers explicitly exclude demo and scoring/messaging cannot process fixture objects',()=>{
  for(const name of ['jobs/sendNightlyDigests.js','scripts/normalizeCandidates.js','scripts/backfillInterviews.js','scripts/rescoreRoleInterviews.js','src/lib/recordingCleanup.js']){
    assert.match(fs.readFileSync(require('node:path').join(__dirname,'..',name),'utf8'),/neq\('client_id', require\(.+salesDemo.+\)\.DEMO_CLIENT_ID\)/);
  }
  assert.match(fs.readFileSync(require('node:path').join(__dirname,'../src/lib/candidateAutomationEvaluator.js'),'utf8'),/demo_automation_disabled/);
  assert.match(fs.readFileSync(require('node:path').join(__dirname,'../src/lib/automationActions.js'),'utf8'),/Demo actions cannot send messages/);
});
