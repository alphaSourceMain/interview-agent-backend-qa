'use strict';
// Runtime needs unknown-person vs failed lookup distinguished. The legacy
// voice/draft boolean deliberately hides failures; leave that behavior intact.
const { QA, OWNER } = require('./qa-config');
const { readJson } = require('./qa-store');
const { classifyCountResult } = require('../../src/lib/supportVoiceMembership');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => { throw Error('SUPPORT_EMAIL_RUNTIME_MEMBERSHIP'); };
async function recognizeRuntimeClient(token, sender, deadline) {
  if (sender !== OWNER || typeof token !== 'string' || !Number.isSafeInteger(deadline)) fail();
  async function request(path, body) {
    if (Date.now() + 10000 > deadline) fail();
    const response = await fetch(QA + '/rest/v1/' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: token, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(body ? {} : { Prefer: 'count=exact' }) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
    return { response, value: await readJson(response) };
  }
  const confirmed = await request('rpc/support_email_confirmed_user', { p_email: sender });
  if (!confirmed.response.ok) fail();
  if (confirmed.value === null) return false;
  if (typeof confirmed.value !== 'string' || !UUID.test(confirmed.value)) fail();
  const results = [];
  for (const column of ['user_id_uuid', 'user_id']) {
    const query = new URLSearchParams({ select: 'clients!inner(id)', [column]: 'eq.' + confirmed.value, 'clients.archived_at': 'is.null', limit: '0' });
    const { response, value } = await request('client_members?' + query);
    if (!response.ok) {
      if (value?.code !== '42703') fail();
      results.push(classifyCountResult({ error: { code: '42703' } })); continue;
    }
    const range = response.headers.get('content-range');
    if (!Array.isArray(value) || value.length || !/^\*\/\d+$/.test(range || '')) fail();
    const count = Number(range.split('/')[1]);
    if (!Number.isSafeInteger(count) || count < 0) fail();
    results.push(classifyCountResult({ data: null, count }));
  }
  if (results.some(r => r.kind === 'fail') || results.every(r => r.kind === 'column_absent')) fail();
  return results.some(r => r.kind === 'present' && r.count > 0);
}
module.exports = { recognizeRuntimeClient };
