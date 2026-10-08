'use strict';
async function main(){
  if(process.argv.length!==2||Number(process.versions.node.split('.')[0])!==24)throw Error('ARGS');
  const {loadSendConfig,SEND_GRANT}=require('./src/send-config');const {prepareStore}=require('../src/lib/supportEmailInstaller');
  const {createSendInstaller,listenSendInstaller}=require('./src/send-installer');
  const initial=loadSendConfig('connect');prepareStore(SEND_GRANT);
  const installer=createSendInstaller({initial}),listener=await listenSendInstaller(installer),stop=()=>listener.close();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);console.log(installer.bootstrapUrl);
  const result=await listener.done;process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  console.log(result==='CONNECTED'?'STORED':result==='REVOKE_UNCONFIRMED'?result:'FAILED');if(result!=='CONNECTED')process.exitCode=1;
}
main().catch(()=>{console.error('SUPPORT_EMAIL_SEND_CONNECT_HALTED');process.exitCode=1;});
