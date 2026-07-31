'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'synthetic-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'synthetic-anon-key';

const {
  SILENCE_ENGAGEMENT_OWNER_PROMPT,
  SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT,
  SILENCE_ENGAGEMENT_PROMPT_LINES,
  buildConversationalContext,
  createTavusInterviewHandler,
  resolveSilenceEngagementOwner,
} = require('../handlers/createTavusInterview');

const INTERVIEW_ID = '81000000-0000-4000-8000-000000000001';
const ENV_KEYS = [
  'INTERVIEW_SILENCE_ENGAGEMENT_OWNER',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
  'TAVUS_API_KEY',
  'TAVUS_PERSONA_ID',
  'TAVUS_REPLICA_ID',
];

function occurrences(value, search) {
  return String(value).split(search).length - 1;
}

function contextFor(owner) {
  return buildConversationalContext(
    'Synthetic Candidate',
    'Synthetic Role',
    'Synthetic Company',
    ['Describe a synthetic project?'],
    'Use concise role-specific transitions.',
    10,
    owner,
  );
}

async function captureConversation(owner, options = {}) {
  const originalPost = axios.post;
  const originalInfo = console.info;
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const infoEvents = [];
  let payload = null;

  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'synthetic-anon-key';
  process.env.TAVUS_API_KEY = 'synthetic-tavus-key';
  process.env.TAVUS_PERSONA_ID = 'synthetic-pal';
  process.env.TAVUS_REPLICA_ID = 'synthetic-face';
  if (owner === undefined) delete process.env.INTERVIEW_SILENCE_ENGAGEMENT_OWNER;
  else process.env.INTERVIEW_SILENCE_ENGAGEMENT_OWNER = owner;

  console.info = (...args) => infoEvents.push(args);
  axios.post = async (_url, body) => {
    payload = body;
    return {
      data: {
        conversation_id: 'synthetic-conversation',
        conversation_url: 'https://example.invalid/synthetic-conversation',
      },
    };
  };

  try {
    await createTavusInterviewHandler(
      { id: 'synthetic-candidate', name: 'Synthetic Candidate' },
      {
        id: 'synthetic-role',
        title: 'Synthetic Role',
        tavus_document_id: 'synthetic-document',
        rubric_questions: ['Describe a synthetic project?'],
      },
      'https://example.invalid/webhook',
      {
        companyName: 'Synthetic Company',
        interviewId: INTERVIEW_ID,
        maxInterviewMinutes: 10,
        ...options,
      },
    );
    return { infoEvents, payload };
  } finally {
    axios.post = originalPost;
    console.info = originalInfo;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('ownership setting defaults and fails safely to prompt', () => {
  assert.equal(resolveSilenceEngagementOwner({}), SILENCE_ENGAGEMENT_OWNER_PROMPT);
  assert.equal(
    resolveSilenceEngagementOwner({ INTERVIEW_SILENCE_ENGAGEMENT_OWNER: 'prompt' }),
    SILENCE_ENGAGEMENT_OWNER_PROMPT,
  );
  assert.equal(
    resolveSilenceEngagementOwner({ INTERVIEW_SILENCE_ENGAGEMENT_OWNER: ' tavus_patient ' }),
    SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT,
  );
  for (const value of ['patient', 'eager', 'unknown', '1']) {
    assert.equal(
      resolveSilenceEngagementOwner({ INTERVIEW_SILENCE_ENGAGEMENT_OWNER: value }),
      SILENCE_ENGAGEMENT_OWNER_PROMPT,
    );
  }
});

test('prompt owner includes each existing silence instruction exactly once', () => {
  const context = contextFor(SILENCE_ENGAGEMENT_OWNER_PROMPT);
  for (const line of SILENCE_ENGAGEMENT_PROMPT_LINES) {
    assert.equal(occurrences(context, line), 1);
  }
});

test('tavus patient owner omits only the two autonomous silence instructions', () => {
  const promptContext = contextFor(SILENCE_ENGAGEMENT_OWNER_PROMPT);
  const patientContext = contextFor(SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT);
  const promptWithoutSilenceInstructions = promptContext
    .split('\n')
    .filter((line) => !SILENCE_ENGAGEMENT_PROMPT_LINES.includes(line))
    .join('\n');

  assert.equal(patientContext, promptWithoutSilenceInstructions);
  for (const line of SILENCE_ENGAGEMENT_PROMPT_LINES) {
    assert.equal(occurrences(patientContext, line), 0);
  }
});

test('timer, closing, question lock, and provider-end instructions are unchanged in patient mode', () => {
  const context = contextFor(SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT);
  for (const invariant of [
    'The two-minute and one-minute browser warnings are visual-only.',
    'When runtime control state becomes QUESTION_LOCKED',
    'When runtime control state becomes CLOSING_ONLY',
    'When runtime control state becomes TERMINATION_ONLY',
    'The application deterministically owns the final candidate-question invitation, farewell, and provider-end request.',
  ]) {
    assert.match(context, new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('ordinary and replacement-style provider creation both receive tavus patient ownership', async () => {
  for (const attemptNumber of [1, 2]) {
    const { payload } = await captureConversation(SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT, { attemptNumber });
    for (const line of SILENCE_ENGAGEMENT_PROMPT_LINES) {
      assert.equal(occurrences(payload.conversational_context, line), 0);
    }
    assert.equal(payload.properties.max_call_duration, 600);
    assert.equal(payload.properties.participant_left_timeout, 60);
  }
});

test('conversation options cannot override the server-controlled owner', async () => {
  const { payload } = await captureConversation(SILENCE_ENGAGEMENT_OWNER_PROMPT, {
    silenceEngagementOwner: SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT,
  });
  for (const line of SILENCE_ENGAGEMENT_PROMPT_LINES) {
    assert.equal(occurrences(payload.conversational_context, line), 1);
  }
});

test('bounded ownership evidence contains only allowlisted configuration state', async () => {
  const { infoEvents } = await captureConversation(SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT);
  const evidence = infoEvents.find(([label]) => label === '[tavus-silence-engagement]');

  assert.ok(evidence);
  assert.deepEqual(evidence[1], {
    ownership_mode: SILENCE_ENGAGEMENT_OWNER_TAVUS_PATIENT,
    prompt_silence_instruction_included: false,
    idle_engagement_expectation: 'patient',
  });
  assert.deepEqual(Object.keys(evidence[1]).sort(), [
    'idle_engagement_expectation',
    'ownership_mode',
    'prompt_silence_instruction_included',
  ]);
});

test('absent and malformed settings retain default prompt behavior in provider payloads', async () => {
  for (const owner of [undefined, 'malformed']) {
    const { payload, infoEvents } = await captureConversation(owner);
    for (const line of SILENCE_ENGAGEMENT_PROMPT_LINES) {
      assert.equal(occurrences(payload.conversational_context, line), 1);
    }
    const evidence = infoEvents.find(([label]) => label === '[tavus-silence-engagement]');
    assert.equal(evidence?.[1]?.ownership_mode, SILENCE_ENGAGEMENT_OWNER_PROMPT);
    assert.equal(evidence?.[1]?.prompt_silence_instruction_included, true);
    assert.equal(evidence?.[1]?.idle_engagement_expectation, 'off');
  }
});
