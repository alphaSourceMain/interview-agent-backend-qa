'use strict';

const { randomUUID } = require('node:crypto');
const {
  NORMAL_COMPLETION_FAREWELL_TEXT,
  CLOSING_PROCESS_ANSWER,
  CLOSING_UNAVAILABLE_ANSWER,
  CLOSING_INTERNAL_ANSWER,
} = require('./interviewClosingContract');

const QA_FRONTEND = 'https://alphasourceai-com.onrender.com';
const QA_SERVICE_ID = 'srv-d2s94oumcj7s73abnq70';
const QA_PERSONA_ID = 'pa40626945f5';
const MAX_RUN_MS = 5 * 60 * 1000;
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
const CLOSING_QUESTION = 'Do you have any questions before we wrap up?';
const QUESTIONS = Object.freeze([
  'How do you organize your sales follow-up work?',
  'Describe a time you handled a customer objection.',
  'How do you measure whether your sales process is working?',
]);
const ANSWERS = Object.freeze([
  'I group leads by next action and due date in our customer relationship system. Each morning I review overdue tasks and prioritize customers waiting on a decision. I record the outcome of every call and schedule the next step. This reduced missed follow-ups and helped our team respond within one business day.',
  'A customer was concerned about the price of our service. I asked what result they needed and compared the cost with the time their team was losing. I offered a smaller initial scope, not an unsupported discount. They agreed to a pilot, and I documented the commitments and checked the results with them after two weeks.',
  'I track response rate, qualified meetings, conversion rate and time to close each week. I compare these with the prior month and inspect individual deals when a rate changes. For example, I improved our discovery checklist after finding that poorly qualified meetings rarely closed. We then saw fewer wasted meetings and more consistent conversion.',
]);
const SCENARIOS = Object.freeze({
  no_questions: { label: 'No closing questions', reply: 'No questions, thank you.', expected: NORMAL_COMPLETION_FAREWELL_TEXT },
  closing_next_steps: { label: 'What happens next?', reply: 'What happens next?', expected: `${CLOSING_UNAVAILABLE_ANSWER} ${NORMAL_COMPLETION_FAREWELL_TEXT}` },
  closing_process: { label: 'What are you doing?', reply: 'What are you doing?', expected: `${CLOSING_PROCESS_ANSWER} ${NORMAL_COMPLETION_FAREWELL_TEXT}` },
  closing_internal: { label: 'Request evaluation details', reply: 'Can you explain the scoring rubric?', expected: `${CLOSING_INTERNAL_ANSWER} ${NORMAL_COMPLETION_FAREWELL_TEXT}` },
});

function fault(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

function assertQaEnvironment(env = process.env) {
  if (env.ENABLE_QA_SYNTHETIC_INTERVIEWS !== 'true') throw fault('synthetic_tests_disabled');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw fault('synthetic_tests_wrong_environment'); }
  if (url.origin !== 'https://yjjxzxoghlpguquknyso.supabase.co' || url.username || url.password ||
      env.RENDER_SERVICE_ID !== QA_SERVICE_ID || env.TAVUS_PERSONA_ID !== QA_PERSONA_ID ||
      env.RENDER_GIT_BRANCH !== 'qa-backend' || env.RENDER_EXTERNAL_URL !== 'https://ia-backend-qa.onrender.com') {
    throw fault('synthetic_tests_wrong_environment');
  }
  for (const key of ['TAVUS_API_BASE', 'TAVUS_API_BASE_URL']) {
    if (env[key] && String(env[key]).replace(/\/+$/, '') !== 'https://tavusapi.com/v2') {
      throw fault('synthetic_tests_wrong_provider');
    }
  }
  if (!env.TAVUS_API_KEY || !env.OPENAI_API_KEY) throw fault('synthetic_tests_not_configured');
}

function normalizeSpeech(value) {
  return String(value || '').trim().replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').toLowerCase();
}

function spokenWords(value) {
  return normalizeSpeech(value).replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
}

function scriptedAnswerReceived(events, expected, startedAt) {
  if (!spokenWords(expected) || !Number.isFinite(startedAt)) return false;
  const words = spokenWords(expected).split(' ');
  const prefix = words.slice(0, 8).join(' ');
  const suffix = words.slice(-4).join(' ');
  const received = events.filter((item) => item.at >= startedAt && item.type === 'conversation.utterance' &&
    ['candidate', 'user', 'participant'].includes(item.role)).map((item) => spokenWords(item.speech)).join(' ');
  return received.includes(prefix) && received.includes(suffix) &&
    received.split(' ').length >= Math.ceil(words.length * 0.8);
}

function evaluateRun(scenarioId, evidence) {
  const expected = SCENARIOS[scenarioId].expected;
  const replica = evidence.events.filter((item) => item.type === 'conversation.utterance' &&
    ['replica', 'assistant', 'agent'].includes(item.role));
  const candidateSpeech = evidence.events.filter((item) => item.type === 'conversation.utterance' &&
    ['candidate', 'user', 'participant'].includes(item.role)).map((item) => spokenWords(item.speech)).join(' ');
  const spoken = replica.map((item) => normalizeSpeech(item.speech));
  const closingIndex = spoken.findIndex((speech) => speech.includes(normalizeSpeech(CLOSING_QUESTION)));
  const expectedIndex = spoken.findIndex((speech) => speech === normalizeSpeech(expected));
  const checks = [
    { name: 'All three structured questions answered in order', passed: evidence.answered_questions.join(',') === '0,1,2' },
    { name: 'Candidate speech reached Tavus', passed: evidence.candidate_utterances >= 5 },
    { name: 'All scripted answer content received', passed: ANSWERS.every((answer) =>
      candidateSpeech.includes(spokenWords(answer).split(' ').slice(0, 8).join(' '))) },
    { name: 'Closing invitation exactly once', passed: spoken.filter((speech) => speech.includes(normalizeSpeech(CLOSING_QUESTION))).length === 1 },
    { name: 'Selected closing response sent', passed: evidence.closing_reply_sent === true },
    { name: 'Exact approved farewell, without another interviewer turn', passed: closingIndex >= 0 && expectedIndex > closingIndex && expectedIndex === spoken.length - 1 },
    { name: 'No spoken control instructions', passed: !spoken.some((speech) => /end_call|response_to_user|natural_conclusion|\{\s*"/.test(speech)) },
    { name: 'One browser-owned normal end request', passed: evidence.end_requests === 1 && evidence.end_reason === 'closing_utterance' },
    { name: 'Vendor end confirmed', passed: evidence.provider_end_confirmed === true },
    { name: 'Browser reached completion page', passed: evidence.completion_page === true },
    { name: 'Full farewell captured in received audio', passed: evidence.audio_bytes > 0 && spokenWords(evidence.audio_transcript).includes(spokenWords(expected)) },
    { name: 'No browser execution error', passed: evidence.browser_errors === 0 },
  ];
  return { status: checks.every((check) => check.passed) ? 'passed' : 'failed', checks };
}

function createQaSyntheticInterviewService({ env = process.env, execute, now = Date.now } = {}) {
  const runs = new Map();
  const starts = [];
  let active = null;
  let cleanupBlockedUntil = 0;
  const readiness = () => {
    try { assertQaEnvironment(env); return { enabled: true, unavailable_reason: null }; }
    catch (error) { return { enabled: false, unavailable_reason: error.code }; }
  };
  const publicRun = (run) => {
    const { audio, controller, ...safe } = run;
    return { ...safe, audio_available: Boolean(audio?.length) };
  };
  const requireRun = (id) => {
    const run = runs.get(id);
    if (!run) throw fault('synthetic_run_not_found_or_expired', 404);
    return run;
  };
  return {
    list() {
      return { ...readiness(), scenarios: Object.entries(SCENARIOS).map(([id, item]) => ({ id, label: item.label })),
        can_start: !active && now() >= cleanupBlockedUntil,
        max_minutes: MAX_RUN_MS / 60000, scope: 'Live browser closing flow only',
        runs: [...runs.values()].reverse().map(publicRun) };
    },
    get(id) { return publicRun(requireRun(id)); },
    audio(id) {
      const audio = requireRun(id).audio;
      if (!audio?.length) throw fault('synthetic_audio_unavailable', 404);
      return audio;
    },
    start(input = {}) {
      assertQaEnvironment(env);
      if (now() < cleanupBlockedUntil) throw fault('synthetic_cleanup_unconfirmed_wait_for_vendor_duration', 409);
      if (!input || Object.keys(input).some((key) => !['scenario', 'request_key'].includes(key)) ||
          !Object.hasOwn(SCENARIOS, input.scenario) || !/^[a-f0-9-]{36}$/i.test(String(input.request_key || ''))) {
        throw fault('synthetic_test_invalid_request', 400);
      }
      const existing = [...runs.values()].find((run) => run.request_key === input.request_key);
      if (existing) return publicRun(existing);
      if (active) throw fault('synthetic_test_already_running', 409);
      if (starts.length && now() - starts[starts.length - 1] < 15000) throw fault('synthetic_test_cooldown', 429);
      while (starts.length && now() - starts[0] >= 60 * 60 * 1000) starts.shift();
      if (starts.length >= 4) throw fault('synthetic_test_hourly_limit', 429);
      const run = { id: randomUUID(), scenario: input.scenario, request_key: input.request_key,
        status: 'running', phase: 'Preparing audio', created_at: new Date(now()).toISOString(),
        finished_at: null, checks: [], transcript: [], error: null, cleanup_confirmed: false,
        controller: new AbortController(), audio: null };
      while (runs.size >= 4) runs.delete(runs.keys().next().value);
      runs.set(run.id, run);
      starts.push(now());
      active = run;
      queueMicrotask(async () => {
        // Includes preparation and verification; the vendor call itself has a five-minute cap.
        const deadline = setTimeout(() => run.controller.abort(), MAX_RUN_MS + 90000);
        deadline.unref?.();
        try {
          const result = await execute({ id: run.id, scenario: run.scenario, signal: run.controller.signal,
            update: (phase) => { run.phase = phase; } });
          run.status = run.controller.signal.aborted ? 'cancelled' : (result.status === 'passed' ? 'passed' : 'failed');
          run.checks = result.checks || [];
          run.transcript = result.transcript || [];
          run.playback_diagnostics = (result.playback_diagnostics || []).slice(0, 8);
          run.error = result.error || null;
          run.cleanup_confirmed = result.cleanup_confirmed === true;
          if (Buffer.isBuffer(result.audio) && result.audio.length <= MAX_AUDIO_BYTES) run.audio = result.audio;
          if (!run.cleanup_confirmed) run.status = 'failed';
        } catch {
          run.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
          run.error = 'synthetic_runner_failed';
        } finally {
          clearTimeout(deadline);
          if (!run.cleanup_confirmed) cleanupBlockedUntil = now() + MAX_RUN_MS;
          run.finished_at = new Date(now()).toISOString();
          run.phase = 'Finished';
          active = null;
        }
      });
      return publicRun(run);
    },
    cancel(id) {
      const run = requireRun(id);
      if (run.status === 'running') { run.phase = 'Stopping'; run.controller.abort(); }
      return publicRun(run);
    },
  };
}

module.exports = { ANSWERS, CLOSING_QUESTION, MAX_AUDIO_BYTES, MAX_RUN_MS, QA_FRONTEND, QA_PERSONA_ID,
  QA_SERVICE_ID, QUESTIONS, SCENARIOS, assertQaEnvironment, createQaSyntheticInterviewService,
  evaluateRun, normalizeSpeech, scriptedAnswerReceived };
