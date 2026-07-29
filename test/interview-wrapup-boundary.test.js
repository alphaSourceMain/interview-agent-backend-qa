'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');

const SYNTHETIC_INTERVIEW_ID = '11111111-1111-4111-8111-111111111111';

async function captureConversationPayload() {
  const originalPost = axios.post;
  const previousEnv = {
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    TAVUS_API_KEY: process.env.TAVUS_API_KEY,
    TAVUS_PERSONA_ID: process.env.TAVUS_PERSONA_ID,
    TAVUS_REPLICA_ID: process.env.TAVUS_REPLICA_ID,
  };
  let payload = null;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key';
  process.env.SUPABASE_ANON_KEY = 'synthetic-anon-key';
  process.env.TAVUS_API_KEY = 'synthetic-test-key';
  process.env.TAVUS_PERSONA_ID = 'synthetic-test-persona';
  process.env.TAVUS_REPLICA_ID = 'synthetic-test-replica';
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
    const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');
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
        interviewId: SYNTHETIC_INTERVIEW_ID,
        maxInterviewMinutes: 10,
      },
    );
    return payload;
  } finally {
    axios.post = originalPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('conversation context treats runtime timing state as private behavior control', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /runtime closing control state/i);
  assert.match(context, /never (?:quote|mention|summarize|paraphrase|reveal)/i);
  assert.match(context, /two-minute and one-minute browser warnings are visual-only/i);
  assert.doesNotMatch(context, /briefly acknowledge that time is running low/i);
  assert.doesNotMatch(context, /If the system or front-end sends a time warning/i);
});

test('closing question is offered once and no candidate acknowledgment is required', async () => {
  const payload = await captureConversationPayload();
  const context = String(payload?.conversational_context || '');

  assert.match(context, /invite one final candidate question when practical/i);
  assert.match(context, /answer it briefly[\s\S]*then close immediately/i);
  assert.match(context, /do not require (?:a )?candidate acknowledgment/i);
  assert.doesNotMatch(context, /Any other questions\? If not, just say 'no'\./i);
});

test('provider duration remains an independent hard upper bound', async () => {
  const payload = await captureConversationPayload();

  assert.equal(payload?.properties?.max_call_duration, 600);
  assert.equal(payload?.properties?.participant_left_timeout, 60);
});
