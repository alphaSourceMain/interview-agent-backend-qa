'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const ID = {
  client: '73000000-0000-4000-8000-000000000001',
  role: '73000000-0000-4000-8000-000000000002',
  candidate: '73000000-0000-4000-8000-000000000003',
  priorInterview: '73000000-0000-4000-8000-000000000004',
  replacementInterview: '73000000-0000-4000-8000-000000000005',
  legacyReport: '73000000-0000-4000-8000-000000000006',
};

test('R1 red Tavus regression: transmitted timeout is classified ambiguous and uses exact interview identity', async () => {
  process.env.TAVUS_API_KEY = 'test-key';
  process.env.TAVUS_REPLICA_ID = 'test-replica';
  process.env.TAVUS_PERSONA_ID = 'test-persona';
  process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
  process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
  let sentPayload = null;
  const tavusHttpClient = {
    async createConversation(payload) {
      sentPayload = payload;
      const error = new Error('socket hang up after request transmission');
      error.code = 'ECONNRESET';
      error.category = 'network';
      error.attemptCount = 1;
      throw error;
    },
  };
  const { createTavusInterviewHandler } = require('../src/services/tavusInterview');
  const error = await createTavusInterviewHandler(
    { id: ID.candidate, name: 'Synthetic' },
    { id: ID.role, title: 'Synthetic role', tavus_document_id: 'document-test' },
    'https://example.test/webhook',
    { interviewId: ID.replacementInterview, maxInterviewMinutes: 10, tavusHttpClient },
  ).then(() => null, (caught) => caught);
  assert.equal(error?.failureCategory, 'ambiguous_acceptance');
  assert.equal(error?.retryable, false);
  assert.equal(sentPayload?.conversation_name, `alphascreen-interview-${ID.replacementInterview}`);
});
