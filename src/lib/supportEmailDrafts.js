const { classifyInitialEmail, buildEmailPrompt, redactQuestion, validateDraft } = require('./supportEmailPolicy');

function config(env) {
  const cutoverMs = Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT || '');
  // No auto-send implementation exists in this phase, including if someone changes the mode.
  const baselineHistoryId = env.SUPPORT_EMAIL_BASELINE_HISTORY_ID;
  const enabled = env.SUPPORT_EMAIL_ENABLED === 'true' && env.SUPPORT_EMAIL_MODE === 'qa-draft' && env.SUPPORT_EMAIL_ENVIRONMENT === 'qa' &&
    env.SUPABASE_URL === 'https://yjjxzxoghlpguquknyso.supabase.co' && Number.isSafeInteger(cutoverMs) &&
    /^\d{1,30}$/.test(baselineHistoryId || '') &&
    env.SUPPORT_EMAIL_MAILBOX === 'alphy@alphasourceai.com';
  return { enabled, cutoverMs, baselineHistoryId, mailbox: env.SUPPORT_EMAIL_MAILBOX };
}

function createSupportEmailDraftWorker({ mailbox, store, recognizeClient, generate, verifyDelivery = async () => false, verifySender = async () => false, loadKnowledge = buildEmailPrompt, env = process.env }) {
  const settings = config(env);
  async function processMessage(id) {
    if (!settings.enabled) return { status: 'off' };
    const message = await mailbox.getMessage(id);
    const thread = await mailbox.getThread(message.threadId);
    const deliveryVerified = await verifyDelivery(message);
    const decision = classifyInitialEmail({ message, thread, ...settings, deliveryVerified });
    if (!decision.eligible) return { status: 'skipped', reason: decision.reason };
    const claim = await store.claim(decision.threadKey, decision.messageKey, decision.gmailKey);
    if (typeof claim !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(claim)) return { status: 'duplicate' };
    try {
      let recognized = false;
      try { recognized = await verifySender(message, decision.sender) === true && await recognizeClient(decision.sender) === true; } catch (_) { /* public static guidance only */ }
      const audience = recognized ? 'client' : 'public';
      const knowledge = loadKnowledge(audience);
      const result = validateDraft(await generate({ system: knowledge.prompt, question: redactQuestion(decision.text) }));
      const freshThread = await mailbox.getThread(message.threadId);
      const freshMessage = freshThread?.messages?.find(m => m.id === id);
      const fresh = classifyInitialEmail({ message: freshMessage, thread: freshThread, ...settings, deliveryVerified: await verifyDelivery(freshMessage) });
      if (!fresh.eligible || fresh.fingerprint !== decision.fingerprint) {
        await store.finish(claim, { status: 'review', reason: 'thread_changed' });
        return { status: 'review', reason: 'thread_changed' };
      }
      await store.finish(claim, { status: 'draft', audience, knowledgeVersion: knowledge.version, knowledgeHash: knowledge.hash, body: result.body, humanReview: result.humanReview || !recognized });
      return { status: 'draft', audience, humanReview: result.humanReview || !recognized };
    } catch (_) {
      // Preserve the durable claim on failure. No retry can generate a second reply.
      await store.finish(claim, { status: 'review', reason: 'generation_or_storage_failed' });
      return { status: 'review', reason: 'generation_or_storage_failed' };
    }
  }
  async function run() {
    if (!settings.enabled) return { status: 'off', counts: {} };
    const ids = await mailbox.listSupportMessages(settings.cutoverMs);
    if (!Array.isArray(ids) || ids.length > 25) throw new Error('SUPPORT_EMAIL_BATCH_SIZE');
    const counts = {};
    for (const id of ids) {
      const result = await processMessage(id);
      counts[result.status] = (counts[result.status] || 0) + 1;
    }
    return { status: 'draft_only', counts };
  }
  return { run, processMessage };
}

module.exports = { config, createSupportEmailDraftWorker };
