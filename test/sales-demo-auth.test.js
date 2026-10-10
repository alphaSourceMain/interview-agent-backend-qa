'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {DEMO_CLIENT_ID,QA_URL}=require('../src/services/salesDemo');
const clientPath=require.resolve('../src/clients/supabase');const authPath=require.resolve('../src/middleware/auth');
async function exercise({extra=false,sales=false,path='/dashboard/rows'}={}){
  const db={auth:{getUser:async()=>({data:{user:{id:'rep',email:'rep@example.invalid',app_metadata:{sales_demo_client_id:DEMO_CLIENT_ID}}},error:null})},from(table){const q={select(){return q},eq(){return q},limit(){return q},maybeSingle:async()=>({data:null,error:null}),then(resolve){const data=table==='client_members'?[{client_id:DEMO_CLIENT_ID,role:'manager'},...(extra?[{client_id:'forbidden',role:'member'}]:[])]:table==='sales_reps'&&sales?[{user_id:'rep'}]:[];return Promise.resolve({data,error:null}).then(resolve)}};return q}};
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabaseAdmin:db,supabaseAnon:db}};delete require.cache[authPath];
  const req={method:'GET',originalUrl:path,headers:{},header:()=> 'Bearer dummy'};
  const res={statusCode:200,status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};let next=false;
  const before=process.env.SUPABASE_URL;process.env.SUPABASE_URL=QA_URL;
  try{await require(authPath).requireAuth(req,res,()=>{next=true});}finally{if(before===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=before;delete require.cache[authPath];delete require.cache[clientPath];}
  return {res,next};
}
test('verified demo manager may read fixture, extra membership or sales grant fails closed',async()=>{
  assert.equal((await exercise()).next,true);
  for(const options of [{extra:true},{sales:true},{path:'/admin/clients'},{path:'/files/resume-signed-url'},{path:'/dashboard/interviews/x/recording-url'}]){
    const r=await exercise(options);assert.equal(r.next,false);assert.equal(r.res.statusCode,403);
  }
});
