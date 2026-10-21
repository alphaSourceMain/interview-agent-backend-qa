'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const n=require('../src/services/publicLeadNotifications');
const leadId='11111111-1111-4111-8111-111111111111',attempt='22222222-2222-4222-8222-222222222222';
function env(app='prod'){const p=n.PINS[app];return{APP_ENV:app,RENDER_SERVICE_ID:p.service,SUPABASE_URL:`https://${p.database}.supabase.co`,SENDGRID_FROM:'info@alphasourceai.com',PUBLIC_LEAD_NOTIFICATIONS_ENABLED:'true',PUBLIC_LEAD_NOTIFICATIONS_ACTIVATED_AT:'2026-10-21T00:00:00.000Z'};}
function fixture(app='prod',id='home-contact'){
 const e=env(app),config=n.configuration(e),f=n.FORMS[id];
 const lead={id:leadId,status:'submitted',form_id:id,form_type:f.type,source_path:f.path,first_name:'Synthetic',last_name:'Lead',
 email:'synthetic@example.invalid',phone:'000',message:'Local test only',submitted_at:'2026-10-21T01:00:00.000Z'};
 const claim={lead_id:leadId,attempt_id:attempt,status:'sending',environment:config.environment,form_id:id,recipient:n.recipientFor(lead,config)};
 return {e,lead,claim};
}
const render={buildBrandedEmailShell:x=>`<main>${x.contentHtml}</main>`,escapeHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
test('four forms in all three pinned environments have exact internal recipient and Reply-To',()=>{
 for(const app of Object.keys(n.PINS))for(const id of Object.keys(n.FORMS)){
  const f=fixture(app,id),m=n.buildMessage(f,{env:f.e,...render});
  assert.equal(m.to,app==='prod'?id==='home-contact'?'info@alphasourceai.com':'sales@alphasourceai.com':'development@alphasourceai.com');
  assert.equal(m.replyTo,app==='prod'?f.lead.email:'info@alphasourceai.com');
  assert.equal(m.from,'info@alphasourceai.com');assert.equal(m.customArgs.lead_id,leadId);
  assert.equal(m.customArgs.attempt_id,attempt);assert.ok(!JSON.stringify(m.customArgs).includes(f.lead.email));
 }
});
test('missing, mixed or unknown environment pins and disabled flags fail closed',()=>{
 for(const patch of [{APP_ENV:'production'},{APP_ENV:'test'},{RENDER_SERVICE_ID:'other'},{SUPABASE_URL:env('qa').SUPABASE_URL},
  {PUBLIC_LEAD_NOTIFICATIONS_ENABLED:'false'},{PUBLIC_LEAD_NOTIFICATIONS_ACTIVATED_AT:''},
  {PUBLIC_LEAD_NOTIFICATIONS_ACTIVATED_AT:'2026-02-31T00:00:00.000Z'},{SENDGRID_FROM:'other@example.invalid'}])assert.equal(n.configuration({...env(),...patch}),null);
 assert.equal(n.configuration({NODE_ENV:'production'}),null);
});
test('unknown/mismatched tuples never notify; path slash variants match without arbitrary URLs',()=>{
 for(const id of Object.keys(n.FORMS)){
  const f=fixture('prod',id);assert.ok(n.formFor({...f.lead,source_path:f.lead.source_path+'/'}));
  for(const patch of [{form_id:'__proto__'},{form_type:'unknown'},{source_path:'/other'},{source_path:'https://evil.invalid/about'}])assert.equal(n.formFor({...f.lead,...patch}),null);
 }
});
test('mail rendering escapes visitor content and prevents visitor header/recipient injection',()=>{
 const f=fixture();f.lead.first_name='<script>bad</script>';f.lead.message='<img src=x onerror=alert(1)>\nnext';f.lead.email='a@example.invalid\r\nBcc:target@example.invalid';
 const m=n.buildMessage(f,{env:f.e,...render});assert.equal(m.replyTo,'info@alphasourceai.com');assert.doesNotMatch(m.html,/<script>|<img/);
 assert.match(m.html,/&lt;script&gt;/);assert.match(m.html,/<br>next/);assert.equal(m.to,'info@alphasourceai.com');
 for(const email of ['Name <a@example.invalid>','a@example.invalid,b@example.invalid','a@example.invalid\nb@example.invalid'])assert.equal(n.safeEmail(email),null);
});
test('noncanonical claims, non-submitted and pre-activation facts cannot reach sender',()=>{
 for(const change of [f=>f.lead.status='partial',f=>f.lead.submitted_at='2026-10-20T00:00:00Z',f=>f.claim.recipient='outsider@example.invalid',
  f=>f.claim.environment='qa',f=>f.claim.attempt_id='bad',f=>f.claim.lead_id=attempt]){
  const f=fixture();change(f);assert.throws(()=>n.buildMessage(f,{env:f.e,...render}),/held/);
 }
});
test('dev-only transport exception accepts only one exact development alert shape',()=>{
 const f=fixture('development'),m=n.buildMessage(f,{env:f.e,...render});assert.equal(n.devMessageAllowed(m,f.e),true);
 for(const patch of [{to:'sales@alphasourceai.com'},{cc:'development@alphasourceai.com'},{bcc:'bad@example.invalid'},
  {replyTo:f.lead.email},{from:'bad@example.invalid'},{personalizations:[{to:'bad@example.invalid'}]},
  {mailSettings:{bcc:{enable:true,email:'bad@example.invalid'}}},{headers:{Bcc:'bad@example.invalid'}},{categories:['other']},
  {customArgs:{...m.customArgs,extra:'x'}}])assert.equal(n.devMessageAllowed({...m,...patch},f.e),false);
 assert.equal(n.devMessageAllowed([m],f.e),false);assert.equal(n.devMessageAllowed(m,env('qa')),false);
});
test('provider202 is acknowledgement, not delivery; all other outcomes remain explicit',async()=>{
 for(const [provider,expected]of [[{statusCode:202,providerReference:'synthetic:reference'},'accepted'],[{statusCode:400},'rejected'],[{statusCode:500},'unknown'],[{skipped:true},'unknown'],[undefined,'unknown']]){
  const f=fixture(),records=[],db={rpc:async(name,args)=>{records.push({name,args});return{data:true};}};
  const r=await n.deliver(f,{db,send:async()=>provider,logger:{warn(){}}});assert.equal(r.status,expected);assert.equal(r.recipient_delivery_confirmed,false);
  assert.equal(records.length,1);assert.equal(records[0].args.p_status,expected);
 }
});
test('timeout or result persistence failure never retries the provider and sanitized logs exclude content',async()=>{
 for(const failRecord of [false,true]){
  const f=fixture(),logs=[];let sends=0,writes=0;
  const db={rpc:async()=>{writes++;if(failRecord)throw Error('synthetic');return{data:true};}};
  const r=await n.deliver(f,{db,send:async()=>{sends++;throw Error(f.lead.email+f.lead.message);},logger:{warn:(...args)=>logs.push(args)}});
  assert.equal(r.status,'unknown');assert.equal(sends,1);assert.equal(writes,1);assert.ok(!JSON.stringify(logs).includes(f.lead.email));
 }
});
test('no notification means no provider or record call',async()=>{
 const r=await n.deliver(null,{db:{rpc(){throw Error();}},send(){throw Error();}});assert.equal(r.status,'not_attempted');
});
test('malformed notification is held without mail or a secondary failure',async()=>{
 for(const value of [{},{claim:{}},{claim:{lead_id:leadId,attempt_id:attempt,status:'sending'},lead:{id:attempt}}])
  assert.equal((await n.deliver(value,{db:{rpc(){throw Error();}},send(){throw Error();}})).status,'held');
});
