'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const guard=require('../src/config/guardedPricingDev'),n=require('../src/services/publicLeadNotifications');
const prior={...process.env};
const fakeMail={sendCalls:0,send(){this.sendCalls++;return Promise.resolve([{statusCode:202}]);},sendMultiple(){throw Error('must not call');},client:{request(){throw Error('must not call');}}};
const mailFile=require.resolve('@sendgrid/mail');require.cache[mailFile]={id:mailFile,filename:mailFile,loaded:true,exports:fakeMail};
class Stripe{constructor(){this.accounts={retrieve:async()=>({id:guard.DEV_STRIPE_ACCOUNT_ID})};this.balance={retrieve:async()=>({livemode:false})};this.webhookEndpoints={list:async()=>({data:[{id:'we_SYNTHETIC',status:'enabled',livemode:false,url:guard.DEV_BACKEND_URL+'/webhook/stripe',api_version:'2023-10-16'}],has_more:false})};}}
test('real dev bootstrap and factory allow only the validated single alert; SDK escape routes stay blocked',async()=>{
 try{
  for(const k of [...guard.OFF_FLAGS,...guard.FORBIDDEN_CREDENTIALS,...Object.keys(process.env).filter(k=>k.startsWith('STRIPE_'))])delete process.env[k];
  Object.assign(process.env,{APP_ENV:'development',RENDER_SERVICE_ID:guard.DEV_SERVICE_ID,SUPABASE_URL:guard.DEV_DATABASE_URL,
   FRONTEND_URL:guard.DEV_FRONTEND_URL,RENDER_EXTERNAL_URL:guard.DEV_BACKEND_URL,DEV_PRICING_SANDBOX_ENABLED:'true',
   DEV_STRIPE_ACCOUNT_ID:guard.DEV_STRIPE_ACCOUNT_ID,DEV_USAGE_BILLING_CLIENT_ID:'11111111-1111-4111-8111-111111111111',
   USAGE_BILLING_CRON_SECRET:'a'.repeat(64),STRIPE_SECRET_KEY:'rk_test_SYNTHETIC',STRIPE_WEBHOOK_SECRET:'whsec_SYNTHETIC',
   SENDGRID_FROM:'info@alphasourceai.com',PUBLIC_LEAD_NOTIFICATIONS_ENABLED:'true',PUBLIC_LEAD_NOTIFICATIONS_ACTIVATED_AT:'2026-10-21T00:00:00.000Z'});
  await guard.initializeDevBillingSandbox({Stripe});assert.equal(guard.isDevBillingSandbox(),true);
  const mail=require('../src/clients/sendgridFactory')(),msg={to:'development@alphasourceai.com',from:'info@alphasourceai.com',replyTo:'info@alphasourceai.com',
   subject:'[NON-PRODUCTION] New Homepage contact',html:'Synthetic only',text:'Synthetic only',categories:['public_lead_notification'],
   customArgs:{email_category:'public_lead_notification',lead_id:'11111111-1111-4111-8111-111111111111',attempt_id:'22222222-2222-4222-8222-222222222222',form_id:'home-contact'}};
  assert.equal(n.devMessageAllowed(msg),true);await mail.send(msg);assert.equal(fakeMail.sendCalls,1);
  for(const bad of [{...msg,to:'sales@alphasourceai.com'},{...msg,bcc:'outsider@example.invalid'},[msg]])assert.throws(()=>mail.send(bad),{code:guard.CODE});
  assert.throws(()=>mail.sendMultiple(msg),{code:guard.CODE});assert.throws(()=>mail.client.request({body:msg}),{code:guard.CODE});
  process.env.PUBLIC_LEAD_NOTIFICATIONS_ENABLED='false';assert.equal(guard.isDevBillingSandbox(),false);
  assert.throws(()=>mail.send(msg),{code:guard.CODE});assert.equal(fakeMail.sendCalls,1);
 }finally{for(const k of Object.keys(process.env))if(!Object.hasOwn(prior,k))delete process.env[k];Object.assign(process.env,prior);}
});
