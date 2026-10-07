// Read-only provider adapters. There is intentionally no email delivery adapter.
const { hasAnyActiveClientMembership } = require('./supportVoiceMembership');
const { GROUP } = require('./supportEmailPolicy');
const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

async function jsonResponse(response, code) {
  if (!response.ok) throw new Error(code);
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256000) { await reader.cancel(); throw new Error('SUPPORT_EMAIL_PROVIDER_SIZE'); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else { text = await response.text(); } // Synthetic test adapters; native fetch uses the bounded stream.
  if (Buffer.byteLength(text) > 256000) throw new Error('SUPPORT_EMAIL_PROVIDER_SIZE');
  try { return JSON.parse(text); } catch (_) { throw new Error(code); }
}

async function createReadonlyGmail({ accessToken, expectedMailbox, fetchImpl = fetch }) {
  if (!accessToken || expectedMailbox !== 'alphy@alphasourceai.com') throw new Error('SUPPORT_EMAIL_GMAIL_CONFIG');
  const info = await jsonResponse(await fetchImpl('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(accessToken), { signal: AbortSignal.timeout(10000), redirect: 'error' }), 'SUPPORT_EMAIL_TOKEN_INFO');
  const scopes = String(info.scope || '').split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== READONLY_SCOPE) throw new Error('SUPPORT_EMAIL_READONLY_SCOPE_REQUIRED');
  async function get(path) {
    return jsonResponse(await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }), 'SUPPORT_EMAIL_GMAIL_READ');
  }
  const profile = await get('profile');
  if (profile.emailAddress?.toLowerCase() !== expectedMailbox) throw new Error('SUPPORT_EMAIL_WRONG_MAILBOX');
  return {
    baselineHistoryId: profile.historyId,
    getMessage: id => get('messages/' + encodeURIComponent(id) + '?format=full'),
    getThread: id => get('threads/' + encodeURIComponent(id) + '?format=full'),
    // One bounded page per run. Persistent processed claims make repeated scans harmless.
    async listSupportMessages(cutoverMs) {
      const query = `to:${GROUP} after:${Math.floor(cutoverMs / 1000)} -in:spam -in:trash`;
      const result = await get('messages?maxResults=25&q=' + encodeURIComponent(query));
      if (result.nextPageToken) throw new Error('SUPPORT_EMAIL_BACKLOG_REVIEW_REQUIRED');
      return (result.messages || []).map(m => m.id);
    },
  };
}

function createSupabaseDraftStore(db) {
  async function rpc(name, args) {
    const result = await db.rpc(name, args);
    if (result.error) throw new Error('SUPPORT_EMAIL_STORE_UNAVAILABLE');
    return result.data;
  }
  return {
    claim: (thread, message, gmail) => rpc('claim_support_email_draft', { p_thread_key: thread, p_message_key: message, p_gmail_key: gmail }),
    async finish(id, draft) {
      const result = await rpc('finish_support_email_draft', { p_id: id, p_draft: draft });
      if (result !== true) throw new Error('SUPPORT_EMAIL_STORE_WRITE_FAILED');
    },
    async recognizeClient(email) {
      const userId = await rpc('support_email_confirmed_user', { p_email: email });
      return typeof userId === 'string' && await hasAnyActiveClientMembership({ serviceDb: db, userId });
    },
  };
}

function createXaiDraftGenerator({ apiKey, fetchImpl = fetch }) {
  if (typeof apiKey !== 'string' || apiKey.length < 20) throw new Error('SUPPORT_EMAIL_XAI_CONFIG');
  return async ({ system, question }) => {
    const result = await jsonResponse(await fetchImpl('https://api.x.ai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ model: 'grok-4.7', messages: [{ role: 'system', content: system }, { role: 'user', content: question }], max_tokens: 1200,
        response_format: { type: 'json_schema', json_schema: { name: 'support_email_draft', strict: true, schema: { type: 'object', additionalProperties: false, required: ['answer', 'human_review'], properties: { answer: { type: 'string' }, human_review: { type: 'boolean' } } } } },
      }),
    }), 'SUPPORT_EMAIL_MODEL_UNAVAILABLE');
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls || typeof choice.message?.content !== 'string') throw new Error('SUPPORT_EMAIL_MODEL_INVALID');
    try { return JSON.parse(choice.message.content); } catch (_) { throw new Error('SUPPORT_EMAIL_MODEL_INVALID'); }
  };
}

module.exports = { READONLY_SCOPE, createReadonlyGmail, createSupabaseDraftStore, createXaiDraftGenerator };
