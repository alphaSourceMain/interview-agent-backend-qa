'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recognizeRuntimeClient}=require('../src/runtime-membership');
const owner='jason@gardner.ltd',id='11111111-1111-4111-8111-111111111111';
async function fixture(values){const prior=global.fetch,requests=[];global.fetch=async(url,options)=>{
  requests.push({url,options});const value=values.shift();if(value instanceof Error)throw value;
  return Response.json(value.body,{status:value.status||200,headers:value.headers});
};try{return {value:await recognizeRuntimeClient('synthetic-token',owner,Date.now()+60000),requests};}finally{global.fetch=prior;}}
const count=n=>({body:[],headers:{'content-range':'*/'+n}}),absent={body:{code:'42703'},status:400};
test('unknown confirmed person selects static public without member read',async()=>{const r=await fixture([{body:null}]);assert.equal(r.value,false);assert.equal(r.requests.length,1);});
test('zero counts vs present membership distinguished; no row data retrieved',async()=>{
  for(const numbers of [[0,0],[1,0],[0,1]]){const r=await fixture([{body:id},...numbers.map(count)]);assert.equal(r.value,numbers.some(n=>n>0));assert.equal(r.requests.length,3);
    for(const q of r.requests.slice(1)){assert.equal(new URL(q.url).searchParams.get('limit'),'0');assert.equal(new URL(q.url).searchParams.get('select'),'clients!inner(id)');}}
});
test('one legacy column absent allowed; both absent or any failed query holds sending',async()=>{
  assert.equal((await fixture([{body:id},absent,count(1)])).value,true);
  for(const responses of [[{body:id},absent,absent],[{body:id},{body:{code:'PRIVATE'},status:500}],
    [{body:id},{body:[{private:'data'}],headers:{'content-range':'*/1'}}],
    [{body:id},{body:[],headers:{'content-range':'*/9007199254740993'}}],
    [{body:id},new Error('transport')],[{body:{private:'auth-row'}}]])await assert.rejects(fixture(responses));
});
test('nonowner lookup cannot query DB',async()=>{await assert.rejects(recognizeRuntimeClient('synthetic','other@example.invalid',Date.now()+60000));});
