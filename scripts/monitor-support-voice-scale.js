#!/usr/bin/env node

const crypto = require('node:crypto');

const RENDER_API_ORIGIN = 'https://api.render.com';
const SAMPLE_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 1500;
const ACTIVE_DEPLOY_STATUSES = new Set([
  'created',
  'queued',
  'build_in_progress',
  'update_in_progress',
  'pre_deploy_in_progress',
]);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function exactHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && parsed.pathname === '/' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

function validateConfiguration(env) {
  const serviceId = String(env.RENDER_SERVICE_ID || '').trim();
  const commit = String(env.RENDER_GIT_COMMIT || '').trim();
  const renderApiKey = String(env.RENDER_API_KEY || '');
  const monitorToken = String(env.SUPPORT_VOICE_MONITOR_TOKEN || '');
  const backendOrigin = exactHttpsOrigin(String(env.SUPPORT_VOICE_BACKEND_ORIGIN || '').trim());
  if (!/^srv-[a-z0-9]+$/.test(serviceId) || !/^[a-f0-9]{40}$/.test(commit) || renderApiKey.length < 20 ||
      !/^[A-Za-z0-9_-]{43}$/.test(monitorToken) || !backendOrigin) throw new Error('SUPPORT_VOICE_MONITOR_CONFIG_INVALID');
  return { backendOrigin, commit, monitorToken, renderApiKey, serviceId };
}

async function fetchJson(fetchImpl, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('SUPPORT_VOICE_MONITOR_REQUEST_FAILED');
  const body = await response.json();
  return { body, status: response.status };
}

function unwrapDeploys(body) {
  if (!Array.isArray(body)) return null;
  const deploys = [];
  for (const item of body) {
    const deploy = item && typeof item === 'object' && !Array.isArray(item) && item.deploy && typeof item.deploy === 'object'
      ? item.deploy
      : item;
    if (!deploy || typeof deploy !== 'object' || Array.isArray(deploy) || typeof deploy.status !== 'string') return null;
    deploys.push(deploy);
  }
  return deploys;
}

function validateRenderObservation({ service, instances, deploys, serviceId, commit }) {
  const details = service?.serviceDetails;
  const autoscalingPresent = Boolean(details && Object.prototype.hasOwnProperty.call(details, 'autoscaling'));
  const autoscalingOff = !autoscalingPresent || details.autoscaling?.enabled === false;
  const normalizedDeploys = unwrapDeploys(deploys);
  if (!service || service.id !== serviceId || service.type !== 'web_service' || !details || details.numInstances !== 1 || !autoscalingOff ||
      !Array.isArray(instances) || instances.length !== 1 || typeof instances[0]?.id !== 'string' || !instances[0].id || !normalizedDeploys) {
    throw new Error('SUPPORT_VOICE_MONITOR_OBSERVATION_INVALID');
  }
  const activeDeploy = normalizedDeploys.some((deploy) => ACTIVE_DEPLOY_STATUSES.has(deploy.status));
  const exactCommitLive = normalizedDeploys.some((deploy) => deploy.status === 'live' && deploy.commit?.id === commit);
  if (activeDeploy || !exactCommitLive) throw new Error('SUPPORT_VOICE_MONITOR_DEPLOY_INVALID');
  return {
    activeDeploy: false,
    autoscaling: false,
    instanceHash: digest(instances[0].id),
    runningInstances: 1,
  };
}

function validateBackendInstance(body, { serviceId, commit }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'commit,instance_sha256,service_id' ||
      body.service_id !== serviceId || body.commit !== commit || !/^[a-f0-9]{64}$/.test(body.instance_sha256)) {
    throw new Error('SUPPORT_VOICE_MONITOR_INSTANCE_MISMATCH');
  }
  return { instanceHash: body.instance_sha256 };
}

async function sampleOnce({ config, fetchImpl = fetch, now = Date.now }) {
  const renderHeaders = { Accept: 'application/json', Authorization: `Bearer ${config.renderApiKey}` };
  const monitorHeaders = { Accept: 'application/json', Authorization: `Bearer ${config.monitorToken}` };
  const servicePath = `${RENDER_API_ORIGIN}/v1/services/${config.serviceId}`;
  const [serviceResult, instancesResult, deploysResult, backendInstanceResult] = await Promise.all([
    fetchJson(fetchImpl, servicePath, { headers: renderHeaders }),
    fetchJson(fetchImpl, `${servicePath}/instances`, { headers: renderHeaders }),
    fetchJson(fetchImpl, `${servicePath}/deploys?limit=20`, { headers: renderHeaders }),
    fetchJson(fetchImpl, `${config.backendOrigin}/internal/support/voice/instance`, { headers: monitorHeaders }),
  ]);
  const observed = validateRenderObservation({
    service: serviceResult.body,
    instances: instancesResult.body,
    deploys: deploysResult.body,
    serviceId: config.serviceId,
    commit: config.commit,
  });
  const backendInstance = validateBackendInstance(backendInstanceResult.body, config);
  const observation = {
    service_id: config.serviceId,
    commit: config.commit,
    running_instances: observed.runningInstances,
    autoscaling: observed.autoscaling,
    active_deploy: observed.activeDeploy,
    observed_at: new Date(now()).toISOString(),
    instance_ids: [backendInstance.instanceHash],
  };
  await fetchJson(fetchImpl, `${config.backendOrigin}/internal/support/voice/scale-lease`, {
    method: 'POST',
    headers: { ...monitorHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(observation),
  });
  return observation;
}

function isHardSafetyFailure(error) {
  return new Set([
    'SUPPORT_VOICE_MONITOR_OBSERVATION_INVALID',
    'SUPPORT_VOICE_MONITOR_DEPLOY_INVALID',
    'SUPPORT_VOICE_MONITOR_INSTANCE_MISMATCH',
  ]).has(error?.message);
}

async function sampleWithOneRetry(options) {
  try {
    return await sampleOnce(options);
  } catch (error) {
    if (isHardSafetyFailure(error)) throw error;
    return sampleOnce(options);
  }
}

async function sampleCycle(options) {
  try {
    return { status: 'healthy', observation: await sampleWithOneRetry(options) };
  } catch (error) {
    return { status: isHardSafetyFailure(error) ? 'hard_failure' : 'transient_failure', error };
  }
}

async function revoke({ config, fetchImpl = fetch }) {
  try {
    await fetchImpl(`${config.backendOrigin}/internal/support/voice/scale-lease`, {
      method: 'DELETE',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${config.monitorToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {}
}

async function run({ env = process.env, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const config = validateConfiguration(env);
  let stopped = false;
  let transientFailureActive = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const startedAt = now();
      const cycle = await sampleCycle({ config, fetchImpl, now });
      if (cycle.status === 'hard_failure') {
        await revoke({ config, fetchImpl });
        throw cycle.error;
      }
      if (cycle.status === 'transient_failure') {
        if (!transientFailureActive) process.stderr.write('support_voice_scale_monitor_transient\n');
        transientFailureActive = true;
      } else if (transientFailureActive) {
        process.stderr.write('support_voice_scale_monitor_recovered\n');
        transientFailureActive = false;
      }
      const elapsed = now() - startedAt;
      await sleep(Math.max(0, SAMPLE_INTERVAL_MS - elapsed));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (stopped) await revoke({ config, fetchImpl });
  }
}

if (require.main === module) {
  run().catch(() => {
    process.stderr.write('support_voice_scale_monitor_failed\n');
    process.exitCode = 1;
  });
}

module.exports = {
  ACTIVE_DEPLOY_STATUSES,
  RENDER_API_ORIGIN,
  REQUEST_TIMEOUT_MS,
  SAMPLE_INTERVAL_MS,
  exactHttpsOrigin,
  isHardSafetyFailure,
  run,
  sampleCycle,
  sampleOnce,
  sampleWithOneRetry,
  unwrapDeploys,
  validateBackendInstance,
  validateConfiguration,
  validateRenderObservation,
};
