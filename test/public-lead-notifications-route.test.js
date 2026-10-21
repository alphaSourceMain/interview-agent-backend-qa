'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),request=require('supertest');
const path=require('node:path');
const root=path.resolve(__dirname,'../src');
const client=path.join(root,'clients/supabase.js'),mailer=path.join(root,'clients/sendgrid.js');
const notifications=require('../src/services/publicLeadNotifications');
let captureCalls=[],sendCalls=[],reply={data:{item:{id:'11111111-1111-4111-8111-111111111111',status:'submitted'},notification:null}};
function stub(filename,exports){require.cache[filename]={id:filename,filename,loaded:true,exports};}
stub(client,{supabaseAdmin:{rpc:async(name,args)=>{captureCalls.push({name,args});return reply;}}});
stub(mailer,{sendPublicLeadNotification:async n=>{sendCalls.push(n);throw Error('synthetic timeout');}});
const app=express();app.use(express.json());app.use('/api/public-leads',require('../src/routes/public/leads'));
let ip=0;function post(body){return request(app).post('/api/public-leads/draft').set('x-forwarded-for',`192.0.2.${++ip}`).send(body);}
const id='11111111-1111-4111-8111-111111111111',attempt='22222222-2222-4222-8222-222222222222';
const body={draft_id:id,status:'submitted',form_id:'home-contact',form_type:'contact',fields:{first_name:' Synthetic ',email:'SYNTHETIC@example.invalid',message:' test '},source:{path:'/?utm_source=test'}};
test('route preserves response and sanitized canonical capture inputs, disabled notification stays silent',async()=>{
 captureCalls=[];const r=await post(body);assert.equal(r.status,200);assert.deepEqual(r.body.item,{id,status:'submitted'});
 assert.equal(captureCalls.length,1);assert.equal(captureCalls[0].name,'save_public_lead_capture');
 const a=captureCalls[0].args;assert.equal(a.p_row.email,'synthetic@example.invalid');assert.equal(a.p_row.source_path,'/');
 assert.equal(a.p_row.message,'test');assert.equal(a.p_notification_environment,null);assert.equal(sendCalls.length,0);
 assert.equal(r.body.notification,undefined);
});
test('route validation does not call capture RPC and database failure does not leak details',async()=>{
 captureCalls=[];for(const bad of [{...body,draft_id:'bad'},{...body,status:'bad'},{...body,fields:{}}])assert.equal((await post(bad)).status,400);
 assert.equal(captureCalls.length,0);reply={error:{code:'synthetic',message:'PRIVATE',details:'PRIVATE'}};
 const r=await post(body);assert.equal(r.status,503);assert.ok(!JSON.stringify(r.body).includes('PRIVATE'));
});
test('saved submission remains successful when one mail attempt fails, and notification never reaches browser',async()=>{
 const savedDeliver=notifications.deliver;let attempts=0;
 notifications.deliver=async(n,options)=>{attempts++;return savedDeliver(n,{...options,db:{rpc:async()=>({data:true})},logger:{warn(){}}});};
 const n={claim:{lead_id:id,attempt_id:attempt,status:'sending'},lead:{id}};
 reply={data:{item:{id,status:'submitted'},notification:n}};
 try{const r=await post(body);assert.equal(r.status,200);assert.equal(attempts,1);assert.equal(sendCalls.length,1);assert.equal(r.body.notification,undefined);}
 finally{notifications.deliver=savedDeliver;reply={data:{item:{id,status:'submitted'},notification:null}};}
});
test('submitted throttle is tighter than draft throttle without blocking first ten submissions',async()=>{
 const address='198.51.100.11';
 for(let i=0;i<10;i++)assert.equal((await request(app).post('/api/public-leads/draft').set('x-forwarded-for',address).send(body)).status,200);
 assert.equal((await request(app).post('/api/public-leads/draft').set('x-forwarded-for',address).send(body)).status,429);
 assert.equal((await request(app).post('/api/public-leads/draft').set('x-forwarded-for',address).send({...body,status:'partial'})).status,200);
});
