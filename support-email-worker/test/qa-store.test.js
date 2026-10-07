'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQaStore, readJson } = require('../src/qa-store');
const { QA } = require('../src/qa-config');
const id = '12345678-1234-4234-8234-123456789abc';
async function fake(run, respond) {
  const old = global.fetch, calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    assert.ok(url.startsWith(QA + '/rest/v1/')); assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, 'Bearer synthetic-only'); assert.equal(opts.headers.apikey, 'synthetic-only');
    return respond(url, opts);
  };
  try { return { result: await run(createQaStore('synthetic-only', Date.now() + 180000)), calls }; }
  finally { global.fetch = old; }
}
const json = (value, options = {}) => new Response(JSON.stringify(value), { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
test('non-inserting preflight uses fixed RPC', async () => {
  const r = await fake(s => s.preflight(), () => json(null)); assert.equal(r.calls.length, 1);
  assert.ok(r.calls[0].url.endsWith('/rpc/support_email_confirmed_user')); assert.match(r.calls[0].opts.body, /example.invalid/);
});
test('claim checks hashes and strict returned v4 id', async () => {
  const r = await fake(s => s.claim('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)), () => json(id)); assert.equal(r.result, id);
  await assert.rejects(fake(s => s.claim('invalid', 'b'.repeat(64), 'c'.repeat(64)), () => json(id)));
  await assert.rejects(fake(s => s.claim('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)), () => json('12345678-1234-1234-8234-123456789abc')));
});
test('membership queries return counts only, never client rows', async () => {
  const r = await fake(s => s.recognizeClient('owner@example.invalid'), url => url.includes('/rpc/') ? json(id) : json([], { headers: { 'Content-Range': '*/1' } }));
  assert.equal(r.result, true); assert.equal(r.calls.length, 3);
  for (const call of r.calls.slice(1)) { assert.equal(call.opts.method, 'GET'); assert.equal(new URL(call.url).searchParams.get('limit'), '0'); }
});
test('one absent membership column uses only reviewed fallback', async () => {
  const r = await fake(s => s.recognizeClient('owner@example.invalid'), url => url.includes('/rpc/') ? json(id) :
    url.includes('user_id_uuid') ? json({ code: '42703' }, { status: 400 }) : json([], { headers: { 'Content-Range': '*/1' } }));
  assert.equal(r.result, true);
});
test('membership error or returned rows never selects client', async () => {
  for (const response of [() => json({ code: 'PRIVATE' }, { status: 400 }), () => json([{ id: 'private' }], { headers: { 'Content-Range': '0-0/1' } })]) {
    const r = await fake(s => s.recognizeClient('owner@example.invalid'), url => url.includes('/rpc/') ? json(id) : response()); assert.equal(r.result, false);
  }
});
test('bounded stream rejects excess and malformed JSON', async () => {
  await assert.rejects(readJson(new Response('x'.repeat(32769))), /QA_STORE/);
  await assert.rejects(readJson(new Response('malformed')), /QA_STORE/);
});
test('deadline exhausted and unsafe body never invoke fetch', async () => {
  await assert.rejects(createQaStore('synthetic-only', Date.now()).preflight(), /QA_STORE/);
  await assert.rejects(createQaStore('synthetic-only', Date.now() + 180000).finish(id, { status: 'draft', humanReview: false, body: 'text' }), /QA_STORE/);
});
