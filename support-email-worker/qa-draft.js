'use strict';
if (process.argv.length !== 2 || Number(process.versions.node.split('.')[0]) !== 24) { console.error('SUPPORT_EMAIL_QA_ARGUMENTS'); process.exitCode = 1; }
else {
  require('./src/qa-draft').runQaDraft().then(result => console.log(JSON.stringify({ status: result.status, counts: result.counts })))
    .catch(() => { console.error('SUPPORT_EMAIL_QA_HALTED'); process.exitCode = 1; });
}
