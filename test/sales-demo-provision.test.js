'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const {provision}=require('../demo/provision');
const {QA_URL,DEMO_CLIENT_ID}=require('../src/services/salesDemo');
function fake({existing=false,extra=false}={}) {
  const state={users:existing?[{email:'michael@alphasourceai.com'}]:[],members:[],emails:[],creates:0,links:0};
  const db={auth:{admin:{
    listUsers:async()=>({data:{users:state.users},error:null}),
    createUser:async u=>{state.creates++;const user={...u,id:'new-'+state.creates};state.users.push(user);return {data:{user},error:null};},
    generateLink:async()=>{state.links++;return {data:{properties:{action_link:QA_URL+'/auth/v1/verify?test=dummy'}},error:null};},
  }},from(table){const filters={}; const q={select(){return q},eq(k,v){filters[k]=v;return q},single:async()=>({data:{id:DEMO_CLIENT_ID,parent_client_id:null},error:null}),insert:async row=>{state.members.push(row);return {data:null,error:null}},then(resolve){let data=[];if(table==='client_members'&&filters.user_id){data=state.members.filter(x=>x.user_id===filters.user_id);if(extra)data.push({client_id:'other',role:'manager'});}return Promise.resolve({data,error:null}).then(resolve);}};return q;}};
  return {state,db,sendSetup:async(to)=>{state.emails.push(to);return {statusCode:202}}};
}
test('provision creates two new QA-only manager identities with no setup links or email',async()=>{
  const f=fake(); const result=await provision({...f,env:{SUPABASE_URL:QA_URL},apply:true});
  assert.equal(result.created.length,2);assert.equal(f.state.emails.length,0);assert.equal(f.state.links,0);assert.equal(f.state.members.length,2);
  for(const u of f.state.users){assert.equal(u.password,undefined);assert.equal(u.app_metadata.sales_demo_client_id,DEMO_CLIENT_ID);}
});
test('pre-existing email and wrong environment abort without creation, grants, links or email',async()=>{
  for(const [f,env] of [[fake({existing:true}),{SUPABASE_URL:QA_URL}],[fake(),{SUPABASE_URL:'https://rytlclkkcvvnkoncfaid.supabase.co'}]]){
    await assert.rejects(()=>provision({...f,env,apply:true}));
    assert.equal(f.state.creates,0);assert.equal(f.state.members.length,0);assert.equal(f.state.links,0);assert.equal(f.state.emails.length,0);
  }
});
test('forbidden extra membership aborts before generating or emailing any setup link',async()=>{
  const f=fake({extra:true});await assert.rejects(()=>provision({...f,env:{SUPABASE_URL:QA_URL},apply:true}),/grant_mismatch/);
  assert.equal(f.state.links,0);assert.equal(f.state.emails.length,0);
});
test('dry-run reads and validates only, never mutates or sends',async()=>{
  const f=fake();assert.equal((await provision({...f,env:{SUPABASE_URL:QA_URL}})).ready,true);assert.equal(f.state.creates,0);assert.equal(f.state.emails.length,0);
});
