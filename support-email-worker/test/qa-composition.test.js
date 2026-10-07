'use strict';
// Module replacement exists only in this test harness. It does not mint a real
// verifier WeakMap decision and is not available through the production command.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OWNER, MAILBOX } = require('../src/qa-config');
const body = 'General product guidance only.';
const proof = { eligible: true, senderVerified: true, sender: OWNER, text: 'What is alphaScreen?',
  fingerprint: 'a'.repeat(64), threadKey: 'b'.repeat(64), messageKey: 'c'.repeat(64), gmailKey: 'd'.repeat(64) };
const id = '12345678-1234-4234-8234-123456789abc';
async function harness(change = {}) {
  const events = [], writes = [];
  let changed = false, reads = 0;
  const cfg = { binding: 'fixed', env: { SUPABASE_SERVICE_ROLE_KEY: 'test-only', XAI_API_KEY: 'test-only', cutoverMs: Date.now() - 1000 },
    client: {}, grant: { refreshToken: 'test-only', baselineHistoryId: '100' } };
  const modules = {
    '../src/qa-config': { OWNER, MAILBOX, loadQaConfig() { events.push('config'); return changed ? { ...cfg, binding: 'off' } : cfg; } },
    '../src/qa-store': { createQaStore: () => ({
      async preflight() { events.push('preflight'); if (change.preflight) throw Error('SECRET provider error'); },
      async claim() { events.push('claim'); if (change.claimError) throw Error('STORE'); return change.duplicate ? null : id; },
      async recognizeClient() { events.push('membership'); if (change.lookupError) throw Error('PRIVATE'); return !!change.client; },
      async finish(_id, draft) { events.push('finish'); writes.push(draft); if (change.finishError) throw Error('AMBIGUOUS'); },
    }) },
    '../src/verified-gmail': { async readVerifiedInitial() { events.push('verify'); reads++; return { eligible: !change.ineligible && !(reads > 1 && change.reply) }; },
      inspectVerified() { return { ...proof, ...(change.ownerMismatch ? { sender: 'different@example.invalid' } : {}), ...(reads > 1 && change.freshMismatch ? { fingerprint: 'changed' } : {}) }; } },
    '../src/qa-list': { async listOwnerMessages() { events.push('list'); return { messages: [{ id: 'abc123' }] }; } },
    '../../src/lib/supportEmailOAuth': { REDIRECT: 'fixed', createSupportEmailOAuth: () => ({ async refresh() {
      events.push('refresh'); return { mailbox: MAILBOX, expiresAt: Date.now() + 3600000, ...(change.rotation ? { refreshToken: 'rotated' } : {}) };
    } }) },
    '../../src/lib/supportVoiceKnowledge': { readKnowledgeFiles() { events.push('knowledge'); if (change.knowledgeError) throw Error('HASH'); return {}; } },
    '../../src/lib/supportEmailAdapters': { createXaiDraftGenerator: () => async request => {
      events.push('model'); assert.deepEqual(Object.keys(request).sort(), ['question', 'system']);
      if (change.offDuringModel) changed = true;
      if (change.modelError) throw Error('MODEL');
      return { answer: change.invalidOutput ? 'password: secret' : body, human_review: false };
    } },
    '../../src/lib/supportEmailPolicy': { ...require('../../src/lib/supportEmailPolicy'), buildEmailPrompt(audience) { return { prompt: 'static-' + audience, version: '2026-10-07.1', hash: 'e'.repeat(64) }; } },
  };
  const saved = new Map(), target = require.resolve('../src/qa-draft');
  saved.set(target, require.cache[target]); delete require.cache[target];
  try {
    for (const [name, exports] of Object.entries(modules)) {
      const key = require.resolve(name); saved.set(key, require.cache[key]); require.cache[key] = { id: key, filename: key, loaded: true, exports };
    }
    let result, error;
    try { result = await require(target).runQaDraft(); } catch (e) { error = e.message; }
    return { result, error, events, writes };
  } finally {
    for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
  }
}
test('closed composition claims before model, re-verifies before human-reviewed save', async () => {
  const r = await harness(); assert.equal(r.error, undefined); assert.equal(r.result.counts.draft, 1);
  assert.ok(r.events.indexOf('knowledge') < r.events.indexOf('claim'));
  assert.ok(r.events.indexOf('preflight') < r.events.indexOf('refresh'));
  assert.ok(r.events.indexOf('claim') < r.events.indexOf('model'));
  assert.ok(r.events.lastIndexOf('verify') < r.events.indexOf('finish'));
  assert.equal(r.writes[0].humanReview, true); assert.equal(r.writes[0].audience, 'public');
  assert.equal(r.result.previews[0].preview.sendable, false);
});
test('verified client selects only static client prompt', async () => { const r = await harness({ client: true }); assert.equal(r.writes[0].audience, 'client'); });
test('lookup failure selects static public prompt', async () => { const r = await harness({ lookupError: true }); assert.equal(r.writes[0].audience, 'public'); });
for (const change of [{ duplicate: true }, { ineligible: true }, { ownerMismatch: true }, { knowledgeError: true }, { preflight: true }, { rotation: true }, { claimError: true }]) {
  test('no model or body for ' + Object.keys(change)[0], async () => { const r = await harness(change); assert.ok(!r.events.includes('model')); assert.equal(r.writes.length, 0); });
}
for (const change of [{ reply: true }, { freshMismatch: true }, { invalidOutput: true }, { modelError: true }]) {
  test('permanent bodyless review for ' + Object.keys(change)[0], async () => {
    const r = await harness(change); assert.equal(r.result.counts.review, 1); assert.equal(r.writes.length, 1);
    assert.equal(r.writes[0].status, 'review'); assert.equal(r.writes[0].body, undefined); assert.equal(r.result.previews.length, 0);
  });
}
test('off change during model preserves bodyless claim without finish', async () => {
  const r = await harness({ offDuringModel: true }); assert.equal(r.error, 'SUPPORT_EMAIL_QA_HALTED'); assert.equal(r.writes.length, 0);
});
test('ambiguous finish halts without second write or retry', async () => {
  const r = await harness({ finishError: true }); assert.equal(r.error, 'SUPPORT_EMAIL_QA_HALTED'); assert.equal(r.writes.length, 1);
});
