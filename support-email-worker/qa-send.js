'use strict';
if(process.argv.length!==2||Number(process.versions.node.split('.')[0])!==24){console.error('SUPPORT_EMAIL_SEND_ARGUMENTS');process.exitCode=1;}
else require('./src/qa-send').runQaSend().then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('SUPPORT_EMAIL_SEND_HALTED');process.exitCode=1;});
