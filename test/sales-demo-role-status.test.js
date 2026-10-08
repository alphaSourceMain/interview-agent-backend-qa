'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DEMO_CLIENT_ID,QA_URL,uuid}=require('../src/lib/salesDemo');

test('verified global-admin token cannot use the generic writer or RPC on a demo role',async()=>{
  const clientPath=require.resolve('../src/lib/supabaseClient');
  const authPath=require.resolve('../src/middleware/auth');
  const routePath=require.resolve('../routes/roles');
  const previous=[clientPath,authPath,routePath].map(p=>require.cache[p]);
  let writes=0,rpcs=0,verified=0;
  const db={auth:{getUser:async token=>{assert.equal(token,'admin-test-token');verified++;return {data:{user:{id:'admin',email:'admin@example.invalid',app_metadata:{}}},error:null}}},
    rpc(){rpcs++;throw Error('RPC must not run')},from(table){
      assert.equal(table,'admins','no generic roles lookup may run');
      const q={select(){return q},eq(){return q},update(){writes++;return q},maybeSingle:async()=>({data:{id:'admin'},error:null})};return q;
    }};
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabase:db,supabaseAdmin:db,supabaseAnon:db}};
  delete require.cache[authPath];delete require.cache[routePath];
  const old=process.env.SUPABASE_URL;process.env.SUPABASE_URL=QA_URL;
  try{
    const router=require(routePath);
    const route=router.stack.find(l=>l.route?.path==='/:id/status').route;
    const req={method:'PATCH',originalUrl:`/roles/${uuid(100)}/status`,params:{id:uuid(100)},query:{client_id:DEMO_CLIENT_ID},body:{status:'inactive'},headers:{},header:()=> 'Bearer admin-test-token'};
    const res={statusCode:200,status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
    for(const layer of route.stack){let next=false;await layer.handle(req,res,()=>{next=true});if(!next)break;}
    assert.equal(verified,1);assert.equal(req.isGlobalAdmin,true);
    assert.equal(res.statusCode,403);assert.equal(res.body.error,'demo_access_denied');
    assert.equal(writes,0);assert.equal(rpcs,0);
  }finally{
    if(old===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=old;
    [clientPath,authPath,routePath].forEach((p,i)=>{if(previous[i])require.cache[p]=previous[i];else delete require.cache[p]});
  }
});
