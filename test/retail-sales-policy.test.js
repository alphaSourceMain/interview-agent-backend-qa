'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {readRetailSalesPolicy,assertRetailSalesEnabled,setRetailSalesPolicy}=require('../src/services/retailSalesPolicy');
const {retailContentForMode}=require('../src/services/retailSalesContent');
const {buildSupportVoicePrompt}=require('../src/services/supportVoiceKnowledge');
const actor='11111111-1111-4111-8111-111111111111';
test('retail policy empty defaults OFF; missing/malformed/error never enables sales',async()=>{
  assert.deepEqual(await readRetailSalesPolicy(createFakeSupabase()),{enabled:false,version:0,changed_at:null});
  await assert.rejects(assertRetailSalesEnabled(createFakeSupabase()),e=>e.status===409&&e.code==='retail_sales_disabled');
  for(const db of [{from(){throw Error('missing')}},createFakeSupabase({retail_sales_policy_events:[{enabled:'true',version:1}]})])
    await assert.rejects(readRetailSalesPolicy(db),/unavailable/);
  const db=createFakeSupabase({retail_sales_policy_events:[{enabled:false,version:1},{enabled:true,version:2}]});
  assert.equal((await readRetailSalesPolicy(db)).enabled,true);await assertRetailSalesEnabled(db);
});
test('retail save requires explicit confirmation, strict version/boolean, no actor injection',async()=>{
  let calls=0;const db={rpc:async(name,args)=>{calls++;assert.equal(name,'set_retail_sales_enabled');assert.equal(args.p_actor,actor);return{data:{enabled:true,version:1}}}};
  for(const body of [{enabled:true,expected_version:0},{enabled:'true',expected_version:0,confirmed:true},{enabled:true,expected_version:-1,confirmed:true},{enabled:true,expected_version:0,confirmed:true,actor}])
    await assert.rejects(setRetailSalesPolicy(db,body,actor),/invalid_retail_sales_confirmation/);
  assert.equal(calls,0);
  assert.equal((await setRetailSalesPolicy(db,{enabled:true,expected_version:0,confirmed:true},actor)).enabled,true);
  assert.equal(calls,1);
  await assert.rejects(setRetailSalesPolicy({rpc:async()=>({error:{message:'retail_sales_policy_changed'}})},{enabled:false,expected_version:0,confirmed:true},actor),e=>e.status===409);
  await assert.rejects(setRetailSalesPolicy({rpc:async()=>({error:{message:'unknown'}})},{enabled:false,expected_version:0,confirmed:true},actor),/unavailable/);
});
test('original support knowledge is byte-preserved ON; OFF uses only current 12-month new-purchase guidance',()=>{
  const original=JSON.parse(fs.readFileSync(path.join(__dirname,'../src/content/support-voice-knowledge.json')));
  const before=JSON.stringify(original);assert.equal(retailContentForMode(original,true),original);
  const off=retailContentForMode(original,false);assert.equal(JSON.stringify(original),before);
  const all=[...off.dashboard.faq_sections.flatMap(s=>s.items),...off.public.faq_sections.flatMap(s=>s.items)];
  const price=all.find(i=>i.question==='How does pricing work?').answer;
  assert.match(price,/\$349 monthly for 12 months/);assert.match(price,/\$649 monthly for 12 months/);
  assert.match(price,/\$3,300 prepaid annually/);assert.match(price,/\$6,500 prepaid annually/);
  assert.doesNotMatch(price,/\$1,200|\$1,950|\$2,100|\$3,600/);
  assert.match(all.find(i=>i.question==='When does my membership term start?').answer,/earlier 3- and 6-month terms/);
  const onPrompt=buildSupportVoicePrompt({handoff:false,retailSalesEnabled:true});
  const offPrompt=buildSupportVoicePrompt({handoff:false,retailSalesEnabled:false});
  assert.notEqual(offPrompt.promptSha256,onPrompt.promptSha256);assert.ok(offPrompt.promptBytes<65536);
  assert.match(offPrompt.prompt,/new online retail signup is currently unavailable/);
});
test('existing public routes are preserved; policy admission precedes all intake effects',()=>{
  const route=fs.readFileSync(path.join(__dirname,'../src/routes/public/alphascreen/purchaseIntents.js'),'utf8');
  const intake=route.slice(route.indexOf("router.post('/purchase-intents'"));
  assert.ok(intake.indexOf('await assertRetailSalesEnabled')<intake.indexOf('normalizePurchaseIntentInput'));
  assert.ok(intake.indexOf('await assertRetailSalesEnabled')<intake.indexOf('enforceRetailRateLimit'));
  assert.equal((route.match(/assertRetailSalesEnabled\(supabaseAdmin\)/g)||[]).length,1);
  const admin=fs.readFileSync(path.join(__dirname,'../src/routes/admin/publicPurchases.js'),'utf8');
  assert.match(admin,/router.post\('\/public-purchases\/retail-sales',requireAuth,requireAdmin/);
  assert.match(admin,/setRetailSalesPolicy\(supabaseAdmin,req.body,req.user\?\.id\)/);
  const fence=fs.readFileSync(path.join(__dirname,'../src/config/guardedPricingDev.js'),'utf8');
  assert.match(fence,/'\/admin\/public-purchases\/retail-sales'/);
});
