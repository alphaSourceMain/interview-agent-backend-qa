'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../src/projected-mounts'),'utf8');
const names={readClient:'alphy-read-client.json',readGrant:'alphy-read-grant.json',sendClient:'alphy-send-client.json',sendGrant:'alphy-send-grant.json',keys:'alphy-runtime-keys.json'};
const manifest=Object.fromEntries(Object.keys(names).map(k=>[k,{uid:0,mode:'0640'}])),wanted=['readClient','readGrant','keys'];
function fixture(change={}){
  const root='/etc/secrets',version='..2026_10_08_16_23_30.2278434368',other='..2026_10_08_16_23_31.2278434368';
  const entries=new Map(),links=new Map(),opened=[],closed=[],buffers=[];let ino=0n,readCount=0,fstats=0;
  const stat=(kind,mode,gid=1000n)=>({kind,dev:1n,ino:++ino,uid:0n,gid,mode:BigInt(mode),size:24n,nlink:kind==='dir'?2n:1n,mtimeNs:1n,ctimeNs:1n,
    isDirectory(){return this.kind==='dir';},isFile(){return this.kind==='file';},isSymbolicLink(){return this.kind==='link';}});
  entries.set('/etc',stat('dir',0o755,0n));entries.set(root,stat('dir',0o3777));entries.set(root+'/..data',stat('link',0o777));links.set(root+'/..data',version);
  for(const v of [version,other]){entries.set(root+'/'+v,stat('dir',0o2755));for(const name of Object.values(names)){const s=stat('file',0o640);s.content=Buffer.from('{"fixture":"test-data"}');s.size=BigInt(s.content.length);entries.set(root+'/'+v+'/'+name,s);}}
  for(const name of Object.values(names)){entries.set(root+'/'+name,stat('link',0o777));links.set(root+'/'+name,'..data/'+name);}
  if(change.path)Object.assign(entries.get(change.path.replace('VERSION',version)),change.patch);
  if(change.link)links.set(change.link.path,change.link.target);
  const io={constants:{O_RDONLY:0,O_NOFOLLOW:256,O_NONBLOCK:512},lstatSync(path,options){assert.equal(options.bigint,true);const s=entries.get(path);if(!s)throw Error('PRIVATE_FS_DETAIL');return{...s};},
    readlinkSync(path){if(change.rotation&&readCount>0&&path===root+'/..data')return other;return links.get(path);},
    openSync(path,flags){assert.equal(flags,768);opened.push(path);return opened.length-1;},
    fstatSync(fd,options){assert.equal(options.bigint,true);fstats++;const s={...entries.get(opened[fd])};if(change.inode&&fstats===1)s.ino++;if(change.timestamp&&fstats===2)s.ctimeNs++;return s;},
    readSync(fd,b){readCount++;buffers.push(b);const bytes=entries.get(opened[fd]).content;bytes.copy(b);return change.shortRead?bytes.length-1:bytes.length;},
    closeSync(fd){closed.push(fd);}};
  const host={platform:change.platform||'linux',getuid:()=>change.uid??1000,geteuid:()=>change.euid??1000,getgid:()=>change.gid??1000,getegid:()=>change.egid??1000};
  const sandbox={module:{exports:{}},require(name){assert.equal(name,'node:fs');return io;},process:host,Buffer,TextDecoder};
  vm.runInNewContext(source,sandbox,{filename:'projected-mounts.fixture.js'});
  return{api:sandbox.module.exports,io,opened,closed,buffers};
}
test('exact projected pins inspect without opens; draft opens only three fixed backing files and wipes bytes',()=>{
  const f=fixture();assert.deepEqual(JSON.parse(JSON.stringify(f.api.inspectProjectedMounts())),manifest);assert.equal(f.opened.length,0);
  const values=f.api.readProjectedJsonSet(wanted,manifest);assert.equal(values.readClient.fixture,'test-data');assert.equal(f.opened.length,3);
  assert.ok(f.opened.every(p=>!p.includes('send-')));assert.equal(f.closed.length,3);assert.ok(f.buffers.every(b=>b.every(v=>v===0)));
});
test('auto mode may open all five; no duplicate or unknown file set permitted',()=>{
  const f=fixture();assert.equal(Object.keys(f.api.readProjectedJsonSet(Object.keys(names),manifest)).length,5);
  for(const set of [[],['keys'],[...wanted,'other'],[...wanted,'keys']])assert.throws(()=>f.api.readProjectedJsonSet(set,manifest));
});
for(const change of [{platform:'darwin'},{uid:0},{euid:0},{gid:0},{egid:0}])test('host identity holds before metadata/open: '+Object.keys(change)[0],()=>{
  const f=fixture(change);assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
});
const root='/etc/secrets',leaf=root+'/VERSION/alphy-read-client.json';
for(const change of [
  {path:'/etc',patch:{uid:1000n}},{path:'/etc',patch:{mode:0o777n}},{path:root,patch:{mode:0o2777n}},
  {path:root,patch:{uid:1000n}},{path:root,patch:{gid:0n}},
  {path:root+'/alphy-read-client.json',patch:{uid:1000n}},{path:root+'/alphy-read-client.json',patch:{mode:0o775n}},
  {path:root+'/alphy-read-client.json',patch:{nlink:2n}},{path:root+'/..data',patch:{gid:0n}},
  {path:root+'/VERSION',patch:{kind:'link'}},{path:root+'/VERSION',patch:{mode:0o2775n}},
  {path:root+'/VERSION',patch:{uid:1000n}},{path:leaf,patch:{uid:1000n}},{path:leaf,patch:{gid:0n}},
  {path:leaf,patch:{mode:0o660n}},{path:leaf,patch:{kind:'link'}},{path:leaf,patch:{nlink:2n}},
  {path:leaf,patch:{size:32769n}},{path:leaf,patch:{dev:2n}},
  {path:root+'/VERSION/alphy-send-grant.json',patch:{mode:0o666n}},
])test('bad metadata blocks every open '+change.path+JSON.stringify(change.patch,(_,v)=>typeof v==='bigint'?v.toString():v),()=>{
  const f=fixture(change);assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
});
for(const target of ['..','../outside','/outside','..data','..2026_10_08_16_23_30.1/x','..2026_10_08_16_23_30.1\0'])test('version grammar blocks before open '+JSON.stringify(target),()=>{
  const f=fixture({link:{path:root+'/..data',target}});assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
});
for(const target of ['../outside','/outside','..data/other'])test('public target blocks before open '+target,()=>{
  const f=fixture({link:{path:root+'/alphy-read-client.json',target}});assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
});
for(const change of [{inode:true},{timestamp:true},{shortRead:true},{rotation:true}])test('inode/time/read/rotation failure closes/wipes, never retries '+Object.keys(change)[0],()=>{
  const f=fixture(change);assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.closed.length,f.opened.length);assert.ok(f.opened.length<=3);assert.ok(f.buffers.every(b=>b.every(v=>v===0)));
});
test('unsupported flags, wrong manifest, unknown pin mode never open',()=>{
  const f=fixture();delete f.io.constants.O_NONBLOCK;assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
  const g=fixture();assert.throws(()=>g.api.readProjectedJsonSet(wanted,{...manifest,keys:{uid:0,mode:'0644'}}));assert.equal(g.opened.length,0);
});
test('per-leaf directory inode change holds before all opens',()=>{
  const f=fixture(),prior=f.io.lstatSync;let dirs=0;
  f.io.lstatSync=(path,options)=>{const s=prior(path,options);if(/\/\.\.[0-9].*\.[0-9]+$/.test(path)&&++dirs===3)s.ino++;return s;};
  assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);
});
test('all pins reject wrong data/link/directory/leaf group and mode',()=>{
  for(const change of [
    {path:root+'/..data',patch:{uid:1000n}},{path:root+'/..data',patch:{mode:0o775n}},{path:root+'/..data',patch:{nlink:2n}},
    {path:root+'/VERSION',patch:{gid:0n}},{path:root+'/alphy-read-client.json',patch:{gid:0n}},
    {path:root,patch:{kind:'link'}},{path:'/etc',patch:{kind:'link'}},{path:leaf,patch:{size:1n}},
  ]){const f=fixture(change);assert.throws(()=>f.api.readProjectedJsonSet(wanted,manifest));assert.equal(f.opened.length,0);}
});
