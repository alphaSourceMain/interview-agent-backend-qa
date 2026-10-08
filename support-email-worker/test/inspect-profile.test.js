'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../inspect-mounts'),'utf8');
const profiles=require('../src/runtime-profile');
const base={RENDER:'true',RENDER_SERVICE_NAME:'alphascreen-alphy-mail-prod',SUPABASE_URL:'https://rytlclkkcvvnkoncfaid.supabase.co',
 SUPPORT_EMAIL_WORKER_ENABLED:'false',SUPPORT_EMAIL_ENVIRONMENT:'production',SUPPORT_EMAIL_WORKER_MODE:'production-draft',
 SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'true',SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED:'true',SUPPORT_EMAIL_SECRET_LAYOUT:'render-projected-v1'};
function run(env){let inspections=0;const lines=[],process={argv:['node','inspect'],platform:'linux',env,exitCode:0};
 vm.runInNewContext(source,{process,console:{log:s=>lines.push(s),error:s=>lines.push(s)},require:name=>{
  if(name==='node:fs')return {};
  if(name==='./src/runtime-config')return {PATHS:{}};
  if(name==='./src/runtime-profile')return profiles;
  if(name==='./src/projected-mounts')return {inspectProjectedMounts(){inspections++;return {synthetic:true};}};
  throw Error('unexpected module');
 }});return {inspections,lines,exitCode:process.exitCode};}
test('production metadata inspector accepts approved compiled production binding while OFF',()=>{
 const r=run(base);assert.equal(r.exitCode,0);assert.equal(r.inspections,1);assert.equal(JSON.parse(r.lines[0]).status,'metadata_only');
});
test('QA metadata inspector remains bound to unretired QA',()=>{
 const r=run({...base,SUPPORT_EMAIL_ENVIRONMENT:'qa',SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'false',
  RENDER_SERVICE_NAME:profiles.QA_PROFILE.name,SUPABASE_URL:profiles.QA_PROFILE.url});assert.equal(r.exitCode,0);assert.equal(r.inspections,1);
});
for(const [key,value] of [['RENDER_SERVICE_NAME','alphascreen-alphy-mail-qa'],['SUPABASE_URL',profiles.QA_PROFILE.url],
 ['SUPPORT_EMAIL_ENVIRONMENT','unknown'],['SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED','false'],
 ['SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED','false'],['SUPPORT_EMAIL_WORKER_ENABLED','true']])
 test('invalid inspector binding stops before filesystem inspection: '+key,()=>{const r=run({...base,[key]:value});assert.equal(r.exitCode,1);assert.equal(r.inspections,0);});
test('retired QA cannot inspect shared-mailbox mounts',()=>{
 const r=run({...base,SUPPORT_EMAIL_ENVIRONMENT:'qa',SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED:'false',SUPPORT_EMAIL_MAILBOX_RETIRED:'true',
  RENDER_SERVICE_NAME:profiles.QA_PROFILE.name,SUPABASE_URL:profiles.QA_PROFILE.url});assert.equal(r.exitCode,1);assert.equal(r.inspections,0);
});
