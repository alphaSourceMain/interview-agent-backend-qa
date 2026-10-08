'use strict';
const { assertRuntimeProfile, QA_PROFILE } = require('./runtime-profile');
const { readJson } = require('./qa-store');
const fail = () => { throw Error('SUPPORT_EMAIL_RUNTIME_STORE'); };
function createRuntimeStore(token, deadline, mode, profile = QA_PROFILE) {
  assertRuntimeProfile(profile);
  return Object.freeze({ async call(op, nonce, data = {}) {
    if (Date.now() + 10000 > deadline) fail();
    const response = await fetch(profile.url + '/rest/v1/rpc/support_email_qa_worker', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { apikey: token, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_op: op, p_nonce: nonce || null, p_data: { ...data, mode } }) });
    if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
    return readJson(response);
  } });
}
module.exports = { createRuntimeStore };
