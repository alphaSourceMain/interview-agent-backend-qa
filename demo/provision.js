'use strict';
const { DEMO_CLIENT_ID, isQa } = require('../src/lib/salesDemo');
const USERS = [{email:'michael@alphasourceai.com',name:'Michael Afesi'}, {email:'russell@alphasourceai.com',name:'Russell Muchenge'}];
function checked(result) { if (result.error) throw new Error('demo_provision_lookup_failed'); return result.data; }
async function verifyGrants(db, user) {
  const grants=checked(await db.from('client_members').select('client_id,role').eq('user_id',user.id));
  if (grants?.length!==1 || grants[0].client_id!==DEMO_CLIENT_ID || grants[0].role!=='manager') throw new Error('demo_provision_grant_mismatch');
  for (const [table,col,value] of [['admins','user_id',user.id],['admins','email',user.email],['sales_reps','user_id',user.id],['sales_reps','email',user.email]]) {
    if (checked(await db.from(table).select('*').eq(col,value)).length) throw new Error('demo_provision_extra_grant');
  }
}
// No passwords, token logging or pre-existing-account updates. Both identities
// and all memberships are verified. Owner will distribute access later;
// this function never generates setup links or sends email/invitations.
async function provision({db,env=process.env,apply=false}) {
  if (!isQa(env)) throw new Error('demo_provision_wrong_environment');
  const found=[];
  for(let page=1;page<=100;page++) {
    const data=checked(await db.auth.admin.listUsers({page,perPage:1000}));
    found.push(...data.users);
    if(data.users.length<1000)break;
    if(page===100)throw new Error('demo_provision_directory_incomplete');
  }
  for(const u of USERS) {
    if(found.some(x=>x.email?.toLowerCase()===u.email))throw new Error('demo_provision_email_exists');
    for(const [table,col] of [['admins','email'],['client_members','email'],['sales_reps','email'],['sales_team_members','workspace_email']]) {
      if(checked(await db.from(table).select('*').eq(col,u.email)).length)throw new Error('demo_provision_directory_collision');
    }
  }
  const client=checked(await db.from('clients').select('id,parent_client_id').eq('id',DEMO_CLIENT_ID).single());
  if(!client || client.parent_client_id)throw new Error('demo_provision_client_missing');
  if(checked(await db.from('clients').select('id').eq('parent_client_id',DEMO_CLIENT_ID)).length)throw new Error('demo_provision_child_scope');
  if(!apply)return {ready:true,users:USERS.map(u=>u.email)};
  const created=[];
  for(const u of USERS) {
    const data=checked(await db.auth.admin.createUser({email:u.email,email_confirm:true,user_metadata:{name:u.name},app_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}}));
    const user=data.user;
    if(!user?.id || user.email!==u.email || user.app_metadata?.sales_demo_client_id!==DEMO_CLIENT_ID)throw new Error('demo_provision_identity_mismatch');
    created.push(user);
    checked(await db.from('client_members').insert({client_id:DEMO_CLIENT_ID,user_id:user.id,user_id_uuid:user.id,role:'manager',name:u.name,email:u.email}));
  }
  for(const user of created)await verifyGrants(db,user);
  return {created:created.map(u=>({id:u.id,email:u.email})),client_id:DEMO_CLIENT_ID};
}
module.exports={provision,verifyGrants,USERS};
