'use strict';
// Metadata-only walker. No file content methods, generic symlink resolution,
// listing, normalized paths, OAuth, or network. Injected fs is fixture-only use.
const NAMES = Object.freeze(['alphy-read-client.json','alphy-read-grant.json','alphy-send-client.json','alphy-send-grant.json','alphy-runtime-keys.json']);
function discoverMounts(fs, root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.endsWith('/') || root.includes('\0')) throw Error('DISCOVERY_ROOT');
  const records = [];
  function stat(path, name) {
    try { const s=fs.lstatSync(path); records.push({name,uid:s.uid,gid:s.gid,mode:(s.mode&0o7777).toString(8),links:s.nlink,
      directory:s.isDirectory(),regular:s.isFile(),symlink:s.isSymbolicLink(),bounded:s.size>=2&&s.size<=32768}); return s; }
    catch (_) { records.push({name,classification:'unavailable'}); return null; }
  }
  function link(path, name, expected) {
    let text;
    try { text=fs.readlinkSync(path); } catch (_) { records.push({name,classification:'unavailable_link'}); return null; }
    if(expected){const ok=text===expected;records.push({name,classification:ok?'expected_relative':'unexpected_target',...(ok?{target:expected}:{})});return ok?text:null;}
    const ok=typeof text==='string'&&text.length>=1&&text.length<=120&&/^[\x21-\x7e]+$/.test(text)&&!text.includes('/')&&text!=='.'&&text!=='..';
    const printableVersion=ok&&/^\.\.[0-9_.-]+$/.test(text);
    records.push({name,classification:ok?'single_relative_component':'unexpected_target',...(printableVersion?{target:text}:{})});
    return ok?text:null;
  }
  stat(root, 'mount_root');
  let fixed = true;
  for(const name of NAMES){const s=stat(root+'/'+name,name);if(!s?.isSymbolicLink()||!link(root+'/'+name,name+':target','..data/'+name))fixed=false;}
  if(!fixed)return {status:'discovery_only',records};
  const data=stat(root+'/..data','data_link');
  if(!data?.isSymbolicLink())return {status:'discovery_only',records};
  const version=link(root+'/..data','data_target');
  if(!version)return {status:'discovery_only',records};
  const directory=stat(root+'/'+version,'version_directory');
  // Do not traverse a further directory symlink or mutable/non-root directory.
  if(!directory?.isDirectory()||directory.isSymbolicLink()||directory.uid!==0||(directory.mode&0o022))return {status:'discovery_only',records};
  for(const name of NAMES)stat(root+'/'+version+'/'+name,'backing:'+name);
  return {status:'discovery_only',records};
}
module.exports={discoverMounts,NAMES};
