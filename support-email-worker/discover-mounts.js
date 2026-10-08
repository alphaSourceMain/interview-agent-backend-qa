'use strict';
const fs=require('node:fs');
const {discoverMounts}=require('./src/mount-discovery');
try{
  if(process.argv.length!==2||process.platform!=='linux'||process.env.RENDER!=='true'||process.env.RENDER_SERVICE_NAME!=='alphascreen-alphy-mail-qa'||process.env.SUPPORT_EMAIL_WORKER_ENABLED!=='false')throw Error();
  console.log(JSON.stringify(discoverMounts(fs,'/etc/secrets')));
}catch(_){console.error('SUPPORT_EMAIL_MOUNT_DISCOVERY_HELD');}
// A diagnostic is never a successful pin or worker acceptance.
process.exitCode=1;
