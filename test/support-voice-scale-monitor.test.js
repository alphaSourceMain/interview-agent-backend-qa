const assert = require('node:assert/strict');
const test = require('node:test');
const {
  sampleOnce,
  validateConfiguration,
  validateRenderObservation,
} = require('../scripts/monitor-support-voice-scale');

const serviceId = 'srv-d2s94oumcj7s73abnq70';
const commit = 'a'.repeat(40);
const instanceId = 'srv-d2s94oumcj7s73abnq70-abcde';
const config = {
  backendOrigin: 'https://ia-backend-qa.onrender.com',
  commit,
  monitorToken: 'M'.repeat(43),
  renderApiKey: 'render-test-key-not-a-secret',
  serviceId,
};

test('monitor configuration accepts only exact HTTPS backend origins and bounded credentials', () => {
  assert.deepEqual(validateConfiguration({
    RENDER_SERVICE_ID: serviceId,
    RENDER_GIT_COMMIT: commit,
    RENDER_API_KEY: config.renderApiKey,
    SUPPORT_VOICE_MONITOR_TOKEN: config.monitorToken,
    SUPPORT_VOICE_BACKEND_ORIGIN: config.backendOrigin,
  }), config);
  assert.throws(() => validateConfiguration({ ...config, SUPPORT_VOICE_BACKEND_ORIGIN: 'https://ia-backend-qa.onrender.com/path' }));
});

test('Render observation requires manual one-instance scale, matching live commit, and no active deploy', () => {
  const input = {
    service: { id: serviceId, type: 'web_service', serviceDetails: { numInstances: 1 } },
    instances: [{ id: instanceId, createdAt: new Date().toISOString() }],
    deploys: [{ deploy: { status: 'live', commit: { id: commit } }, cursor: 'cursor' }],
    serviceId,
    commit,
  };
  const result = validateRenderObservation(input);
  assert.equal(result.runningInstances, 1);
  assert.match(result.instanceHash, /^[a-f0-9]{64}$/);
  assert.throws(() => validateRenderObservation({ ...input, instances: [...input.instances, { id: 'second' }] }));
  assert.throws(() => validateRenderObservation({ ...input, service: { ...input.service, serviceDetails: { numInstances: 1, autoscaling: { enabled: true } } } }));
  assert.throws(() => validateRenderObservation({ ...input, deploys: [{ deploy: { status: 'build_in_progress', commit: { id: commit } } }] }));
});

test('dual-source sample posts only a matching sanitized exact-one observation', async () => {
  const calls = [];
  const backendInstanceHash = 'b'.repeat(64);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const body = url.endsWith('/instances') ? [{ id: instanceId, createdAt: '2026-08-10T00:00:00.000Z' }]
      : url.includes('/deploys?') ? [{ deploy: { status: 'live', commit: { id: commit } }, cursor: 'c' }]
        : url.endsWith('/internal/support/voice/instance') ? { service_id: serviceId, commit, instance_sha256: backendInstanceHash }
          : url.endsWith('/internal/support/voice/scale-lease') ? { ok: true }
            : { id: serviceId, type: 'web_service', serviceDetails: { numInstances: 1 } };
    return { ok: true, status: 200, async json() { return body; } };
  };
  const observation = await sampleOnce({ config, fetchImpl, now: () => Date.parse('2026-08-10T12:00:00.000Z') });
  assert.deepEqual(Object.keys(observation), ['service_id', 'commit', 'running_instances', 'autoscaling', 'active_deploy', 'observed_at', 'instance_ids']);
  assert.equal(observation.running_instances, 1);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((call) => call.url.startsWith('https://api.render.com/')).length, 3);
  assert.equal(calls.at(-1).init.method, 'POST');
  assert.deepEqual(observation.instance_ids, [backendInstanceHash]);
  assert.equal(JSON.stringify(calls).includes(config.renderApiKey), true);
  assert.equal(JSON.stringify(observation).includes(instanceId), false);
});

test('backend process identity is independently bounded because Render does not expose the same hostname identifier', async () => {
  const fetchImpl = async (url) => {
    const body = url.endsWith('/instances') ? [{ id: instanceId }]
      : url.includes('/deploys?') ? [{ deploy: { status: 'live', commit: { id: commit } } }]
        : url.endsWith('/internal/support/voice/instance') ? { service_id: serviceId, commit, instance_sha256: 'not-a-hash' }
          : { id: serviceId, type: 'web_service', serviceDetails: { numInstances: 1 } };
    return { ok: true, status: 200, async json() { return body; } };
  };
  await assert.rejects(sampleOnce({ config, fetchImpl }), /SUPPORT_VOICE_MONITOR_INSTANCE_MISMATCH/);
});
