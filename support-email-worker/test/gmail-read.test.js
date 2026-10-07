'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedJson, decodeEnvelope } = require('../src/gmail-read');
const envelope = { id: 'abc', threadId: 'def', historyId: '123', internalDate: String(Date.now()), labelIds: ['INBOX'], raw: Buffer.from('x').toString('base64url') };
test('Gmail padded and unpadded canonical base64url accepted', () => {
  for (const raw of ['eA', 'eA==']) { const result = decodeEnvelope({ ...envelope, raw }, 'abc'); assert.equal(result.toString(), 'x'); result.fill(0); }
  for (const raw of ['eA=', 'eA===', 'eB==', 'e A==', 'eA\n', 'eA+/']) assert.throws(() => decodeEnvelope({ ...envelope, raw }, 'abc'));
});
test('envelope binding and raw limit reject before crypto', () => {
  for (const change of [{ id: 'other' }, { threadId: '../../profile' }, { historyId: '-1' }, { internalDate: 'NaN' }, { labelIds: ['bad/label'] }, { raw: Buffer.alloc(256 * 1024 + 1).toString('base64url') }]) assert.throws(() => decodeEnvelope({ ...envelope, ...change }, 'abc'));
});
test('fixed GET uses header auth, no retry or redirect, streamed bounded JSON only', async () => {
  const original = global.fetch;
  let calls = 0;
  try {
    global.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=raw');
      assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.equal(options.headers.Authorization, 'Bearer ' + 'x'.repeat(30));
      assert.equal(options.method, undefined); assert.equal(options.body, undefined);
      return new Response(JSON.stringify(envelope), { headers: { 'Content-Type': 'application/json' } });
    };
    assert.deepEqual(await boundedJson('messages/abc?format=raw', 'x'.repeat(30), Date.now() + 10000), envelope);
    await assert.rejects(boundedJson('messages/abc?format=full', 'x'.repeat(30), Date.now() + 10000));
    await assert.rejects(boundedJson('../../tokeninfo', 'x'.repeat(30), Date.now() + 10000));
    assert.equal(calls, 1);
    global.fetch = async () => { calls++; return new Response('x'.repeat(400 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }); };
    await assert.rejects(boundedJson('profile', 'x'.repeat(30), Date.now() + 10000)); assert.equal(calls, 2);
    global.fetch = async () => { calls++; return new Response('{', { headers: { 'Content-Type': 'application/json' } }); };
    await assert.rejects(boundedJson('profile', 'x'.repeat(30), Date.now() + 10000)); assert.equal(calls, 3);
    global.fetch = async () => { calls++; return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }); };
    await assert.rejects(boundedJson('profile', 'x'.repeat(30), Date.now() + 10000)); assert.equal(calls, 4);
  } finally { global.fetch = original; }
});
