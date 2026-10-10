const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const http = require('node:http');
const { supportVoiceEligible } = require('../src/services/supportVoiceEligibility');
const { createSupportVoiceGateway } = require('../src/services/supportVoiceGateway');
const { createMemorySupportVoiceStore } = require('./helpers/supportVoiceTestStore');
const U = '00000000-0000-4000-8000-000000000001';
const P = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const O = '00000000-0000-4000-8000-000000000004';
function db({ tier = 'pro', grants = [{ client_id: P, role: 'manager' }], admin = false, archived = false, demo = false, fail = false, legacy = false } = {}) {
  const records = {
    clients: [{ id: P, parent_client_id: null, archived_at: archived ? '2026-10-10' : null }, { id: C, parent_client_id: P, archived_at: null }, { id: O, parent_client_id: null, archived_at: null }],
    client_plan_settings: [{ client_id: P, plan_tier: tier }, { client_id: O, plan_tier: 'pro' }],
    admins: admin ? [{ user_id: U, is_active: true }] : [],
    client_members: grants.map(g => ({ ...g, user_id: U, user_id_uuid: U })),
  };
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: U, email: 'qa@example.invalid', app_metadata: demo ? { sales_demo_client_id: P } : {} } } }) } },
    from(table) {
      let matches = records[table] ?? [];
      let error = fail ? { code: '08000' } : null;
      const query = {
        select() { return query; },
        eq(key, value) { if (legacy && key === 'user_id_uuid') error = { code: '42703' }; matches = matches.filter(row => row[key] === value); return query; },
        maybeSingle: async () => ({ data: matches[0] ?? null, error }),
        then(resolve) { return Promise.resolve({ data: matches, error }).then(resolve); },
      };
      return query;
    },
  };
}
const eligible = (config, clientId = P) => supportVoiceEligible({ serviceDb: db(config), userId: U, clientId });
test('selected Essential never borrows Pro access, including global admins', async () => {
  assert.equal(await eligible({ tier: 'essential', grants: [{ client_id: P, role: 'manager' }, { client_id: O, role: 'manager' }] }), false);
  assert.equal(await eligible({ tier: 'basic', admin: true }), false);
  assert.equal(await eligible({ tier: 'pro' }), true);
  assert.equal(await eligible({ tier: 'enterprise' }), true);
  assert.equal(await eligible({ tier: null }), false);
});
test('selected active child uses its active billing owner and existing parent role inheritance', async () => {
  assert.equal(await eligible({}, C), true);
  assert.equal(await eligible({ grants: [{ client_id: P, role: 'member' }] }, C), false);
  assert.equal(await eligible({ grants: [{ client_id: C, role: 'member' }] }, C), true);
  assert.equal(await eligible({ tier: 'essential' }, C), false);
  assert.equal(await eligible({ archived: true }, C), false);
});
test('missing, unauthorized, archived, demo, unknown and DB failures fail closed', async () => {
  assert.equal(await eligible({ grants: [] }), false);
  assert.equal(await eligible({}, '00000000-0000-4000-8000-000000000099'), false);
  assert.equal(await eligible({ archived: true }), false);
  assert.equal(await eligible({ demo: true, admin: true }), false);
  assert.equal(await eligible({ fail: true, admin: true }), false);
  assert.equal(await eligible({ legacy: true }), true);
});
test('query scope is mandatory, exact Origin precedes auth, and session gate denies Essential', async () => {
  let authCalls = 0;
  const gateway = createSupportVoiceGateway({
    env: { NODE_ENV: 'test', SUPPORT_VOICE_ENABLED: 'false', SUPPORT_VOICE_ALLOWED_ORIGIN: 'https://dev.example.invalid' },
    serviceDb: db({ tier: 'essential' }), sessionStore: createMemorySupportVoiceStore(),
    rateLimit: async () => ({ allowed: true }),
    requireAuth(req, _res, next) { authCalls++; req.user = { id: U }; next(); },
  });
  const app = express(); app.use('/api/support/voice', gateway.router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support/voice`;
  const headers = { Origin: 'https://dev.example.invalid', Authorization: 'Bearer qa' };
  try {
    assert.equal((await fetch(`${base}/sessions`, { method: 'POST', headers })).status, 400);
    assert.equal((await fetch(`${base}/sessions?client_id=${P}`, { method: 'POST', headers })).status, 403);
    const response = await fetch(`${base}/eligibility?client_id=${P}`, { headers });
    assert.deepEqual(await response.json(), { client_id: P, eligible: false });
    const before = authCalls;
    assert.equal((await fetch(`${base}/eligibility?client_id=${P}`, { headers: { ...headers, Origin: 'https://staging.example.invalid' } })).status, 403);
    assert.equal(authCalls, before);
    assert.equal((await fetch(`${base}/eligibility?client_id=${P}`, { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } })).status, 204);
  } finally { gateway.finalizeAll(); await new Promise(resolve => server.close(resolve)); }
});
