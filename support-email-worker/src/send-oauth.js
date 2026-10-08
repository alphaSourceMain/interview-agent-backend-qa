'use strict';
// Separate sender PROJECT, not merely another client: Google revokes project-wide.
// Existing readonly helpers and committed grants are not generalized or revoked.
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { readJson } = require('./qa-store');
const PROJECT = 'alphascreen-alphy-qa-sending';
const PROJECT_NUMBER = '581820238541';
const CLIENT = '581820238541-evup8b38vdio8f53rultitdifc4dmmdl.apps.googleusercontent.com';
const REDIRECT = 'http://127.0.0.1:43873/oauth/callback';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email', 'openid']);
const SCOPE = SCOPES.join(' ');
const MAILBOX = 'alphy@alphasourceai.com';
const fail = code => { throw new Error('SUPPORT_EMAIL_SEND_' + code); };
const printable = value => typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
function exactScopes(value) {
  const items = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
  // Google may also return the short email alias alongside its full URI.
  // The alias never replaces the full URI; no other extra permission is allowed.
  return (items.length === 3 || items.length === 4) && new Set(items).size === items.length &&
    SCOPES.every(scope => items.includes(scope)) && items.every(scope => SCOPES.includes(scope) || scope === 'email');
}
function createSendOAuth({ client, fetchImpl = fetch, now = Date.now }) {
  if (client?.clientId !== CLIENT || !printable(client.clientSecret) || client.clientSecret.length < 20 || client.clientSecret.length > 256) fail('CONFIG');
  let pending;
  const uncommitted = new Set();
  async function request(url, options = {}) {
    if (![ 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v2/userinfo' ].includes(url) &&
      !/^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?access_token=[A-Za-z0-9._~%-]{1,24576}$/.test(url)) fail('ENDPOINT');
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('PROVIDER');
      const value = await readJson(response);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROVIDER');
      return value;
    } catch (_) { fail('PROVIDER'); }
  }
  async function revokeUncommitted(token) {
    if (!printable(token) || !uncommitted.has(token)) fail('REVOKE_UNCONFIRMED');
    try {
      const response = await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
      if (response.status !== 200) fail('REVOKE_UNCONFIRMED');
      // Discard the fixed endpoint's bounded response without interpreting it.
      const reader = response.body?.getReader();
      if (!reader) fail('REVOKE_UNCONFIRMED');
      let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 32768) { await reader.cancel(); fail('REVOKE_UNCONFIRMED'); } } }
      finally { reader.releaseLock(); }
      uncommitted.delete(token);
    } catch (_) { fail('REVOKE_UNCONFIRMED'); }
  }
  async function verify(tokens, requireRefresh, issuedAt) {
    if (!printable(tokens.access_token) || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(tokens.expires_in) ||
      tokens.expires_in < 1 || tokens.expires_in > 7200 || (requireRefresh && !printable(tokens.refresh_token)) ||
      (tokens.refresh_token !== undefined && !printable(tokens.refresh_token)) || (tokens.scope !== undefined && !exactScopes(tokens.scope))) fail('TOKEN');
    const info = await request('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(tokens.access_token));
    if (info.aud !== CLIENT || info.azp !== CLIENT || (info.audience !== undefined && info.audience !== CLIENT) ||
      (info.issued_to !== undefined && info.issued_to !== CLIENT) || !exactScopes(info.scope) || !/^\d{1,5}$/.test(String(info.expires_in)) ||
      Number(info.expires_in) < 1 || Number(info.expires_in) > 7200 || !/^\d{1,12}$/.test(String(info.exp)) ||
      Number(info.exp) * 1000 <= now() || Number(info.exp) * 1000 > now() + 7200000) fail('TOKEN');
    const identity = await request('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } });
    if (identity.verified_email !== true || typeof identity.email !== 'string' || identity.email.toLowerCase() !== MAILBOX) fail('IDENTITY');
    const expiresAt = Math.min(issuedAt + tokens.expires_in * 1000, now() + Number(info.expires_in) * 1000, Number(info.exp) * 1000);
    if (expiresAt <= now()) fail('TOKEN');
    return Object.freeze({ accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}), expiresAt, mailbox: MAILBOX, scope: SCOPE });
  }
  async function grant(fields, isNew) {
    const issuedAt = now();
    const tokens = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT, client_secret: client.clientSecret, ...fields }).toString() });
    if (isNew && printable(tokens.refresh_token)) uncommitted.add(tokens.refresh_token);
    try { return await verify(tokens, isNew, issuedAt); }
    catch (error) {
      // A committed grant is NEVER revoked, including scope/identity/rotation failures.
      if (isNew) await revokeUncommitted(tokens.refresh_token);
      throw error;
    }
  }
  return Object.freeze({
    revokeUncommitted,
    committed(token) { if (!uncommitted.delete(token)) fail('CONFIG'); },
    begin() {
      if (pending && pending.expiresAt > now()) fail('PENDING');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      pending = { state, verifier, expiresAt: now() + 300000 };
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT,
        response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'false',
        login_hint: MAILBOX, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    },
    async complete({ state, code, error } = {}) {
      const attempt = pending; pending = undefined;
      if (!attempt || now() >= attempt.expiresAt || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state)) || error !== undefined || !printable(code) || code.length > 4096) fail('CALLBACK');
      return grant({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: attempt.verifier }, true);
    },
    async refresh(refreshToken) {
      if (!printable(refreshToken)) fail('CONFIG');
      const result = await grant({ grant_type: 'refresh_token', refresh_token: refreshToken }, false);
      if (result.refreshToken && result.refreshToken !== refreshToken) fail('ROTATION');
      return result;
    },
  });
}
module.exports = { PROJECT, PROJECT_NUMBER, CLIENT, REDIRECT, SCOPES, SCOPE, exactScopes, createSendOAuth };
