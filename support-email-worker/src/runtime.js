'use strict';
// Closed hosted QA composition; no arguments, dependency hooks, general customers
// or old-draft sweeper. Unit replacements exist only in the test process.
const { createHash } = require('node:crypto');
const { loadRuntimeConfig } = require('./runtime-config');
const { MAILBOX, OWNER } = require('./qa-config');
const { createRuntimeStore } = require('./runtime-store');
const { readJson } = require('./qa-store');
const { recognizeRuntimeClient } = require('./runtime-membership');
const { refreshSendReadonly } = require('./send-readonly-refresh');
const { createSendOAuth } = require('./send-oauth');
const { boundedJson, decimal, hex, decodeEnvelope } = require('./gmail-read');
const { readHistory } = require('./runtime-history');
const { headersAndBody, one } = require('./raw-message');
const { readVerifiedInitial, inspectVerified } = require('./verified-gmail');
const { buildQaMime, verifyQaSent } = require('./qa-mime');
const { same } = require('./qa-send');
const { readKnowledgeFiles } = require('../../src/lib/supportVoiceKnowledge');
const { createXaiDraftGenerator } = require('../../src/lib/supportEmailAdapters');
const { address, buildEmailPrompt, redactQuestion, validateDraft } = require('../../src/lib/supportEmailPolicy');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Error('SUPPORT_EMAIL_RUNTIME_HELD'); };

// Only an exclusion filter, NEVER an authenticated eligible decision.
function excludeEnvelope(envelope, id) {
  const raw = decodeEnvelope(envelope, id);
  let parsed;
  try {
    if (envelope.labelIds.some(l => ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(l))) return 'excluded';
    parsed = headersAndBody(raw);
    const sender = address(one(parsed.headers, 'from', true));
    if (!sender) fail();
    if (sender !== OWNER) return 'not_owner';
    const to = address(one(parsed.headers, 'to', true)), delivered = address(one(parsed.headers, 'delivered-to', true));
    if (!to || !delivered) fail();
    if (to !== 'support@alphasourceai.com' || delivered !== MAILBOX) return 'excluded';
    if (one(parsed.headers, 'list-id', true).toLowerCase() !== '<support.alphasourceai.com>') fail();
    return null;
  } catch (_) { fail(); }
  finally { raw.fill(0); if (parsed) parsed.body.fill(0); }
}
async function runRuntime() {
  if (arguments.length) fail();
  const deadline = Date.now() + 150000, initial = loadRuntimeConfig();
  if (!initial) return Object.freeze({ status: 'off' });
  const store = createRuntimeStore(initial.keys.supabaseServiceRoleKey, deadline, initial.mode);
  const counts = { skipped: 0, duplicate: 0, draft: 0, review: 0, sent: 0 };
  let nonce;
  function local(reserve = 0) { if (Date.now() + reserve >= deadline || loadRuntimeConfig()?.binding !== initial.binding) fail(); }
  async function check(reserve = 0) { local(reserve); if (await store.call('check', nonce) !== true) fail(); local(reserve); }
  local();
  const lease = await store.call('acquire', null, { baseline: initial.readGrant.baselineHistoryId });
  if (lease === null) return Object.freeze({ status: 'off_or_busy' });
  if (!UUID.test(lease?.nonce || '') || !Number.isSafeInteger(lease.now_ms) || !Number.isSafeInteger(lease.lease_ms) ||
      Math.abs(Date.now() - lease.now_ms) > 5000 || lease.lease_ms - lease.now_ms < 175000) fail();
  nonce = lease.nonce;
  await check(120000);
  const auth = await refreshSendReadonly(initial.readClient, initial.readGrant.refreshToken);
  if (auth.mailbox !== MAILBOX || auth.expiresAt < deadline + 60000) fail();
  await check(10000);
  if (lease.cursor === null) {
    const profile = await boundedJson('profile', auth.accessToken, Math.min(deadline, Date.now() + 10000));
    if (profile.emailAddress !== MAILBOX || !decimal(profile.historyId)) fail();
    await check(10000);
    if (await store.call('seed', nonce, { baseline: initial.readGrant.baselineHistoryId, current: profile.historyId }) !== true) fail();
    return Object.freeze({ status: 'initialized_no_backfill' });
  }
  if (!decimal(lease.cursor) || !Number.isSafeInteger(lease.cutover_ms) || lease.cutover_ms <= 0 || lease.cutover_ms > Date.now() + 5000) fail();
  const knowledge = readKnowledgeFiles();
  const prompts = { public: buildEmailPrompt('public', knowledge), client: buildEmailPrompt('client', knowledge) };
  const page = await readHistory(auth.accessToken, lease.cursor, deadline);
  const generate = createXaiDraftGenerator({ apiKey: initial.keys.xaiApiKey, fetchImpl: async (url, options) => {
    await check(45000);
    if (url !== 'https://api.x.ai/v1/chat/completions') fail();
    return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now() - 10000))]) });
  } });
  let sendAuth;
  for (const id of page.ids) {
    await check(10000);
    const gmailKey = hash(MAILBOX + ':' + id);
    const seen = await store.call('seen', nonce, { gmail: gmailKey, gmail_id: id });
    async function processed(reason) { await check(10000); if (await store.call('processed', nonce, { gmail: gmailKey, reason }) !== true) fail(); }
    if (![null, 'processed', 'accepted_copy'].includes(seen)) fail();
    if (seen === 'processed') { counts.duplicate++; continue; }
    const envelope = await boundedJson('messages/' + id + '?format=raw', auth.accessToken, Math.min(deadline - 10000, Date.now() + 10000));
    if (seen === 'accepted_copy') {
      // Even a durable sent id must match the fetched history message/labels.
      const checked = decodeEnvelope(envelope, id); checked.fill(0);
      await processed('accepted_copy'); counts.duplicate++; continue;
    }
    const excluded = excludeEnvelope(envelope, id);
    if (excluded) { await processed(excluded); counts.skipped++; continue; }
    await check(115000); // A partial page holds the cursor; prior claims remain durable.
    const decision = await readVerifiedInitial({ accessToken: auth.accessToken, id, cutoverMs: lease.cutover_ms, baselineHistoryId: initial.readGrant.baselineHistoryId });
    if (!decision.eligible) {
      if (decision.reason === 'unverified_group_delivery') fail();
      await processed('policy'); counts.skipped++; continue;
    }
    const record = inspectVerified(decision);
    if (!record.senderVerified || record.sender !== OWNER) fail();
    await check(100000);
    const claim = await store.call('claim', nonce, { thread: record.threadKey, message: record.messageKey, gmail: record.gmailKey });
    if (claim === null) { await processed('duplicate'); counts.duplicate++; continue; }
    if (typeof claim !== 'string' || !UUID.test(claim)) fail();
    let generated, lookupFailed = false, client = false;
    try { client = await recognizeRuntimeClient(initial.keys.supabaseServiceRoleKey, record.sender, deadline) === true; } catch (_) { lookupFailed = true; }
    const audience = client ? 'client' : 'public', prompt = prompts[audience];
    // Any ambiguous storage failure halts. Generation/recheck rejection can
    // finish a bodyless review exactly once, never regenerate the same claim.
    try {
      await check(75000);
      generated = await generate({ system: prompt.prompt, question: redactQuestion(record.text) });
      const validated = validateDraft(generated);
      await check(30000);
      const fresh = await readVerifiedInitial({ accessToken: auth.accessToken, id, cutoverMs: lease.cutover_ms, baselineHistoryId: initial.readGrant.baselineHistoryId });
      if (!fresh.eligible && fresh.reason === 'unverified_group_delivery') throw Error('VERIFY_TRANSPORT');
      if (fresh.eligible && inspectVerified(fresh).senderVerified !== true) throw Error('VERIFY_TRANSPORT');
      if (!fresh.eligible || !same(record, inspectVerified(fresh))) throw Error('RECHECK');
      generated = { body: validated.body, modelReview: generated.human_review || lookupFailed };
    } catch (error) {
      if (error.message === 'VERIFY_TRANSPORT') fail();
      await check(10000);
      if (await store.call('review', nonce, { id: claim }) !== true) fail();
      counts.review++; continue;
    }
    await check(10000);
    if (await store.call('draft', nonce, { id: claim, body: generated.body, audience,
      model_review: generated.modelReview, knowledge_version: prompt.version, knowledge_hash: prompt.hash }) !== true) fail();
    counts.draft++;
    if (initial.mode !== 'qa-owner-auto' || generated.modelReview) continue;
    await check(50000);
    if (!sendAuth) sendAuth = await createSendOAuth({ client: initial.sendClient }).refresh(initial.sendGrant.refreshToken);
    if (sendAuth.mailbox !== MAILBOX || sendAuth.expiresAt < deadline + 60000) fail();
    const wire = buildQaMime(record, generated.body), wireHash = hash(wire.raw), bodyHash = hash(generated.body);
    const binding = { id: claim, body_hash: bodyHash, knowledge_hash: knowledge.hash, fingerprint: record.fingerprint, wire: wireHash, thread_id: record.threadId };
    let reserved = false, started = false, postInvoked = false, finishing = false;
    async function finalProof() {
      await check(30000);
      const proof = await readVerifiedInitial({ accessToken: auth.accessToken, id, cutoverMs: lease.cutover_ms, baselineHistoryId: initial.readGrant.baselineHistoryId });
      if (!proof.eligible || !same(record, inspectVerified(proof))) fail();
      const current = readKnowledgeFiles();
      if (current.hash !== knowledge.hash || current.version !== knowledge.version) fail();
    }
    try {
      await finalProof(); await check(40000);
      if (await store.call('reserve', nonce, binding) !== true) fail();
      reserved = true;
      await finalProof(); await check(30000);
      if (await store.call('start', nonce, binding) !== true) fail();
      started = true;
      const sendOptions = { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + sendAuth.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: wire.raw.toString('base64url'), threadId: wire.threadId }) };
      await check(20000); // Includes off switch and DB fence immediately pre-POST.
      postInvoked = true;
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', sendOptions);
      if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
      const result = await readJson(response);
      if (!hex(result.id) || result.threadId !== wire.threadId) fail();
      local(10000);
      const readDeadline = Math.min(deadline - 10000, Date.now() + 10000);
      const profile = await boundedJson('profile', auth.accessToken, readDeadline);
      if (profile.emailAddress !== MAILBOX) fail();
      const sent = await boundedJson('messages/' + result.id + '?format=raw', auth.accessToken, readDeadline);
      const thread = await boundedJson('threads/' + wire.threadId + '?format=minimal', auth.accessToken, readDeadline);
      verifyQaSent(sent, result, wire, thread);
      await check(10000); finishing = true;
      if (await store.call('finish', nonce, { id: claim, state: 'accepted', gmail_id: result.id, thread_id: result.threadId }) !== true) fail();
      counts.sent++;
    } catch (_) {
      // Lost start response: cancel cannot change committed submitting. Lost
      // POST/finish: terminal unknown/submitting, never an automatic replay.
      if (reserved && !finishing && (!started || postInvoked)) {
        try { await check(10000); await store.call(postInvoked ? 'finish' : 'cancel', nonce, { id: claim, ...(postInvoked ? { state: 'unknown' } : {}) }); } catch (_) { /* Permanent hold. */ }
      }
      fail();
    } finally { wire.raw.fill(0); }
  }
  await check(10000);
  if (await store.call('complete', nonce, { next: page.next, counts }) !== true) fail();
  return Object.freeze({ status: 'complete', counts: Object.freeze(counts), completed_at: new Date().toISOString() });
}
module.exports = { runRuntime, excludeEnvelope };
