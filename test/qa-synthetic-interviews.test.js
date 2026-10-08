'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const express = require('express');
const { SCENARIOS, QUESTIONS, ANSWERS, CLOSING_QUESTION, QA_SERVICE_ID, QA_PERSONA_ID,
  assertQaEnvironment, createQaSyntheticInterviewService, evaluateRun } = require('../src/lib/qaSyntheticInterviews');
const { networkAction } = require('../src/lib/qaSyntheticInterviewRunner');
const { createAdminSyntheticInterviewsRouter } = require('../routes/adminSyntheticInterviews');
const { installSyntheticBrowser } = require('../src/lib/qaSyntheticBrowser');
const { runInNewContext } = require('node:vm');

const ENV = { ENABLE_QA_SYNTHETIC_INTERVIEWS: 'true', SUPABASE_URL: 'https://yjjxzxoghlpguquknyso.supabase.co',
  RENDER_SERVICE_ID: QA_SERVICE_ID, RENDER_GIT_BRANCH: 'qa-backend', TAVUS_PERSONA_ID: QA_PERSONA_ID,
  RENDER_EXTERNAL_URL: 'https://ia-backend-qa.onrender.com', TAVUS_API_KEY: 'test', OPENAI_API_KEY: 'test' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('isolated observer recognizes qualified speaking variants without treating candidate or unknown stops as replica progress', () => {
  const handlers = {};
  const microphoneTrack = { kind: 'audio', clone() { return this; } };
  const window = {}; window.top = window;
  const sandbox = { window, location: { origin: 'https://alphasourceai-com.onrender.com', pathname: '/interview/live' },
    sessionStorage: { setItem() {} }, navigator: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [] }) } },
    AudioContext: class { createMediaStreamDestination() { return { stream: { getAudioTracks: () => [microphoneTrack] } }; } } };
  runInNewContext(`(${installSyntheticBrowser.toString()})({})`, sandbox);
  window.DailyIframe = { createCallObject: (options) => {
    assert.equal(options.audioSource, microphoneTrack);
    return { on: (name, handler) => { handlers[name] = handler; } };
  } };
  window.DailyIframe.createCallObject();
  const emit = (type, role) => handlers['app-message']({ data: { eventType: type, properties: { role } } });
  const runtime = window.__qaSynthetic;
  emit('conversation.stopped_speaking');
  assert.equal(runtime.lastStop, 0);
  emit('conversation.replica-started-speaking');
  assert.equal(runtime.speaking, true);
  emit('conversation.user-started-speaking');
  emit('conversation.stopped_speaking');
  assert.equal(runtime.speaking, true);
  emit('conversation.user-stopped-speaking');
  emit('conversation.stopped_speaking');
  assert.equal(runtime.speaking, false);
  assert.ok(runtime.lastStop > 0);
  emit('conversation.started_speaking', 'replica');
  emit('conversation.replica.stopped_speaking');
  assert.equal(runtime.speaking, false);
  assert.equal(runtime.events.length, 8);
});

test('runner is off by default and rejects production, previews, missing identity and provider overrides', () => {
  assert.doesNotThrow(() => assertQaEnvironment(ENV));
  for (const overrides of [{ ENABLE_QA_SYNTHETIC_INTERVIEWS: undefined },
    { ENABLE_QA_SYNTHETIC_INTERVIEWS: 'false' }, { SUPABASE_URL: 'https://rytlclkkcvvnkoncfaid.supabase.co' },
    { SUPABASE_URL: 'https://yjjxzxoghlpguquknyso.supabase.co.evil.test' },
    { RENDER_SERVICE_ID: 'production' }, { RENDER_GIT_BRANCH: 'prod-backend-legacy' },
    { RENDER_EXTERNAL_URL: 'https://api.alphasourceai.com' }, { TAVUS_PERSONA_ID: 'p75bb8779b7d' },
    { TAVUS_API_BASE: 'https://evil.test' }, { OPENAI_API_KEY: '' }]) {
    assert.throws(() => assertQaEnvironment({ ...ENV, ...overrides }));
  }
});

test('network policy never forwards application API reads or mutations, production or arbitrary URLs', () => {
  const base = 'https://ia-backend-qa.onrender.com';
  assert.equal(networkAction(`${base}/tavus/end-conversation`, 'POST'), 'end');
  assert.equal(networkAction(`${base}/tavus/client-telemetry`, 'POST'), 'telemetry');
  assert.equal(networkAction(`${base}/public/interview-status?interview_id=synthetic`, 'GET'), 'status');
  for (const [url, method] of [[`${base}/candidateSubmit`, 'POST'], [`${base}/admin/candidates`, 'GET'],
    [`${base}/api/public-analytics/events`, 'POST'], ['https://api.alphasourceai.com/tavus/end-conversation', 'POST'],
    ['https://www.alphasourceai.com/assets/index.js', 'GET'], ['https://evil.test', 'GET'],
    ['https://alphasourceai-com.onrender.com/api/candidates', 'GET'], ['https://tavusapi.com/v2/personas/pa40626945f5', 'PATCH']]) {
    assert.equal(networkAction(url, method), 'deny', url);
  }
  assert.equal(networkAction('https://alphasourceai-com.onrender.com/interview/live', 'GET'), 'allow');
  assert.equal(networkAction('https://tavus.daily.co/room', 'GET'), 'allow');
  assert.equal(networkAction('https://evil-daily.co/room', 'GET'), 'deny');
});

function goodEvidence(scenario) {
  return { events: [...QUESTIONS.map((speech) => ({ type: 'conversation.utterance', role: 'replica', speech })),
    { type: 'conversation.utterance', role: 'replica', speech: CLOSING_QUESTION },
    { type: 'conversation.utterance', role: 'replica', speech: SCENARIOS[scenario].expected },
    ...ANSWERS.map((speech) => ({ type: 'conversation.utterance', role: 'candidate', speech }))],
    answered_questions: [0, 1, 2], candidate_utterances: 5, closing_reply_sent: true,
    end_requests: 1, end_reason: 'closing_utterance', provider_end_confirmed: true,
    completion_page: true, browser_errors: 0, audio_bytes: 1000, audio_transcript: SCENARIOS[scenario].expected };
}

test('each closing scenario demands all structured answers, exact terminal turn, received speech and audio', () => {
  assert.equal(QUESTIONS.length, 3);
  assert.equal(ANSWERS.length, 3);
  for (const scenario of Object.keys(SCENARIOS)) {
    const evidence = goodEvidence(scenario);
    assert.equal(evaluateRun(scenario, evidence).status, 'passed');
    for (const delta of [{ answered_questions: [0, 2, 1] }, { candidate_utterances: 0 },
      { closing_reply_sent: false }, { end_requests: 0 }, { end_requests: 2 }, { end_reason: 'manual' },
      { provider_end_confirmed: false }, { completion_page: false }, { audio_bytes: 0 },
      { audio_transcript: 'Thank you for your time.' }, { browser_errors: 1 }]) {
      assert.equal(evaluateRun(scenario, { ...evidence, ...delta }).status, 'failed');
    }
    const missingExpected = evidence.events.filter((item) => item.speech !== SCENARIOS[scenario].expected);
    assert.equal(evaluateRun(scenario, { ...evidence, events: missingExpected }).status, 'failed');
    assert.equal(evaluateRun(scenario, { ...evidence, events: [...evidence.events,
      { type: 'conversation.utterance', role: 'replica', speech: "Let's continue." }] }).status, 'failed');
    assert.equal(evaluateRun(scenario, { ...evidence, events: [...evidence.events,
      { type: 'conversation.utterance', role: 'replica', speech: CLOSING_QUESTION }] }).status, 'failed');
  }
});

test('one active run, retry idempotency and untrusted settings cannot cause extra vendor usage', async () => {
  let resolve, called = 0;
  const service = createQaSyntheticInterviewService({ env: ENV, execute: () => {
    called += 1;
    return new Promise((done) => { resolve = done; });
  } });
  const input = { scenario: 'no_questions', request_key: randomUUID() };
  const first = service.start(input);
  assert.equal(service.start(input).id, first.id);
  assert.throws(() => service.start({ ...input, request_key: randomUUID() }), { code: 'synthetic_test_already_running' });
  assert.throws(() => service.start({ ...input, url: 'https://prod.test' }), { code: 'synthetic_test_invalid_request' });
  await settle();
  assert.equal(called, 1);
  resolve({ status: 'passed', cleanup_confirmed: true });
  await settle();
  assert.equal(service.get(first.id).status, 'passed');
  assert.equal(service.start(input).id, first.id);
  assert.equal(called, 1);
  assert.equal(JSON.stringify(service.get(first.id)).includes('controller'), false);
});

test('cancellation, execution failure, unsafe cleanup and rate limits cannot appear passed', async () => {
  let time = 1000000;
  const service = createQaSyntheticInterviewService({ env: ENV, now: () => time,
    execute: async () => ({ status: 'passed', cleanup_confirmed: false }) });
  const run = service.start({ scenario: 'closing_process', request_key: randomUUID() });
  await settle();
  assert.equal(service.get(run.id).status, 'failed');
  assert.equal(service.list().can_start, false);
  assert.throws(() => service.start({ scenario: 'no_questions', request_key: randomUUID() }), { code: 'synthetic_cleanup_unconfirmed_wait_for_vendor_duration' });
  const cancelled = createQaSyntheticInterviewService({ env: ENV, execute: async () => ({ status: 'passed', cleanup_confirmed: true }) });
  const item = cancelled.start({ scenario: 'no_questions', request_key: randomUUID() });
  cancelled.cancel(item.id);
  await settle();
  assert.equal(cancelled.get(item.id).status, 'cancelled');
  const limited = createQaSyntheticInterviewService({ env: ENV, now: () => time,
    execute: async () => ({ status: 'failed', cleanup_confirmed: true }) });
  for (let index = 0; index < 4; index += 1) {
    limited.start({ scenario: 'no_questions', request_key: randomUUID() });
    await settle(); time += 16000;
  }
  assert.throws(() => limited.start({ scenario: 'no_questions', request_key: randomUUID() }), { code: 'synthetic_test_hourly_limit' });
});

test('admin route denies non-superadmins before listing, starting, stopping or retrieving audio', async () => {
  let calls = 0;
  const service = { list: () => { calls += 1; return {}; }, start: () => { calls += 1; return {}; },
    get: () => { calls += 1; return {}; }, cancel: () => { calls += 1; return {}; }, audio: () => { calls += 1; return Buffer.from('audio'); } };
  const app = express();
  app.use((req, _res, next) => { req.isGlobalAdmin = req.headers['x-test-admin'] === 'true'; next(); });
  app.use('/admin/synthetic-interviews', createAdminSyntheticInterviewsRouter({ service }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/admin/synthetic-interviews`;
  try {
    for (const [path, method] of [['', 'GET'], ['/runs', 'POST'], ['/runs/id/cancel', 'POST'], ['/runs/id/audio', 'GET']]) {
      assert.equal((await fetch(base + path, { method })).status, 403);
    }
    assert.equal(calls, 0);
    const response = await fetch(base, { headers: { 'x-test-admin': 'true' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('integration is additive and runner has no database, credit, OTP, document or email mutation path', () => {
  const app = readFileSync(require.resolve('../app'), 'utf8');
  assert.match(app, /adminRouter\.use\('\/synthetic-interviews', requireAuth, requireAdmin, createAdminSyntheticInterviewsRouter\(\)\)/);
  const runner = readFileSync(require.resolve('../src/lib/qaSyntheticInterviewRunner'), 'utf8');
  assert.doesNotMatch(runner, /supabase|\.rpc\(|\.patchPersona\(|createTavusInterviewHandler\(|callback_url\s*:|ensureTavusDocument/);
  assert.match(runner, /max_call_duration: 300/);
  assert.match(runner, /setRequestInterception\(true\)/);
  assert.match(runner, /setBypassServiceWorker\(true\)/);
});
