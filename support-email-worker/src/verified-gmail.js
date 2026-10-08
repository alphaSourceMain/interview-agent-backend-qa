'use strict';
// No write endpoints, model, database, polling, fixture hooks or sending.
const crypto = require('node:crypto');
const { authenticateRaw } = require('./authenticate-raw');
const { productionResolver, within } = require('./keys');
const { hex, decimal, boundedJson, decodeEnvelope } = require('./gmail-read');
const { one } = require('./raw-message');
const { classifyInitialEmail } = require('../../src/lib/supportEmailPolicy');
const decisions = new WeakMap();
const fail = () => { throw new Error('SUPPORT_EMAIL_GMAIL_REJECTED'); };

async function readVerifiedInitial({ accessToken, id, cutoverMs, baselineHistoryId }) {
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(accessToken) || !hex(id) || !decimal(baselineHistoryId) || !Number.isSafeInteger(cutoverMs) || cutoverMs <= 0) fail();
  const deadline = Date.now() + 15000;
  const keys = productionResolver(deadline);
  let raw;
  try {
    return await within((async () => {
      const profile = await boundedJson('profile', accessToken, deadline);
      if (profile.emailAddress !== 'alphy@alphasourceai.com' || !decimal(profile.historyId)) fail();
      const envelope = await boundedJson('messages/' + id + '?format=raw', accessToken, deadline);
      raw = decodeEnvelope(envelope, id);
      const verified = await authenticateRaw({ raw, envelope, keys });
      const thread = await boundedJson('threads/' + envelope.threadId + '?format=minimal', accessToken, deadline);
      // Minimize thread fingerprint to exact immutable id list, not full MIME bodies.
      if (thread.id !== envelope.threadId || !Array.isArray(thread.messages) || thread.messages.length !== 1 || thread.messages[0].id !== id ||
        thread.messages[0].threadId !== envelope.threadId) return Object.freeze({ eligible: false, reason: 'not_initial_thread' });
      const canonicalThread = Object.freeze({ id: thread.id, messages: Object.freeze([Object.freeze({ id, threadId: envelope.threadId })]) });
      const policy = classifyInitialEmail({ message: verified.message, thread: canonicalThread, mailbox: 'alphy@alphasourceai.com', cutoverMs, baselineHistoryId, deliveryVerified: true });
      if (!policy.eligible) return Object.freeze({ eligible: false, reason: policy.reason });
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ message: verified.message, thread: canonicalThread })).digest('hex');
      const decision = Object.freeze({ eligible: true });
      decisions.set(decision, Object.freeze({ ...policy, senderVerified: verified.senderVerified, fingerprint,
        gmailId: envelope.id, threadId: envelope.threadId, rfcMessageId: one(verified.message.payload.headers, 'message-id', true) }));
      return decision;
    })(), deadline - Date.now(), () => keys.close());
  } catch (_) { return Object.freeze({ eligible: false, reason: 'unverified_group_delivery' }); }
  finally { keys.close(); if (raw) raw.fill(0); }
}

function inspectVerified(decision) {
  const record = decisions.get(decision);
  if (!record) fail();
  return record;
}
module.exports = { readVerifiedInitial, inspectVerified };
