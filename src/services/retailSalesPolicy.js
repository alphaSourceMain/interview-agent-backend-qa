'use strict';
function fail(code,status=503){throw Object.assign(new Error(code),{code,status});}
function validatePolicy(value){
  if(!value||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.version)||value.version<0)
    fail('retail_sales_policy_unavailable');
  return {enabled:value.enabled,version:value.version,changed_at:value.changed_at||null};
}
async function readRetailSalesPolicy(db){
  try{
    const result=await db.from('retail_sales_policy_events').select('version,enabled,changed_at')
      .order('version',{ascending:false}).limit(1).maybeSingle();
    if(!result||result.error)fail('retail_sales_policy_unavailable');
    return result.data==null?{enabled:false,version:0,changed_at:null}:validatePolicy(result.data);
  }catch(_){fail('retail_sales_policy_unavailable');}
}
async function assertRetailSalesEnabled(db){
  if(!(await readRetailSalesPolicy(db)).enabled)fail('retail_sales_disabled',409);
}
async function setRetailSalesPolicy(db,body,actor){
  if(!body||Object.keys(body).some(k=>!['enabled','confirmed','expected_version'].includes(k))
    ||typeof body.enabled!=='boolean'||body.confirmed!==true
    ||!Number.isSafeInteger(body.expected_version)||body.expected_version<0)fail('invalid_retail_sales_confirmation',422);
  const result=await db.rpc('set_retail_sales_enabled',{p_enabled:body.enabled,p_expected_version:body.expected_version,p_actor:actor});
  if(result?.error){
    if(result.error.message==='retail_sales_policy_changed')fail('retail_sales_policy_changed_refresh_before_confirming',409);
    fail('retail_sales_policy_unavailable');
  }
  return validatePolicy(result?.data);
}
module.exports={readRetailSalesPolicy,assertRetailSalesEnabled,setRetailSalesPolicy};
