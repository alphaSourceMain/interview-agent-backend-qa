const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const test = require('node:test');
const { createSupportVoiceGateway, isConfigurationReady, safeIp } = require('../src/lib/supportVoiceGateway');

const ORIGIN = 'https://alphasourceai-com.onrender.com';

function serviceDb(count = 1) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table };
      calls.push(call);
      return {
        select(columns, options) {
          call.columns = columns;
          call.options = options;
          return {
            eq(column, userId) {
              call.column = column;
              call.userId = userId;
              return {
                is(filter, value) {
                  call.filter = filter;
                  call.value = value;
                  return Promise.resolve({ data: null, count, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

async function harness({ memberCount = 1, enabled = true, globalAdmin = false, rateLimitImpl, pendingTtlMs, rateTimeoutMs } = {}) {
  let authCalls = 0;
  const rateCalls = [];
  const app = express();
  const env = {
    NODE_ENV: 'test',
    SUPPORT_VOICE_ENABLED: enabled ? 'true' : 'false',
    SUPPORT_VOICE_SINGLE_INSTANCE_CONFIRMED: 'true',
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
  };
  const db = serviceDb(memberCount);
  const gateway = createSupportVoiceGateway({
    env,
    serviceDb: db,
    scaleLeaseHealthy: true,
    requireAuth(req, res, next) {
      authCalls += 1;
      const token = String(req.headers.authorization || '');
      if (!token.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
      req.user = { id: token.slice(7), email: 'must-not-propagate@example.test' };
      req.userToken = token.slice(7);
      req.isGlobalAdmin = globalAdmin;
      next();
    },
    async rateLimit(input) {
      rateCalls.push(input);
      return rateLimitImpl ? rateLimitImpl(input) : { allowed: true, count: 1, remaining: 4, retryAfterSeconds: 0 };
    },
    pendingTtlMs,
    rateTimeoutMs,
  });
  app.use('/api/support/voice', gateway.router);
  const server = http.createServer(app);
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/support/voice`;
  return {
    base,
    db,
    gateway,
    rateCalls,
    get authCalls() { return authCalls; },
    close: () => new Promise((resolve) => { gateway.finalizeAll(); server.close(resolve); }),
  };
}

function headers(user = 'user-one', origin = ORIGIN) {
  return { Origin: origin, Authorization: `Bearer ${user}` };
}

test('create is bodyless, authenticated, membership-gated, no-store, and returns only opaque credentials', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['credential', 'expires_at', 'session_id']);
    assert.match(body.session_id, /^[A-Za-z0-9_-]{22}$/);
    assert.match(body.credential, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(h.db.calls.length, 2);
    assert.deepEqual(h.rateCalls.map((call) => call.routeName), ['support_voice_session_create:user']);
    assert.equal(JSON.stringify(body).includes('user-one'), false);
  } finally {
    await h.close();
  }
});

test('missing or wrong Origin rejects before authentication, membership, rate limit, or reservation', async () => {
  const h = await harness();
  try {
    for (const origin of [undefined, 'https://app.alphasourceai.com']) {
      const requestHeaders = { Authorization: 'Bearer user-one' };
      if (origin) requestHeaders.Origin = origin;
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: requestHeaders });
      assert.equal(response.status, 403);
    }
    assert.equal(h.authCalls, 0);
    assert.equal(h.db.calls.length, 0);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.gateway._state.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('nonempty body is rejected before auth and consumes no limiter bucket', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400);
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
  } finally {
    await h.close();
  }
});

test('chunked request bodies are rejected before authentication or limiter work', async () => {
  const h = await harness();
  try {
    const target = new URL(`${h.base}/sessions`);
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { ...headers(), 'Transfer-Encoding': 'chunked' },
      }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.write('{}');
      request.end();
    });
    assert.equal(status, 400);
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.gateway._state.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('unaffiliated authenticated user is denied and service count queries return no rows', async () => {
  const h = await harness({ memberCount: 0 });
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 403);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.gateway._state.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('one pending session per user and bodyless abandon is uniform', async () => {
  const h = await harness();
  try {
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 409);
    const abandoned = await fetch(`${h.base}/sessions/pending`, { method: 'DELETE', headers: headers() });
    assert.equal(abandoned.status, 204);
    assert.equal(await abandoned.text(), '');
    assert.equal(h.gateway._state.sessions.size, 0);
    assert.equal((await fetch(`${h.base}/sessions/pending`, { method: 'DELETE', headers: headers() })).status, 204);
  } finally {
    await h.close();
  }
});

test('concurrent same-user creates reserve atomically and the process cap stops the twenty-first user', async () => {
  const h = await harness();
  try {
    const concurrent = await Promise.all([
      fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('same-user') }),
      fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('same-user') }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
    assert.equal(h.gateway._state.sessions.size, 1);
    for (let index = 1; index < 20; index += 1) {
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers(`user-${index}`) });
      assert.equal(response.status, 201);
    }
    assert.equal(h.gateway._state.sessions.size, 20);
    const overflow = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers('user-overflow') });
    assert.equal(overflow.status, 503);
    assert.equal(h.gateway._state.sessions.size, 20);
  } finally {
    await h.close();
  }
});

test('pending credentials expire and release the per-user slot', async () => {
  const h = await harness({ pendingTtlMs: 25 });
  try {
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(h.gateway._state.sessions.size, 0);
    assert.equal((await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() })).status, 201);
  } finally {
    await h.close();
  }
});

test('disabled feature fails closed before limiter or reservation', async () => {
  const h = await harness({ enabled: false });
  try {
    const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
    assert.equal(response.status, 503);
    assert.equal(h.rateCalls.length, 0);
    assert.equal(h.gateway._state.sessions.size, 0);
  } finally {
    await h.close();
  }
});

test('limiter denial, timeout, exception, and malformed results fail closed without a credential', async () => {
  const cases = [
    async () => ({ allowed: false }),
    async () => { throw new Error('database'); },
    async () => null,
    () => new Promise(() => {}),
  ];
  for (const rateLimitImpl of cases) {
    const h = await harness({ rateLimitImpl, rateTimeoutMs: 15 });
    try {
      const response = await fetch(`${h.base}/sessions`, { method: 'POST', headers: headers() });
      assert.ok([429, 503].includes(response.status));
      assert.equal(h.gateway._state.sessions.size, 0);
      assert.equal(JSON.stringify(await response.json()).includes('database'), false);
    } finally {
      await h.close();
    }
  }
});

test('global admin bypass is boolean-only and reserves the same minimal session schema', async () => {
  const member = await harness();
  const admin = await harness({ memberCount: 0, globalAdmin: true });
  try {
    assert.equal((await fetch(`${member.base}/sessions`, { method: 'POST', headers: headers('member') })).status, 201);
    assert.equal((await fetch(`${admin.base}/sessions`, { method: 'POST', headers: headers('admin') })).status, 201);
    const memberEntry = [...member.gateway._state.sessions.values()][0];
    const adminEntry = [...admin.gateway._state.sessions.values()][0];
    assert.deepEqual(Object.keys(memberEntry).sort(), Object.keys(adminEntry).sort());
    for (const entry of [memberEntry, adminEntry]) {
      const serialized = JSON.stringify(entry);
      assert.equal(serialized.includes('member'), false);
      assert.equal(serialized.includes('admin'), false);
      assert.equal(serialized.includes('client'), false);
      assert.equal(serialized.includes('email'), false);
    }
    assert.equal(admin.db.calls.length, 0);
  } finally {
    await member.close();
    await admin.close();
  }
});

test('XFF modes accept only the first normalized public address and follow the explicit fail-closed table', () => {
  const req = (value) => ({ headers: value === undefined ? {} : { 'x-forwarded-for': value } });
  assert.equal(safeIp(req('8.8.8.8, 10.0.0.1'), 'strict'), '8.8.8.8');
  assert.equal(safeIp(req('2606:4700:4700::1111'), 'strict'), '2606:4700:4700::1111');
  for (const value of [undefined, '', '999.1.1.1', '10.0.0.1', '127.0.0.1', '169.254.1.1', '192.168.1.1', '203.0.113.10', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.throws(() => safeIp(req(value), 'strict'), /SUPPORT_VOICE_IP_UNAVAILABLE/);
    assert.equal(safeIp(req(value), 'best_effort'), null);
  }
});

test('voice readiness requires exact XFF mode, provider key, knowledge, lease, and production-safe local flag', () => {
  const base = {
    NODE_ENV: 'production',
    SUPPORT_VOICE_ENABLED: 'true',
    SUPPORT_VOICE_SINGLE_INSTANCE_CONFIRMED: 'true',
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
  };
  assert.equal(isConfigurationReady(base, { ok: true }, true), true);
  for (const mode of [undefined, '', 'strict ', 'STRICT', 'garbage']) {
    assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_XFF_MODE: mode }, { ok: true }, true), false);
  }
  assert.equal(isConfigurationReady({ ...base, SUPPORT_VOICE_ALLOW_LOCAL_DEV: 'true' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady({ ...base, XAI_API_KEY: '' }, { ok: true }, true), false);
  assert.equal(isConfigurationReady(base, { ok: false }, true), false);
  assert.equal(isConfigurationReady(base, { ok: true }, false), false);
});

test('positive preflight is exact and side-effect free', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.base}/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST, DELETE, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization');
    assert.equal(h.authCalls, 0);
    assert.equal(h.rateCalls.length, 0);
  } finally {
    await h.close();
  }
});

test('WebSocket server transport disables compression and enforces the exact browser payload cap', async () => {
  const h = await harness();
  try {
    assert.equal(h.gateway._state.wss.options.maxPayload, 48 * 1024);
    assert.equal(h.gateway._state.wss.options.perMessageDeflate, false);
  } finally {
    await h.close();
  }
});

test('operator scale lease requires a constant-time monitor token and exact one-instance observation', async () => {
  const monitorToken = 'M'.repeat(43);
  const rpcCalls = [];
  const deleteCalls = [];
  const db = serviceDb(1);
  const membershipFrom = db.from.bind(db);
  db.from = (table) => {
    if (table !== 'request_rate_limits') return membershipFrom(table);
    return {
      delete() {
        const call = { table };
        deleteCalls.push(call);
        return {
          eq(column, value) {
            call[column] = value;
            return {
              eq(nextColumn, nextValue) {
                call[nextColumn] = nextValue;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };
  };
  db.rpc = async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: { allowed: true }, error: null };
  };
  const env = {
    NODE_ENV: 'test',
    SUPPORT_VOICE_ENABLED: 'true',
    SUPPORT_VOICE_SINGLE_INSTANCE_CONFIRMED: 'true',
    SUPPORT_VOICE_XFF_MODE: 'best_effort',
    SUPPORT_VOICE_MONITOR_TOKEN: monitorToken,
    XAI_API_KEY: 'xai-test-key-not-a-real-secret',
    RENDER_GIT_COMMIT: 'a'.repeat(40),
    RENDER_SERVICE_ID: 'srv-test',
    RENDER_INSTANCE_ID: 'instance-one',
  };
  const gateway = createSupportVoiceGateway({
    env,
    serviceDb: db,
    requireAuth: (_req, res) => res.status(401).end(),
    rateLimit: async () => ({ allowed: true }),
  });
  const app = express();
  app.use('/internal/support/voice', gateway.monitorRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/internal/support/voice`;
  try {
    assert.equal((await fetch(`${base}/instance`)).status, 401);
    const instanceResponse = await fetch(`${base}/instance`, { headers: { Authorization: `Bearer ${monitorToken}` } });
    assert.equal(instanceResponse.status, 200);
    const instance = await instanceResponse.json();
    assert.match(instance.instance_sha256, /^[a-f0-9]{64}$/);
    const observation = {
      service_id: 'srv-test',
      commit: 'a'.repeat(40),
      running_instances: 1,
      autoscaling: false,
      active_deploy: false,
      observed_at: new Date().toISOString(),
      instance_ids: [instance.instance_sha256],
    };
    const renewed = await fetch(`${base}/scale-lease`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${monitorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
    });
    assert.equal(renewed.status, 200);
    assert.equal(gateway.health().scaleLeaseHealthy, true);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].name, 'check_and_increment_rate_limit');
    assert.equal(rpcCalls[0].args.p_route_name, `support_voice_scale_lease:${'a'.repeat(40)}`);
    assert.equal(rpcCalls[0].args.p_max_count, 2147483647);
    observation.running_instances = 2;
    const rejected = await fetch(`${base}/scale-lease`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${monitorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
    });
    assert.equal(rejected.status, 409);
    assert.equal(gateway.health().scaleLeaseHealthy, false);
    const revoked = await fetch(`${base}/scale-lease`, { method: 'DELETE', headers: { Authorization: `Bearer ${monitorToken}` } });
    assert.equal(revoked.status, 204);
    assert.equal(deleteCalls.length, 1);
    assert.match(deleteCalls[0].route_name, /^support_voice_scale_lease:/);
  } finally {
    gateway.finalizeAll();
    await new Promise((resolve) => server.close(resolve));
  }
});
