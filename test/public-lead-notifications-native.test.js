'use strict';
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const enabled=process.env.PUBLIC_LEADS_NATIVE==='true',pg='/opt/homebrew/opt/postgresql@17/bin/psql';
function sql(s){return execFileSync(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{input:s,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`;
const row=(n,status='submitted',form='home-contact')=>({id:id(n),status,form_id:form,form_type:form==='home-contact'||form==='about-contact'?'contact':'demo',source_path:form==='home-contact'?'/':form==='about-contact'?'/about/':form==='alphascreen-demo'?'/alphascreen/':'/alphascreen/pricing/',email:'synthetic@example.invalid',first_name:'Synthetic',message:status==='submitted'?'authored message':null});
const save=(r,environment='production',active="'2000-01-01T00:00:00Z'")=>`set role service_role;select public.save_public_lead_capture('${JSON.stringify(r)}','${environment}',${active});`;
before(()=>{if(!enabled)return;assert.ok(process.env.PGHOST?.startsWith('/private/tmp/lead-alerts-native-'));
 sql('create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to service_role;');
 sql(fs.readFileSync(path.join(__dirname,'../docs/public_analytics_lead_capture.sql'),'utf8'));
 sql('grant select,insert,update on public.public_lead_drafts to service_role;');
 sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261021210156_public_lead_notification_delivery.sql'),'utf8'));
});
test('native first submitted transition freezes canonical payload, tuple, timestamps and claim',{skip:!enabled},()=>{
 const first=JSON.parse(sql(save(row(1))));assert.equal(first.notification.claim.recipient,'info@alphasourceai.com');
 const snapshot=sql(`select md5(to_jsonb(l)::text) from public.public_lead_drafts l where id='${id(1)}';`);
 for(const status of ['partial','abandoned','submitted']){const r=JSON.parse(sql(save({...row(1,status,'alphascreen-demo'),email:'changed@example.invalid'})));assert.equal(r.item.status,'submitted');assert.equal(r.notification,null);}
 assert.equal(sql(`select md5(to_jsonb(l)::text) from public.public_lead_drafts l where id='${id(1)}';`),snapshot);
 assert.equal(sql(`select count(*) from public.public_lead_notifications where lead_id='${id(1)}';`),'1');
});
test('native drafts, disabled-first-submit, old-first-submit and unknown forms never catch up',{skip:!enabled},()=>{
 assert.equal(JSON.parse(sql(save(row(2,'partial')))).notification,null);
 assert.ok(JSON.parse(sql(save(row(2)))).notification);
 for(const n of [3,4,5]){
  const first=n===3?save(row(n),'production','null'):n===4?save(row(n),'production',"'2999-01-01Z'"):save({...row(n),form_id:'unknown'});
  assert.equal(JSON.parse(sql(first)).notification,null);assert.equal(JSON.parse(sql(save(row(n)))).notification,null);
 }
});
test('native routing matches all form/environment pairs and has no public table or RPC access',{skip:!enabled},()=>{
 let n=10;for(const env of ['dev','qa','production'])for(const form of ['home-contact','about-contact','alphascreen-demo','alphascreen-pricing-demo']){
  const r=JSON.parse(sql(save(row(n++, 'submitted',form),env)));assert.equal(r.notification.claim.recipient,env==='production'?form==='home-contact'?'info@alphasourceai.com':'sales@alphasourceai.com':'development@alphasourceai.com');
 }
 for(const role of ['anon','authenticated']){
  assert.throws(()=>sql(`set role ${role};select * from public.public_lead_notifications;`),e=>/permission denied/.test(String(e.stderr)));
  assert.throws(()=>sql(`set role ${role};select public.save_public_lead_capture('{}');`),e=>/permission denied/.test(String(e.stderr)));
  assert.throws(()=>sql(`set role ${role};select public.record_public_lead_notification('${id(1)}','${id(2)}','accepted');`),e=>/permission denied/.test(String(e.stderr)));
 }
 assert.equal(sql("select relrowsecurity from pg_class where oid='public.public_lead_notifications'::regclass;"),'t');
});
test('native accepted/rejected/unknown and crashed sending are terminal and cannot change immutable recipient',{skip:!enabled},()=>{
 let n=30;for(const status of ['accepted','rejected','unknown','sending']){
  const r=JSON.parse(sql(save(row(n)))),c=r.notification.claim;
  if(status!=='sending')assert.equal(sql(`set role service_role;select public.record_public_lead_notification('${c.lead_id}','${c.attempt_id}','${status}','synthetic:ack');`),'t');
  assert.equal(JSON.parse(sql(save(row(n)))).notification,null);
  if(status!=='sending')assert.equal(sql(`set role service_role;select public.record_public_lead_notification('${c.lead_id}','${c.attempt_id}','accepted');`),'f');
  if(status!=='sending')assert.throws(()=>sql(`set role service_role;update public.public_lead_notifications set status='sending' where lead_id='${id(n)}';`),e=>/lead_notification_terminal/.test(String(e.stderr)));
  assert.throws(()=>sql(`set role service_role;update public.public_lead_notifications set recipient='sales@alphasourceai.com' where lead_id='${id(n)}';`),e=>/permission denied/.test(String(e.stderr)));n++;
 }
});
test('native concurrent first-submit/submit/autosave serializes to one frozen submission and one claim',{skip:!enabled},async()=>{
 const child=spawn(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 const locked=new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('LOCKED'))resolve();});child.on('error',reject);});
 const ended=new Promise(resolve=>child.on('close',code=>resolve(code)));child.stderr.on('data',x=>stderr+=x);
 child.stdin.end(`begin;${save(row(50))}select 'LOCKED';select pg_sleep(0.6);commit;`);await locked;
 const start=Date.now(),second=JSON.parse(sql(save({...row(50),email:'other@example.invalid'})));assert.ok(Date.now()-start>=250);assert.equal(second.notification,null);
 assert.equal(await ended,0,stderr);assert.equal(JSON.parse(sql(save(row(50,'partial')))).item.status,'submitted');
 assert.equal(sql(`select count(*) from public.public_lead_notifications where lead_id='${id(50)}';`),'1');
});
