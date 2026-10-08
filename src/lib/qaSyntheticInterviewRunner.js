'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const {
  ANSWERS, CLOSING_QUESTION, MAX_AUDIO_BYTES, MAX_RUN_MS, QA_FRONTEND, QA_PERSONA_ID,
  QUESTIONS, SCENARIOS, assertQaEnvironment, evaluateRun, normalizeSpeech, scriptedAnswerReceived,
} = require('./qaSyntheticInterviews');
const { installSyntheticBrowser } = require('./qaSyntheticBrowser');

const QA_API_HOSTS = new Set(['ia-backend-qa.onrender.com', 'api-qa.alphasourceai.com']);
const DAILY_SCRIPT = 'https://unpkg.com/@daily-co/daily-js@0.91.0/dist/daily.js';
const fingerprint = (persona) => createHash('sha256').update(JSON.stringify({
  system_prompt: persona.system_prompt, layers: persona.layers, default_replica_id: persona.default_replica_id,
})).digest('hex');

function readSyntheticSnapshot() {
  const runtime = window.__qaSynthetic;
  return runtime && { events: runtime.events, lastStop: runtime.lastStop, speaking: runtime.speaking,
    recording: Boolean(runtime.recorder), path: location.pathname };
}

function networkAction(url, method) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'deny'; }
  if (parsed.origin === QA_FRONTEND && method === 'GET' &&
      (parsed.pathname.startsWith('/assets/') || ['/interview/live', '/favicon.ico'].includes(parsed.pathname))) return 'allow';
  if (url.startsWith(`blob:${QA_FRONTEND}/`) && method === 'GET') return 'allow';
  if (url === DAILY_SCRIPT && method === 'GET') return 'allow';
  if (parsed.protocol === 'https:' && (parsed.hostname === 'daily.co' || parsed.hostname.endsWith('.daily.co'))) return 'allow';
  if (parsed.protocol === 'https:' && QA_API_HOSTS.has(parsed.hostname)) {
    if (method === 'OPTIONS' && ['/tavus/end-conversation', '/tavus/client-telemetry'].includes(parsed.pathname)) return 'preflight';
    if (method === 'POST' && parsed.pathname === '/tavus/end-conversation') return 'end';
    if (method === 'POST' && parsed.pathname === '/tavus/client-telemetry') return 'telemetry';
    if (method === 'GET' && parsed.pathname === '/public/interview-status') return 'status';
  }
  return 'deny';
}

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const chromium = require('@sparticuz/chromium');
  return puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath(),
    args: [...chromium.args, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'], headless: true, protocolTimeout: 45000 });
}

async function runSyntheticInterview({ id, scenario, signal, update }, dependencies = {}) {
  assertQaEnvironment();
  const { tavusHttpClient } = require('./tavusHttpClient');
  const client = dependencies.client || tavusHttpClient;
  const OpenAI = require('openai');
  const ai = dependencies.ai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 25000 });
  const { buildConversationalContext, buildCustomGreeting, resolveSilenceEngagementOwner } = require('../../handlers/createTavusInterview');
  let browser, page, conversation, beforePersona;
  let endPromise = null;
  let providerEnded = false;
  let frontendEndSucceeded = false;
  let audio = null;
  let error = null;
  let checks = [];
  let status = 'failed';
  let createAttempted = false;
  const evidence = { events: [], answered_questions: [], candidate_utterances: 0, closing_reply_sent: false,
    end_requests: 0, end_reason: null, provider_end_confirmed: false, completion_page: false,
    browser_errors: 0, audio_bytes: 0, audio_transcript: '' };
  const captureEvents = (events) => {
    if (!Array.isArray(events)) return;
    evidence.events = events;
    evidence.candidate_utterances = events.filter((item) => item.type === 'conversation.utterance' &&
      ['candidate', 'user', 'participant'].includes(item.role)).length;
  };
  const endProvider = () => {
    if (!conversation?.conversation_id) return Promise.resolve(false);
    if (!endPromise) endPromise = (async () => {
      await client.endConversation(conversation.conversation_id);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const state = await client.getConversation(conversation.conversation_id);
        if (state?.status === 'ended') { providerEnded = true; return true; }
        await delay(750);
      }
      return false;
    })();
    return endPromise;
  };
  const closeBrowser = () => browser?.close().catch(() => { browser.process()?.kill('SIGKILL'); });
  const onAbort = () => { void closeBrowser(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    browser = await (dependencies.launchBrowser || launchBrowser)();
    signal.throwIfAborted();
    page = await browser.newPage();
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('pageerror', () => { evidence.browser_errors += 1; });
    page.on('request', (request) => {
      void (async () => {
        const action = networkAction(request.url(), request.method());
        const headers = { 'access-control-allow-origin': QA_FRONTEND, 'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization', 'cache-control': 'no-store' };
        const reply = (body, statusCode = 200) => request.respond({ status: statusCode, contentType: 'application/json', headers, body: JSON.stringify(body) });
        if (action === 'allow') return request.continue();
        if (action === 'preflight') return reply({});
        const body = request.postData() ? JSON.parse(request.postData()) : {};
        if (action === 'status') {
          const query = new URL(request.url()).searchParams;
          if (query.get('interview_id') !== id || query.get('role_token') !== id) return request.abort();
          return reply({ status: 'InProgress' });
        }
        if (action === 'telemetry' && body.interview_id === id) return reply({ ok: true });
        if (action === 'end') {
          evidence.end_requests += 1;
          evidence.end_reason = body.reason;
          if (body.interview_id !== id || body.role_token !== id || body.conversation_id !== conversation?.conversation_id ||
              body.reason !== 'closing_utterance' || evidence.end_requests !== 1) return reply({ error: 'synthetic_end_binding_mismatch' }, 403);
          const recorded = await page.evaluate(async () => {
            const runtime = window.__qaSynthetic;
            return runtime && { audio: await runtime.finishRecording(), events: runtime.events };
          });
          captureEvents(recorded?.events);
          if (recorded?.audio) audio = Buffer.from(recorded.audio, 'base64');
          frontendEndSucceeded = await endProvider();
          return reply({ ok: frontendEndSucceeded }, frontendEndSucceeded ? 200 : 502);
        }
        return request.abort();
      })().catch(() => { if (!request.isInterceptResolutionHandled()) void request.abort().catch(() => {}); });
    });
    const scripts = ['My favorite season is summer because I like the longer days and spending time outdoors.', ...ANSWERS,
      'I documented the customer need, confirmed the next step and reviewed the results with my manager. Our follow-up time improved from three days to one day.', SCENARIOS[scenario].reply];
    const clips = [];
    for (const input of scripts) {
      signal.throwIfAborted();
      const response = await ai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input, response_format: 'pcm' }, { signal });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_AUDIO_BYTES) throw new Error('synthetic_audio_limit');
      clips.push(bytes.toString('base64'));
    }
    beforePersona = await client.getPersona(QA_PERSONA_ID);
    if (beforePersona.persona_id !== QA_PERSONA_ID) throw new Error('synthetic_persona_mismatch');
    signal.throwIfAborted();
    update('Starting browser interview');
    createAttempted = true;
    conversation = await client.createConversation({ persona_id: QA_PERSONA_ID,
      conversation_name: `qa-synthetic-${id}`,
      custom_greeting: buildCustomGreeting('Synthetic'),
      conversational_context: buildConversationalContext('Synthetic', 'QA Sales Test', 'QA Test Organization',
        QUESTIONS, '', 5, resolveSilenceEngagementOwner()),
      properties: { max_call_duration: 300, participant_left_timeout: 15 },
    });
    const room = new URL(conversation?.conversation_url || '');
    if (!conversation?.conversation_id || room.origin !== 'https://tavus.daily.co') throw new Error('synthetic_vendor_response_invalid');
    signal.throwIfAborted();
    await page.evaluateOnNewDocument(installSyntheticBrowser, {
      conversation_url: room.href, conversation_id: conversation.conversation_id, interview_id: id,
      role_token: id, max_interview_minutes: 5, preflightAudioState: 'ready',
      silence_engagement_owner: resolveSilenceEngagementOwner(),
      application_inactivity_control_enabled: resolveSilenceEngagementOwner() === 'application_inactivity',
    });
    await page.goto(`${QA_FRONTEND}/interview/live`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const deadline = Date.now() + MAX_RUN_MS;
    let cursor = 0, warmupAnswered = false, previousSpeech = '', lastAnswerAt = 0, followups = 0;
    while (Date.now() < deadline && !frontendEndSucceeded) {
      signal.throwIfAborted();
      const snapshot = await page.evaluate(readSyntheticSnapshot);
      if (!snapshot) throw new Error('synthetic_browser_observer_missing');
      captureEvents(snapshot.events);
      let turn = null;
      while (cursor < snapshot.events.length) {
        const item = snapshot.events[cursor];
        if (item.type === 'conversation.utterance' && ['replica', 'assistant', 'agent'].includes(item.role)) {
          if (snapshot.speaking || snapshot.lastStop < item.at || Date.now() - snapshot.lastStop < 700) break;
          turn = item;
        }
        cursor += 1;
      }
      if (turn && normalizeSpeech(turn.speech) !== previousSpeech && turn.at > lastAnswerAt) {
        previousSpeech = normalizeSpeech(turn.speech);
        let clip;
        if (!warmupAnswered) {
          if (!/favorite season/i.test(turn.speech)) throw new Error('synthetic_warmup_not_observed');
          warmupAnswered = true;
          clip = 0;
          update('Answering warm-up');
        } else if (previousSpeech.includes(normalizeSpeech(CLOSING_QUESTION))) {
          if (evidence.answered_questions.length !== QUESTIONS.length || evidence.closing_reply_sent) throw new Error('synthetic_premature_or_repeated_closing');
          evidence.closing_reply_sent = true;
          clip = 5;
          update('Testing closing response');
        } else if (!evidence.closing_reply_sent) {
          const question = QUESTIONS.findIndex((text) => previousSpeech.includes(normalizeSpeech(text)));
          if (question >= 0) {
            if (question !== evidence.answered_questions.length) throw new Error('synthetic_question_order_mismatch');
            evidence.answered_questions.push(question);
            clip = question + 1;
            update(`Answering question ${question + 1} of 3`);
          } else {
            if (!evidence.answered_questions.length || followups >= 3) throw new Error('synthetic_unexpected_turn');
            followups += 1;
            clip = 4;
          }
        } else if (previousSpeech !== normalizeSpeech(SCENARIOS[scenario].expected)) {
          throw new Error('synthetic_unexpected_closing_response');
        }
        if (clip !== undefined) {
          if (!snapshot.recording) throw new Error('synthetic_remote_audio_unavailable');
          let playback;
          try {
            playback = await page.evaluate((audioClip) => window.__qaSynthetic.play(audioClip), clips[clip]);
          } catch (failure) {
            const known = String(failure?.message).match(/synthetic_audio_(?:invalid|resume_stalled|overlap)/);
            if (known) throw new Error(known[0]);
            throw new Error(failure?.name === 'ProtocolError' ? 'synthetic_audio_protocol_timeout' : 'synthetic_audio_playback_failed');
          }
          lastAnswerAt = playback.started_at;
          const acknowledgementDeadline = Math.min(deadline,
            Date.now() + Math.max(20000, playback.duration_seconds * 2000 + 10000));
          let acknowledged = false;
          while (Date.now() < acknowledgementDeadline) {
            signal.throwIfAborted();
            const received = await page.evaluate(readSyntheticSnapshot);
            captureEvents(received?.events);
            if (scriptedAnswerReceived(evidence.events, scripts[clip], playback.started_at)) {
              acknowledged = true;
              if (received) await page.evaluate(() => window.__qaSynthetic.stopPlayback());
              break;
            }
            if (!received || frontendEndSucceeded) break;
            await delay(350, undefined, { signal });
          }
          if (!acknowledged) throw new Error('synthetic_answer_not_received');
        }
      }
      await delay(350, undefined, { signal });
    }
    if (!frontendEndSucceeded) throw new Error('synthetic_completion_timeout');
    update('Verifying received audio');
    evidence.provider_end_confirmed = frontendEndSucceeded;
    await page.waitForFunction(() => location.pathname === '/interview/complete', { timeout: 10000 });
    evidence.completion_page = true;
    evidence.audio_bytes = audio?.length || 0;
    if (!audio?.length || audio.length > MAX_AUDIO_BYTES) throw new Error('synthetic_recording_missing');
    const transcript = await ai.audio.transcriptions.create({ model: 'whisper-1',
      file: await OpenAI.toFile(audio, 'qa-interviewer.webm', { type: 'audio/webm' }), language: 'en' }, { signal });
    evidence.audio_transcript = transcript.text || '';
    const result = evaluateRun(scenario, evidence);
    status = result.status;
    checks = result.checks;
  } catch (failure) {
    error = signal.aborted ? 'synthetic_run_cancelled_or_timed_out'
      : /^synthetic_[a-z_]{1,65}$/.test(String(failure?.message || '')) ? failure.message : 'synthetic_run_incomplete';
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!audio && page && !page.isClosed()) {
      try {
        const recorded = await page.evaluate(async () => {
          const runtime = window.__qaSynthetic;
          if (!runtime) return null;
          runtime.stopPlayback();
          return { audio: await runtime.finishRecording(), events: runtime.events };
        });
        captureEvents(recorded?.events);
        if (recorded?.audio) audio = Buffer.from(recorded.audio, 'base64');
      } catch {}
    }
    try { await endProvider(); } catch { error = 'synthetic_vendor_cleanup_unconfirmed'; }
    try {
      if (beforePersona) {
        const after = await client.getPersona(QA_PERSONA_ID);
        if (fingerprint(beforePersona) !== fingerprint(after)) { status = 'failed'; error = 'synthetic_persona_changed'; }
      }
    } catch { status = 'failed'; error = 'synthetic_persona_readback_unavailable'; }
    await closeBrowser();
  }
  if (audio?.length > MAX_AUDIO_BYTES) audio = null;
  return { status, checks, error, audio, cleanup_confirmed: !createAttempted || providerEnded,
    transcript: evidence.events.filter((item) => item.type === 'conversation.utterance')
      .map(({ role, speech }) => ({ role, speech })).slice(0, 30) };
}

module.exports = { networkAction, runSyntheticInterview };
