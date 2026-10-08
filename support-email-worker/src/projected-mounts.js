'use strict';
// Render-specific root-owned projection, never generic symlink following.
const fs=require('node:fs');
const ROOT='/etc/secrets', VERSION=/^\.\.[0-9]{4}_(?:[0-9]{2}_){4}[0-9]{2}\.[0-9]{1,20}$/;
const FILES=Object.freeze({readClient:'alphy-read-client.json',readGrant:'alphy-read-grant.json',sendClient:'alphy-send-client.json',sendGrant:'alphy-send-grant.json',keys:'alphy-runtime-keys.json'});
const FIELDS=Object.freeze(['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs']);
const fail=()=>{throw Error('SUPPORT_EMAIL_PROJECTED_MOUNT');};
function tuple(s){if(FIELDS.some(k=>typeof s[k]!=='bigint'))fail();return Object.freeze(FIELDS.map(k=>s[k].toString()));}
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function collectProjection(io){
  const records=[],leaves={};
  function stat(path,type,mode,gid){
    const s=io.lstatSync(path,{bigint:true});
    if(s.uid!==0n||(s.mode&0o7777n)!==BigInt(mode)||(gid!==null&&s.gid!==BigInt(gid))||
      !s[type]()||(type!=='isDirectory'&&s.nlink!==1n))fail();
    const t=tuple(s);records.push(Object.freeze({path,tuple:t}));return{s,t};
  }
  stat('/etc','isDirectory',0o755,null);
  stat(ROOT,'isDirectory',0o3777,1000);
  for(const name of Object.values(FILES)){
    const path=ROOT+'/'+name;stat(path,'isSymbolicLink',0o777,1000);
    if(io.readlinkSync(path)!=='..data/'+name)fail();
  }
  stat(ROOT+'/..data','isSymbolicLink',0o777,1000);
  const version=io.readlinkSync(ROOT+'/..data');
  if(typeof version!=='string'||!VERSION.test(version))fail();
  const dir=ROOT+'/'+version,directory=stat(dir,'isDirectory',0o2755,1000);
  for(const [key,name]of Object.entries(FILES)){
    const again=io.lstatSync(dir,{bigint:true});
    if(!equal(tuple(again),directory.t))fail(); // Same directory device/inode for every leaf.
    const path=dir+'/'+name,leaf=stat(path,'isFile',0o640,1000);
    if(leaf.s.size<2n||leaf.s.size>32768n||leaf.s.dev!==directory.s.dev)fail();
    leaves[key]=Object.freeze({path,tuple:leaf.t,size:Number(leaf.s.size)});
  }
  return Object.freeze({version,records:Object.freeze(records),leaves:Object.freeze(leaves)});
}
function sameProjection(a,b){return a.version===b.version&&JSON.stringify(a.records)===JSON.stringify(b.records);}
function host(){if(process.platform!=='linux'||[process.getuid(),process.geteuid(),process.getgid(),process.getegid()].some(v=>v!==1000))fail();}
function inspectProjectedMounts(){
  if(arguments.length)fail();host();const captured=collectProjection(fs);
  if(!sameProjection(captured,collectProjection(fs)))fail();
  return Object.freeze(Object.fromEntries(Object.keys(FILES).map(k=>[k,Object.freeze({uid:0,mode:'0640'})])));
}
function readProjectedJsonSet(wanted,manifest){
  host();
  if(!Array.isArray(wanted)||!['keys,readClient,readGrant','keys,readClient,readGrant,sendClient,sendGrant'].includes([...wanted].sort().join(',')))fail();
  if(!manifest||Object.keys(manifest).sort().join(',')!==Object.keys(FILES).sort().join(',')||Object.values(manifest).some(v=>!v||Object.keys(v).sort().join(',')!=='mode,uid'||v.uid!==0||v.mode!=='0640'))fail();
  if(!Number.isInteger(fs.constants.O_NOFOLLOW)||!Number.isInteger(fs.constants.O_NONBLOCK))fail();
  const captured=collectProjection(fs),values={};
  try{
    for(const key of wanted){
      const leaf=captured.leaves[key];let fd,bytes;
      try{
        // libuv sets CLOEXEC internally; include the exposed constant if present.
        fd=fs.openSync(leaf.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(fs.constants.O_CLOEXEC||0));
        if(!equal(tuple(fs.fstatSync(fd,{bigint:true})),leaf.tuple))fail();
        bytes=Buffer.alloc(leaf.size);
        if(fs.readSync(fd,bytes,0,bytes.length,0)!==leaf.size)fail();
        if(!equal(tuple(fs.fstatSync(fd,{bigint:true})),leaf.tuple))fail();
        values[key]=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,leaf.size)));
      }finally{if(bytes)bytes.fill(0);if(fd!==undefined)fs.closeSync(fd);}
    }
    if(!sameProjection(captured,collectProjection(fs)))fail();
    return values;
  }catch(_){for(const k of Object.keys(values))delete values[k];fail();}
}
module.exports={collectProjection,sameProjection,inspectProjectedMounts,readProjectedJsonSet};
