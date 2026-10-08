'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {discoverMounts,NAMES}=require('../src/mount-discovery');
function fixture(change={}){
  const seen=[],root='/fixture',version='..2026_10_08_16_00_00.123';
  const entries=new Map();
  const entry=(type,mode,extra={})=>({uid:0,gid:0,mode,nlink:1,size:80,isFile:()=>type==='file',isDirectory:()=>type==='dir',isSymbolicLink:()=>type==='link',...extra});
  entries.set(root,entry('dir',0o3777));
  for(const name of NAMES){entries.set(root+'/'+name,entry('link',0o777));entries.set(root+'/'+version+'/'+name,entry('file',0o644));}
  entries.set(root+'/..data',entry('link',0o777));entries.set(root+'/'+version,entry(change.dirLink?'link':'dir',change.mutable?0o777:0o755));
  if(change.unavailable)entries.delete(root+'/'+NAMES[0]);
  const fs={lstatSync(path){seen.push(['lstat',path]);if(!entries.has(path))throw Error('SECRET_EXCEPTION');return entries.get(path);},readlinkSync(path){seen.push(['readlink',path]);return path===root+'/..data'?(change.version||version):(change.target||'..data/'+path.split('/').at(-1));}};
  return{r:discoverMounts(fs,root),seen,root};
}
test('observed projection walks only five fixed backing names without content methods',()=>{
  const {r,seen}=fixture();assert.equal(r.status,'discovery_only');assert.equal(r.records.filter(v=>v.name.startsWith('backing:')).length,5);
  assert.ok(seen.every(([op])=>['lstat','readlink'].includes(op)));assert.ok(!JSON.stringify(r).includes('size'));assert.ok(!('manifest'in r));
});
for(const target of ['/private/secret','../escape','..data/other','..data/a\0b'])test('unexpected public target never follows: '+JSON.stringify(target),()=>{
  const {r,seen}=fixture({target});assert.ok(!seen.some(([,p])=>p.endsWith('/..data')));assert.ok(!JSON.stringify(r).includes(target));
});
for(const version of ['..','.','/outside','../outside','child/name','secret\0name'])test('escaping/version target not followed: '+JSON.stringify(version),()=>{
  const {r}=fixture({version});assert.ok(!r.records.some(v=>v.name==='version_directory'));assert.ok(!JSON.stringify(r).includes('outside'));
});
for(const change of [{dirLink:true},{mutable:true},{unavailable:true}])test('missing or unsafe backing metadata stops before leaf traversal',()=>{
  const {r}=fixture(change);assert.ok(!r.records.some(v=>v.name.startsWith('backing:')));assert.ok(!JSON.stringify(r).includes('SECRET_EXCEPTION'));
});
