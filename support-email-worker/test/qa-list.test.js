'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { listOwnerMessages } = require('../src/qa-list');
test('owner list has one fixed readonly query and no redirect/retry', async () => {
  const original = global.fetch; let calls = 0;
  global.fetch = async (url, opts) => {
    calls++;
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages');
    assert.equal(u.searchParams.get('maxResults'), '25');
    assert.equal(u.searchParams.get('q'), 'from:jason@gardner.ltd to:support@alphasourceai.com after:1704067200 -in:spam -in:trash');
    assert.equal(opts.headers.Authorization, 'Bearer ' + 'a'.repeat(30)); assert.equal(opts.redirect, 'error');
    return new Response('{"messages":[]}', { headers: { 'Content-Type': 'application/json' } });
  };
  try { assert.deepEqual(await listOwnerMessages({ accessToken: 'a'.repeat(30), cutoverMs: 1704067200000, deadline: Date.now() + 15000 }), { messages: [] }); assert.equal(calls, 1); }
  finally { global.fetch = original; }
});
test('CLI rejects input injection without reading credentials', () => {
  const r = spawnSync(process.execPath, [require.resolve('../qa-draft'), '--body=not-allowed'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stderr.trim(), 'SUPPORT_EMAIL_QA_ARGUMENTS'); assert.equal(r.stdout, '');
});
