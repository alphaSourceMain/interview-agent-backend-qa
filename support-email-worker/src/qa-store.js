'use strict';
const { QA } = require('./qa-config');
const { hasAnyActiveClientMembership } = require('../../src/lib/supportVoiceMembership');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLAIM_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('SUPPORT_EMAIL_QA_STORE'); };

async function readJson(response) {
  if (!response.body?.getReader) fail();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); fail(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (_) { fail(); }
  finally { for (const b of chunks) b.fill(0); reader.releaseLock(); }
}
function createQaStore(token, deadline) {
  async function request(path, body) {
    if (Date.now() + 10000 > deadline) fail();
    const response = await fetch(QA + '/rest/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: token, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(body === undefined ? { Prefer: 'count=exact' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
    return { response, value: await readJson(response) };
  }
  async function rpc(name, body) {
    const { response, value } = await request('rpc/' + name, body);
    if (!response.ok) fail();
    return value;
  }
  async function confirmed(email) {
    const id = await rpc('support_email_confirmed_user', { p_email: email });
    if (id !== null && (typeof id !== 'string' || !UUID.test(id))) fail();
    return id;
  }
  const db = { from(table) {
    if (table !== 'client_members') fail();
    return { select(fields, options) {
      if (fields !== 'clients!inner(id)' || options?.count !== 'exact' || options?.head !== true || Object.keys(options).length !== 2) fail();
      return { eq(column, id) {
        if (!['user_id_uuid', 'user_id'].includes(column) || !UUID.test(id)) fail();
        return { async is(field, value) {
          if (field !== 'clients.archived_at' || value !== null) fail();
          const query = new URLSearchParams({ select: 'clients!inner(id)', [column]: 'eq.' + id, 'clients.archived_at': 'is.null', limit: '0' });
          const result = await request('client_members?' + query);
          if (!result.response.ok) return { data: null, count: null, error: { code: result.value?.code === '42703' ? '42703' : 'REJECTED' } };
          const range = result.response.headers.get('content-range');
          if (!Array.isArray(result.value) || result.value.length || !/^\*\/\d+$/.test(range || '')) fail();
          const count = Number(range.split('/')[1]);
          if (!Number.isSafeInteger(count) || count < 0) fail();
          return { data: null, count, error: null };
        } };
      } };
    } };
  } };
  return Object.freeze({
    async preflight() { if (await confirmed('alphy-qa-preflight-absent@example.invalid') !== null) fail(); },
    async claim(thread, message, gmail) {
      if (![thread, message, gmail].every(x => typeof x === 'string' && HASH.test(x))) fail();
      const id = await rpc('claim_support_email_draft', { p_thread_key: thread, p_message_key: message, p_gmail_key: gmail });
      if (id !== null && (typeof id !== 'string' || !CLAIM_UUID.test(id))) fail();
      return id;
    },
    async recognizeClient(email) {
      const id = await confirmed(email);
      return id !== null && await hasAnyActiveClientMembership({ serviceDb: db, userId: id });
    },
    async finish(id, draft) {
      if (!CLAIM_UUID.test(id) || !['review', 'draft'].includes(draft.status) ||
          (draft.status === 'draft' && (draft.humanReview !== true || typeof draft.body !== 'string' || Buffer.byteLength(draft.body) > 4500))) fail();
      if (await rpc('finish_support_email_draft', { p_id: id, p_draft: draft }) !== true) fail();
    },
  });
}
module.exports = { createQaStore, readJson };
