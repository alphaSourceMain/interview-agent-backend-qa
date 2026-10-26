'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const request=require('supertest');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const db=createFakeSupabase({retail_sales_policy_events:[]});
function inject(name,exports){const p=require.resolve(name);require.cache[p]={id:p,filename:p,loaded:true,exports};}
inject('../src/clients/supabase',{supabaseAdmin:db});
inject('../src/middleware/auth',{requireAuth(req,res,next){if(req.headers.authorization!=='Bearer synthetic-admin')return res.status(401).json({error:'unauthorized'});req.user={id:'11111111-1111-4111-8111-111111111111'};next();}});
inject('../src/middleware/requireAdmin',{requireAdmin(req,res,next){if(req.headers['x-synthetic-role']!=='admin')return res.status(403).json({error:'not_admin'});next();}});
const app=express();app.use(express.json());app.use('/api/alphascreen',require('../src/routes/public/alphascreen'));
app.use('/admin',require('../src/routes/admin/publicPurchases'));
test('OFF denies even direct public intake before validation, rate-limit, insert or email',async()=>{
  const start=db.calls.length;
  const r=await request(app).post('/api/alphascreen/purchase-intents').send({buyer_email:'never-sent@example.invalid'});
  assert.equal(r.status,409);assert.equal(r.body.code,'retail_sales_disabled');
  assert.ok(db.calls.slice(start).every(c=>c.table==='retail_sales_policy_events'));
  assert.equal(db.tables?.public_purchase_intents?.length||0,0);
  const missing=await request(app).get('/api/alphascreen/checkout-status');assert.equal(missing.status,400);
  assert.equal(missing.body.code,'checkout_lookup_required');
});
test('public policy is safe/no-store; admin controls retain active-admin guards and strict confirmation',async()=>{
  const response=await request(app).get('/api/alphascreen/packages');
  assert.equal(response.status,200);assert.equal(response.body.retail_sales_policy.enabled,false);
  assert.match(response.headers['cache-control'],/no-store/);
  assert.doesNotMatch(JSON.stringify(response.body),/changed_by_user_id|sk_live_|sk_test_/);
  assert.equal((await request(app).get('/admin/public-purchases/retail-sales')).status,401);
  assert.equal((await request(app).get('/admin/public-purchases/retail-sales').set('Authorization','Bearer synthetic-admin')).status,403);
  const admin=()=>request(app).post('/admin/public-purchases/retail-sales').set('Authorization','Bearer synthetic-admin').set('x-synthetic-role','admin');
  assert.equal((await admin().send({enabled:true,expected_version:0})).status,422);
  let args;db.rpc=async(name,value)=>{args=value;return{data:{enabled:true,version:1},error:null}};
  const saved=await admin().send({enabled:true,expected_version:0,confirmed:true});assert.equal(saved.status,200);
  assert.equal(args.p_actor,'11111111-1111-4111-8111-111111111111');assert.equal(saved.body.enabled,true);
});
