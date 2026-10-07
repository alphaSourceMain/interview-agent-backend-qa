'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGrant, validateConfig, OWNER, MAILBOX, QA } = require('../src/qa-config');
const { CLIENT } = require('../../src/lib/supportEmailInstaller');
const { READONLY_SCOPE } = require('../../src/lib/supportEmailAdapters');
const { validateList, unchanged, runQaDraft } = require('../src/qa-draft');
const now = Date.now();
const grant = { clientId: CLIENT, mailbox: MAILBOX, scope: READONLY_SCOPE, refreshToken: 'synthetic-only-token', baselineHistoryId: '123',
  capturedAt: new Date(now - 1000).toISOString(), accessTokenExpiresAt: now + 3600000 };
const jwt = claims => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.test';
const env = { SUPPORT_EMAIL_ENABLED: 'true', SUPPORT_EMAIL_OAUTH_ENABLED: 'true', SUPPORT_EMAIL_MODE: 'qa-draft', SUPPORT_EMAIL_ENVIRONMENT: 'qa',
  SUPABASE_URL: QA, SUPPORT_EMAIL_MAILBOX: MAILBOX, SUPPORT_EMAIL_OWNER_TEST_ONLY: 'true', SUPPORT_EMAIL_OWNER_TEST_SENDER: OWNER,
  SUPPORT_EMAIL_BASELINE_HISTORY_ID: '123', SUPPORT_EMAIL_CUTOVER_AT: grant.capturedAt, XAI_API_KEY: 'synthetic-not-real-key',
  SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: 'yjjxzxoghlpguquknyso', exp: Math.floor(now / 1000) + 3600 }) };
test('strict saved grant accepted with original baseline', () => assert.equal(validateGrant({ ...grant }).baselineHistoryId, '123'));
for (const change of [{ mailbox: 'owner@example.invalid' }, { scope: 'gmail.send' }, { clientId: 'different' }, { extra: true },
  { baselineHistoryId: 'abc' }, { capturedAt: 'invalid' }, { accessTokenExpiresAt: now + 100000000 }]) {
  test('malformed or broadened saved grant fails', () => assert.throws(() => validateGrant({ ...grant, ...change })));
}
test('real draft gates accepted', () => assert.equal(validateConfig(env, grant).cutoverMs, Date.parse(grant.capturedAt)));
for (const change of [{ SUPPORT_EMAIL_ENABLED: 'false' }, { SUPPORT_EMAIL_OWNER_TEST_ONLY: 'false' }, { SUPPORT_EMAIL_OWNER_TEST_SENDER: 'other@example.invalid' },
  { SUPABASE_URL: 'https://production.supabase.co' }, { SUPPORT_EMAIL_BASELINE_HISTORY_ID: '124' }, { SUPPORT_EMAIL_CUTOVER_AT: new Date(now - 2000).toISOString() },
  { SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'anon', ref: 'yjjxzxoghlpguquknyso', exp: Math.floor(now / 1000) + 3600 }) },
  { SUPABASE_SERVICE_ROLE_KEY: jwt({ role: 'service_role', ref: 'production', exp: Math.floor(now / 1000) + 3600 }) }]) {
  test('incorrect QA draft binding fails', () => assert.throws(() => validateConfig({ ...env, ...change }, grant)));
}
test('one bounded id page accepted', () => assert.deepEqual(validateList({ messages: [{ id: 'abc123' }] }), ['abc123']));
for (const value of [{ nextPageToken: 'next' }, { messages: [{ id: 'abc123' }, { id: 'abc123' }] }, { messages: [{ id: '../path' }] },
  { messages: Array.from({ length: 26 }, (_, n) => ({ id: n.toString(16) })) }, { messages: 'invalid' }]) {
  test('invalid/backlogged mailbox page rejected', () => assert.throws(() => validateList(value)));
}
const record = { senderVerified: true, sender: OWNER, fingerprint: 'a'.repeat(64), text: 'What is alphaScreen?', threadKey: 'b'.repeat(64), messageKey: 'c'.repeat(64), gmailKey: 'd'.repeat(64) };
test('fresh verified identical decision accepted', () => assert.equal(unchanged(record, { ...record }), true));
for (const key of ['senderVerified', 'sender', 'fingerprint', 'text', 'threadKey', 'messageKey', 'gmailKey']) {
  test('changed fresh proof rejected: ' + key, () => assert.equal(unchanged(record, { ...record, [key]: 'changed' }), false));
}
test('runtime injection rejected before config/network', async () => assert.rejects(runQaDraft({ generate: () => {} }), /QA_HALTED/));
