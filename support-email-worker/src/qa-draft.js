'use strict';
// Closed one-shot composition. No provider mocks, send transport, app import or polling.
const { loadQaConfig, MAILBOX, OWNER } = require('./qa-config');
const { createQaStore } = require('./qa-store');
const { readVerifiedInitial, inspectVerified } = require('./verified-gmail');
const { hex } = require('./gmail-read');
const { listOwnerMessages } = require('./qa-list');
const { createSupportEmailOAuth, REDIRECT } = require('../../src/lib/supportEmailOAuth');
const { createXaiDraftGenerator } = require('../../src/lib/supportEmailAdapters');
const { buildEmailPrompt, redactQuestion, validateDraft } = require('../../src/lib/supportEmailPolicy');
const { readKnowledgeFiles } = require('../../src/lib/supportVoiceKnowledge');
const { renderSupportEmailPreview } = require('../../src/lib/supportEmailPreview');
const fail = () => { throw new Error('SUPPORT_EMAIL_QA_HALTED'); };

function validateList(value) {
  if (!value || value.nextPageToken || (value.messages !== undefined && !Array.isArray(value.messages))) fail();
  const ids = (value.messages || []).map(m => m?.id);
  if (ids.length > 25 || ids.some(id => !hex(id)) || new Set(ids).size !== ids.length) fail();
  return ids;
}
function unchanged(a, b) {
  return b.senderVerified === true && b.sender === OWNER &&
    ['fingerprint', 'text', 'sender', 'threadKey', 'messageKey', 'gmailKey'].every(key => a[key] === b[key]);
}
async function runQaDraft() {
  if (arguments.length) fail();
  const deadline = Date.now() + 180000, initial = loadQaConfig();
  function check(reserve = 0) {
    if (Date.now() + reserve >= deadline || loadQaConfig().binding !== initial.binding) fail();
  }
  // Both static sections are hash checked before credentials or any durable claim.
  const knowledge = readKnowledgeFiles();
  const prompts = { public: buildEmailPrompt('public', knowledge), client: buildEmailPrompt('client', knowledge) };
  const store = createQaStore(initial.env.SUPABASE_SERVICE_ROLE_KEY, deadline);
  await store.preflight(); check();
  const oauthEnv = { ...initial.env, SUPPORT_EMAIL_GOOGLE_CLIENT_ID: initial.client.clientId,
    SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET: initial.client.clientSecret, SUPPORT_EMAIL_GOOGLE_REDIRECT_URI: REDIRECT };
  const guardedFetch = async (url, options = {}) => {
    check();
    const u = new URL(url);
    if (!['https://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/tokeninfo', 'https://oauth2.googleapis.com/revoke',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile', 'https://api.x.ai/v1/chat/completions'].includes(u.origin + u.pathname)) fail();
    const signal = AbortSignal.any([options.signal || AbortSignal.timeout(45000), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
    return fetch(url, { ...options, redirect: 'error', signal });
  };
  const auth = await createSupportEmailOAuth({ env: oauthEnv, fetchImpl: guardedFetch }).refresh(initial.grant.refreshToken);
  if (auth.mailbox !== MAILBOX || (auth.refreshToken && auth.refreshToken !== initial.grant.refreshToken) || auth.expiresAt < deadline + 60000) fail();
  check(15000);
  const ids = validateList(await listOwnerMessages({ accessToken: auth.accessToken, cutoverMs: initial.env.cutoverMs, deadline }));
  const generate = createXaiDraftGenerator({ apiKey: initial.env.XAI_API_KEY, fetchImpl: guardedFetch });
  const counts = { skipped: 0, duplicate: 0, draft: 0, review: 0, remaining: 0 };
  // Only successfully persisted synthetic previews stay in RAM; CLI never logs them.
  const previews = [];
  for (let n = 0; n < ids.length; n++) {
    if (Date.now() + 135000 >= deadline) { counts.remaining = ids.length - n; break; }
    check(15000);
    const decision = await readVerifiedInitial({ accessToken: auth.accessToken, id: ids[n], cutoverMs: initial.env.cutoverMs, baselineHistoryId: initial.grant.baselineHistoryId });
    if (!decision.eligible) { counts.skipped++; continue; }
    const record = inspectVerified(decision);
    if (!record.senderVerified || record.sender !== OWNER) { counts.skipped++; continue; }
    check(120000);
    const claim = await store.claim(record.threadKey, record.messageKey, record.gmailKey);
    if (claim === null) { counts.duplicate++; continue; }
    let finished = false, finishAttempted = false;
    try {
      check();
      let client = false;
      try { client = await store.recognizeClient(record.sender) === true; } catch (_) { /* Static public only. */ }
      check();
      const audience = client ? 'client' : 'public', prompt = prompts[audience];
      const result = validateDraft(await generate({ system: prompt.prompt, question: redactQuestion(record.text) }));
      const preview = renderSupportEmailPreview(result.body);
      check(25000);
      const fresh = await readVerifiedInitial({ accessToken: auth.accessToken, id: ids[n], cutoverMs: initial.env.cutoverMs, baselineHistoryId: initial.grant.baselineHistoryId });
      if (!fresh.eligible || !unchanged(record, inspectVerified(fresh))) throw new Error('CHANGED');
      check(10000);
      finishAttempted = true;
      await store.finish(claim, { status: 'draft', audience, knowledgeVersion: prompt.version, knowledgeHash: prompt.hash, body: result.body, humanReview: true });
      finished = true; counts.draft++;
      previews.push(Object.freeze({ claim, preview, audience }));
    } catch (_) {
      // Never retry generation or remove a durable tombstone. Changed/off config
      // permits no finish; claim remains bodyless. Ambiguous finish isn't replayed.
      if (!finished) {
        if (finishAttempted) fail(); // Ambiguous persistence is never retried.
        try { check(10000); await store.finish(claim, { status: 'review', reason: 'qa_generation_or_recheck_failed' }); counts.review++; }
        catch (_) { fail(); }
      }
    }
  }
  return Object.freeze({ status: 'draft_only', counts: Object.freeze(counts), previews: Object.freeze(previews) });
}
module.exports = { runQaDraft, validateList, unchanged };
