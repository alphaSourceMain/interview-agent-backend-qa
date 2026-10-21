'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS=/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const INFO='info@alphasourceai.com',DEVELOPMENT='development@alphasourceai.com';
const PINS=Object.freeze({
 development:{environment:'dev',service:'srv-db5bfjlckfvc739klcvg',database:'hjombgfusdgsqipimhnc',origin:'https://interview-agent-frontend-qa.onrender.com'},
 qa:{environment:'qa',service:'srv-d2s94oumcj7s73abnq70',database:'yjjxzxoghlpguquknyso',origin:'https://alphasourceai-com.onrender.com'},
 prod:{environment:'production',service:'srv-d2s94oumcj7s73abnq80',database:'rytlclkkcvvnkoncfaid',origin:'https://www.alphasourceai.com'},
});
const FORMS=Object.freeze({
 'home-contact':{type:'contact',path:'/',recipient:INFO,label:'Homepage contact'},
 'about-contact':{type:'contact',path:'/about',recipient:'sales@alphasourceai.com',label:'About demo request'},
 'alphascreen-demo':{type:'demo',path:'/alphascreen',recipient:'sales@alphasourceai.com',label:'alphaScreen demo request'},
 'alphascreen-pricing-demo':{type:'demo',path:'/alphascreen/pricing',recipient:'sales@alphasourceai.com',label:'Pricing sales inquiry'},
});
function configuration(env=process.env){
 const pin=PINS[env.APP_ENV],raw=env.PUBLIC_LEAD_NOTIFICATIONS_ACTIVATED_AT;
 if(!pin||env.RENDER_SERVICE_ID!==pin.service||env.SUPABASE_URL!==`https://${pin.database}.supabase.co`
   ||env.SENDGRID_FROM!==INFO||env.PUBLIC_LEAD_NOTIFICATIONS_ENABLED!=='true'
   ||typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
   ||!Number.isFinite(Date.parse(raw))||new Date(raw).toISOString()!==raw)return null;
 return {...pin,activatedAt:raw};
}
function formFor(lead){
 const form=Object.hasOwn(FORMS,lead?.form_id)?FORMS[lead.form_id]:null;
 const path=String(lead?.source_path||'').replace(/\/+$/,'')||'/';
 return form&&form.type===lead.form_type&&path===form.path?form:null;
}
function recipientFor(lead,config){const f=formFor(lead);return f&&config?config.environment==='production'?f.recipient:DEVELOPMENT:null;}
function safeEmail(value){return typeof value==='string'&&value.length<=254&&ADDRESS.test(value)&&!/[\r\n]/.test(value)?value.toLowerCase():null;}
function devMessageAllowed(message,env=process.env){
 const c=configuration(env);if(c?.environment!=='dev'||!message||typeof message!=='object'||Array.isArray(message))return false;
 const keys=['to','from','replyTo','subject','html','text','categories','customArgs'];
 if(Object.keys(message).length!==keys.length||!Object.keys(message).every(k=>keys.includes(k))
   ||message.to!==DEVELOPMENT||message.from!==INFO||message.replyTo!==INFO
   ||typeof message.subject!=='string'||/[\r\n]/.test(message.subject)
   ||typeof message.text!=='string'||typeof message.html!=='string'
   ||JSON.stringify(message.categories)!=='["public_lead_notification"]')return false;
 const a=message.customArgs;
 return !!a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===4
   &&a.email_category==='public_lead_notification'&&UUID.test(a.lead_id)&&UUID.test(a.attempt_id)&&Object.hasOwn(FORMS,a.form_id);
}
function buildMessage(notification,{env=process.env,buildBrandedEmailShell,escapeHtml}={}){
 const config=configuration(env),claim=notification?.claim,lead=notification?.lead,form=formFor(lead);
 if(!config||!claim||!lead||!form||lead.status!=='submitted'||!UUID.test(lead.id)
   ||!UUID.test(claim.attempt_id)||claim.lead_id!==lead.id||claim.environment!==config.environment
   ||claim.form_id!==lead.form_id||claim.recipient!==recipientFor(lead,config)||claim.status!=='sending'
   ||!Number.isFinite(Date.parse(lead.submitted_at))||Date.parse(lead.submitted_at)<Date.parse(config.activatedAt))throw Error('public_lead_notification_held');
 const replyTo=config.environment==='production'?safeEmail(lead.email)||INFO:INFO;
 const title=`${config.environment==='production'?'':'[NON-PRODUCTION] '}New ${form.label}`;
 const entries=[['Name',[lead.first_name,lead.last_name].filter(Boolean).join(' ')],['Email',lead.email||'Not provided'],
   ['Phone',lead.phone||'Not provided'],['Submitted',lead.submitted_at],['Page',form.path],['Message',lead.message||'No message provided']];
 const text=entries.map(([k,v])=>`${k}: ${v}`).join('\n')+`\n\nReview in admin: ${config.origin}/admin/public-analytics\nLead reference: ${lead.id}`;
 return {to:claim.recipient,from:INFO,replyTo,subject:title,text,
   html:buildBrandedEmailShell({title,preheader:'A website inquiry was submitted.',helpEmail:'',footerNote:'Internal website lead notification.',
     contentHtml:entries.map(([k,v])=>`<p><strong>${escapeHtml(k)}:</strong><br>${escapeHtml(v).replace(/\n/g,'<br>')}</p>`).join('')
       +`<p><a href="${config.origin}/admin/public-analytics">Review leads in admin</a></p><p>Lead reference: ${escapeHtml(lead.id)}</p>`}),
   categories:['public_lead_notification'],customArgs:{email_category:'public_lead_notification',lead_id:lead.id,attempt_id:claim.attempt_id,form_id:claim.form_id}};
}
async function deliver(notification,{db,send,logger=console}={}){
 if(!notification)return {status:'not_attempted'};
 if(!UUID.test(notification.claim?.lead_id)||!UUID.test(notification.claim?.attempt_id)
   ||notification.claim.status!=='sending'||notification.lead?.id!==notification.claim.lead_id)
   return {status:'held'};
 const claim=notification.claim;let status='unknown',reference=null,errorCode=null;
 try{
   const r=await send(notification);
   if(r?.statusCode===202&&!r.skipped){status='accepted';reference=/^[A-Za-z0-9._:-]{1,200}$/.test(r.providerReference||'')?r.providerReference:null;}
   else if(Number.isInteger(r?.statusCode)&&r.statusCode>=400&&r.statusCode<500)status='rejected';
   else errorCode='provider_result_unknown';
 }catch(e){
   const code=e?.code??e?.response?.statusCode;
   if(Number.isInteger(code)&&code>=400&&code<500){status='rejected';errorCode='provider_rejected';}
   else errorCode='provider_result_unknown';
 }
 try{const r=await db.rpc('record_public_lead_notification',{p_lead_id:claim.lead_id,p_attempt_id:claim.attempt_id,p_status:status,p_reference:reference,p_error_code:errorCode});
   if(r.error||r.data!==true)throw Error();
 }catch(_){logger.warn?.('[public-leads] notification_result_unconfirmed',{lead_id:claim.lead_id,attempt_id:claim.attempt_id});return {status:'unknown'};}
 if(status!=='accepted')logger.warn?.('[public-leads] notification_not_accepted',{lead_id:claim.lead_id,attempt_id:claim.attempt_id,status});
 return {status,provider_acknowledged:status==='accepted',recipient_delivery_confirmed:false};
}
module.exports={PINS,FORMS,configuration,formFor,recipientFor,safeEmail,devMessageAllowed,buildMessage,deliver};
