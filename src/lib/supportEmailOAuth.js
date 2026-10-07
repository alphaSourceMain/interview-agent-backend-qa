// Local connection preparation only. No listener, credential storage, polling or sending.
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { READONLY_SCOPE } = require('./supportEmailAdapters');
const MAILBOX = 'alphy@alphasourceai.com';
const REDIRECT = 'http://127.0.0.1:43871/oauth/callback';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const fail = code => { throw new Error(code); };
const safeValue = (value, max = 8192) => typeof value === 'string' && value.length >= 1 && value.length <= max && /^[\x21-\x7e]+$/.test(value);

function settings(env) {
  // Connecting is separate from enabling drafts: the baseline is captured AFTER consent.
  if (env.SUPPORT_EMAIL_OAUTH_ENABLED !== 'true' || env.SUPPORT_EMAIL_MODE !== 'qa-draft' || env.SUPPORT_EMAIL_ENVIRONMENT !== 'qa' ||
      env.SUPABASE_URL !== 'https://yjjxzxoghlpguquknyso.supabase.co' || env.SUPPORT_EMAIL_MAILBOX !== MAILBOX) fail('SUPPORT_EMAIL_OAUTH_OFF');
  const clientId = env.SUPPORT_EMAIL_GOOGLE_CLIENT_ID;
  const clientSecret = env.SUPPORT_EMAIL_GOOGLE_CLIENT_SECRET;
  if (typeof clientId !== 'string' || !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256 ||
      !safeValue(clientSecret, 256) || clientSecret.length < 20 || env.SUPPORT_EMAIL_GOOGLE_REDIRECT_URI !== REDIRECT) fail('SUPPORT_EMAIL_OAUTH_CONFIG');
  return { clientId, clientSecret };
}

async function boundedText(response) {
  let body;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 32000) { await reader.cancel(); fail('SUPPORT_EMAIL_OAUTH_PROVIDER'); }
        chunks.push(Buffer.from(part.value));
      }
      body = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else { body = await response.text(); } // Synthetic adapters; native fetch uses bounded streams.
  if (Buffer.byteLength(body) > 32000) fail('SUPPORT_EMAIL_OAUTH_PROVIDER');
  return body;
}

async function boundedJSON(response) {
  if (!response?.ok) fail('SUPPORT_EMAIL_OAUTH_PROVIDER');
  const body = await boundedText(response);
  let value;
  try { value = JSON.parse(body); } catch (_) { fail('SUPPORT_EMAIL_OAUTH_PROVIDER'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SUPPORT_EMAIL_OAUTH_PROVIDER');
  return value;
}

function createSupportEmailOAuth({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const cfg = settings(env);
  let pending = null;
  async function request(url, options = {}) {
    try {
      return await boundedJSON(await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }));
    } catch (_) { fail('SUPPORT_EMAIL_OAUTH_PROVIDER'); } // Never propagate tokens, bodies or raw provider errors.
  }
  async function verify(tokens, requireRefresh, issuedAt) {
    if (!safeValue(tokens.access_token) || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || !Number.isInteger(tokens.expires_in) ||
        tokens.expires_in < 1 || tokens.expires_in > 7200 || (requireRefresh && !safeValue(tokens.refresh_token)) ||
        (tokens.refresh_token !== undefined && !safeValue(tokens.refresh_token))) fail('SUPPORT_EMAIL_OAUTH_INVALID_TOKEN');
    if (tokens.scope !== undefined && tokens.scope !== READONLY_SCOPE) fail('SUPPORT_EMAIL_OAUTH_SCOPE');
    const info = await request('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tokens.access_token));
    // Tokeninfo is a fixed Google endpoint. Do not log URLs; Google exposes this token introspection in its query string.
    if (info.aud !== cfg.clientId || info.azp !== cfg.clientId ||
        (info.audience !== undefined && info.audience !== cfg.clientId) || (info.issued_to !== undefined && info.issued_to !== cfg.clientId)) fail('SUPPORT_EMAIL_OAUTH_WRONG_CLIENT');
    const scopes = typeof info.scope === 'string' ? info.scope.split(/\s+/).filter(Boolean) : [];
    if (scopes.length !== 1 || scopes[0] !== READONLY_SCOPE) fail('SUPPORT_EMAIL_OAUTH_SCOPE');
    if (!/^\d{1,5}$/.test(String(info.expires_in)) || Number(info.expires_in) < 1 || Number(info.expires_in) > 7200) fail('SUPPORT_EMAIL_OAUTH_INVALID_TOKEN');
    if (typeof info.exp !== 'string' || !/^\d{1,12}$/.test(info.exp) || Number(info.exp) * 1000 <= now() ||
        Number(info.exp) * 1000 > now() + 7200000) fail('SUPPORT_EMAIL_OAUTH_INVALID_TOKEN');
    const expiresAt = Math.min(issuedAt + tokens.expires_in * 1000, now() + Number(info.expires_in) * 1000, Number(info.exp) * 1000);
    const profile = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    if (typeof profile.emailAddress !== 'string' || profile.emailAddress.toLowerCase() !== MAILBOX || typeof profile.historyId !== 'string' || !/^\d{1,30}$/.test(profile.historyId)) fail('SUPPORT_EMAIL_OAUTH_WRONG_MAILBOX');
    if (expiresAt <= now()) fail('SUPPORT_EMAIL_OAUTH_INVALID_TOKEN');
    return { accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt, mailbox: MAILBOX, ...(requireRefresh ? { baselineHistoryId: profile.historyId } : { currentHistoryId: profile.historyId }), scope: READONLY_SCOPE };
  }
  async function revokeRejected(tokens, suppliedRefreshToken) {
    const token = safeValue(tokens.refresh_token) ? tokens.refresh_token : safeValue(suppliedRefreshToken) ? suppliedRefreshToken : safeValue(tokens.access_token) ? tokens.access_token : null;
    if (!token) fail('SUPPORT_EMAIL_OAUTH_REVOKE_UNCONFIRMED');
    try {
      const response = await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
        redirect: 'error', signal: AbortSignal.timeout(10000) });
      await boundedText(response); // Google success can be empty; discard every response body.
      if (response.status !== 200) fail('SUPPORT_EMAIL_OAUTH_REVOKE_UNCONFIRMED');
    } catch (_) { fail('SUPPORT_EMAIL_OAUTH_REVOKE_UNCONFIRMED'); }
  }
  async function grant(fields, requireRefresh) {
    const issuedAt = now();
    const tokens = await request(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...fields }).toString() });
    try { return await verify(tokens, requireRefresh, issuedAt); }
    catch (error) {
      if (['SUPPORT_EMAIL_OAUTH_INVALID_TOKEN', 'SUPPORT_EMAIL_OAUTH_SCOPE', 'SUPPORT_EMAIL_OAUTH_WRONG_CLIENT', 'SUPPORT_EMAIL_OAUTH_WRONG_MAILBOX'].includes(error.message)) {
        await revokeRejected(tokens, fields.refresh_token);
      }
      throw error; // Transport failures never revoke an otherwise valid existing grant.
    }
  }
  return {
    begin() {
      const time = now();
      if (pending && time < pending.expiresAt) fail('SUPPORT_EMAIL_OAUTH_PENDING');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      pending = { state, verifier, expiresAt: time + 300000 };
      const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: REDIRECT, response_type: 'code',
        scope: READONLY_SCOPE, access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'false', login_hint: MAILBOX,
        state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
    },
    async complete({ state, code, error } = {}) {
      const attempt = pending;
      pending = null; // Exactly one callback attempt, including failed or concurrent attempts.
      if (!attempt || now() >= attempt.expiresAt || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) fail('SUPPORT_EMAIL_OAUTH_STATE');
      if (error !== undefined || !safeValue(code, 4096)) fail('SUPPORT_EMAIL_OAUTH_DENIED');
      return grant({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: attempt.verifier }, true);
    },
    async refresh(refreshToken) {
      if (!safeValue(refreshToken)) fail('SUPPORT_EMAIL_OAUTH_INVALID_REFRESH');
      return grant({ grant_type: 'refresh_token', refresh_token: refreshToken }, false);
    },
  };
}

module.exports = { createSupportEmailOAuth, REDIRECT };
