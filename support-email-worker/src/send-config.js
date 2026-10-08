'use strict';
const { createHash } = require('node:crypto');
const { parse } = require('dotenv');
const { secureReadText, readExistingClient } = require('../../src/lib/supportEmailInstaller');
const { validateGrant, QA, MAILBOX, OWNER } = require('./qa-config');
const { PROJECT, PROJECT_NUMBER, CLIENT, REDIRECT, SCOPE } = require('./send-oauth');
const ENV_FILE = '/Users/jasongardner/Desktop/ai-interview-final/QA/interview-agent-backend-qa/.env';
const READ_CLIENT = '/Users/jasongardner/Downloads/client_secret_940084368446-rmd990rkphtbbshq85tk357kcd3dl0t8.apps.googleusercontent.com.json';
const READ_GRANT = '/Users/jasongardner/Downloads/alphy-support-qa/grant.json';
const SEND_CLIENT = '/Users/jasongardner/Downloads/alphy-support-qa/isolated-send-client.json';
const SEND_GRANT = '/Users/jasongardner/Downloads/alphy-support-qa/isolated-send-grant.json';
const DRAFT = '1afe67e6-78e7-4df9-a69a-cbb066351d9d';
const MD5 = '3b5b4fcd3e944481c150ba00eb3ff5a2';
const SHA256 = '25796fcabdd1ea631b88a60e83d9c7bc0351c6b1f08acc6f36e3e2bdbdfb6f38';
const KEYS = Object.freeze(['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPPORT_EMAIL_MODE','SUPPORT_EMAIL_ENVIRONMENT','SUPPORT_EMAIL_MAILBOX',
  'SUPPORT_EMAIL_OWNER_TEST_ONLY','SUPPORT_EMAIL_OWNER_TEST_SENDER','SUPPORT_EMAIL_CUTOVER_AT','SUPPORT_EMAIL_BASELINE_HISTORY_ID',
  'SUPPORT_EMAIL_ENABLED','SUPPORT_EMAIL_OAUTH_ENABLED','SUPPORT_EMAIL_CONNECTION_APPROVED','SUPPORT_EMAIL_SEND_CONNECTION_APPROVED',
  'SUPPORT_EMAIL_SEND_ONCE_ENABLED','SUPPORT_EMAIL_SEND_OAUTH_ENABLED']);
const fail = () => { throw new Error('SUPPORT_EMAIL_SEND_CONFIG'); };
function readSendClient(filename = SEND_CLIENT) {
  try {
    const parsed = JSON.parse(secureReadText(filename)), c = parsed.web;
    const allowed = ['client_id','project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_secret','redirect_uris','javascript_origins'];
    if (!c || Object.keys(parsed).length !== 1 || Object.keys(c).some(k => !allowed.includes(k)) ||
      c.client_id !== CLIENT || c.project_id !== PROJECT || CLIENT.split('-')[0] !== PROJECT_NUMBER || c.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
      c.token_uri !== 'https://oauth2.googleapis.com/token' || c.auth_provider_x509_cert_url !== 'https://www.googleapis.com/oauth2/v1/certs' ||
      !Array.isArray(c.redirect_uris) || c.redirect_uris.length !== 1 || c.redirect_uris[0] !== REDIRECT ||
      (c.javascript_origins && (!Array.isArray(c.javascript_origins) || c.javascript_origins.length)) ||
      typeof c.client_secret !== 'string' || !/^[\x21-\x7e]{20,256}$/.test(c.client_secret)) fail();
    return Object.freeze({ clientId: CLIENT, clientSecret: c.client_secret });
  } catch (_) { fail(); }
}
function validateSendGrant(grant) {
  if (!grant || Object.keys(grant).sort().join(',') !== 'accessTokenExpiresAt,capturedAt,clientId,mailbox,refreshToken,scope' ||
    grant.clientId !== CLIENT || grant.mailbox !== MAILBOX || grant.scope !== SCOPE || typeof grant.refreshToken !== 'string' ||
    !/^[\x21-\x7e]{1,8192}$/.test(grant.refreshToken) || typeof grant.capturedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(grant.capturedAt) ||
    !Number.isSafeInteger(Date.parse(grant.capturedAt)) || new Date(grant.capturedAt).toISOString() !== grant.capturedAt ||
    Date.parse(grant.capturedAt) > Date.now() || Date.parse(grant.capturedAt) < 1704067200000 ||
    !Number.isSafeInteger(grant.accessTokenExpiresAt) || grant.accessTokenExpiresAt <= Date.parse(grant.capturedAt) ||
    grant.accessTokenExpiresAt > Date.parse(grant.capturedAt) + 7200000) fail();
  return Object.freeze(grant);
}
function validateSendEnvironment(env, readGrant, mode) {
  const connect = mode === 'connect';
  if (!['connect','send'].includes(mode) || env.SUPABASE_URL !== QA || env.SUPPORT_EMAIL_ENVIRONMENT !== 'qa' ||
    env.SUPPORT_EMAIL_MODE !== 'qa-draft' || env.SUPPORT_EMAIL_MAILBOX !== MAILBOX || env.SUPPORT_EMAIL_OWNER_TEST_ONLY !== 'true' ||
    env.SUPPORT_EMAIL_OWNER_TEST_SENDER !== OWNER || env.SUPPORT_EMAIL_ENABLED !== 'false' || env.SUPPORT_EMAIL_CONNECTION_APPROVED !== 'false' ||
    env.SUPPORT_EMAIL_OAUTH_ENABLED !== (connect ? 'false' : 'true') || env.SUPPORT_EMAIL_SEND_OAUTH_ENABLED !== 'true' ||
    env.SUPPORT_EMAIL_SEND_CONNECTION_APPROVED !== (connect ? 'true' : 'false') || env.SUPPORT_EMAIL_SEND_ONCE_ENABLED !== (connect ? 'false' : 'true') ||
    env.SUPPORT_EMAIL_BASELINE_HISTORY_ID !== readGrant.baselineHistoryId || !Number.isSafeInteger(Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT)) ||
    Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT) < Date.parse(readGrant.capturedAt) || Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT) > Date.now()) fail();
  if (!connect) {
    try {
      const parts = env.SUPABASE_SERVICE_ROLE_KEY.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) fail();
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (claims.role !== 'service_role' || claims.ref !== 'yjjxzxoghlpguquknyso' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()+240000) fail();
    } catch (_) { fail(); }
  }
  return Object.freeze({ ...env, cutoverMs: Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT) });
}
function loadSendConfig(mode) {
  // Fixed local file only; no ambient environment. Only named keys are retained.
  const text = secureReadText(ENV_FILE,65536), names = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/gm)].map(m=>m[1]);
  if (names.length !== new Set(names).size) fail();
  const parsed = parse(text), env = Object.fromEntries(KEYS.filter(k=>Object.hasOwn(parsed,k)).map(k=>[k,parsed[k]]));
  const readGrant = validateGrant(JSON.parse(secureReadText(READ_GRANT)));
  const settings = validateSendEnvironment(env, readGrant, mode), readClient = readExistingClient(READ_CLIENT), sendClient = readSendClient();
  const sendGrant = mode === 'send' ? validateSendGrant(JSON.parse(secureReadText(SEND_GRANT))) : null;
  const binding = createHash('sha256').update(JSON.stringify({ env:settings, readGrant, readClient, sendClient, sendGrant })).digest('hex');
  return Object.freeze({ env:settings, readGrant, readClient, sendClient, sendGrant, binding });
}
module.exports = { DRAFT, MD5, SHA256, SEND_CLIENT, SEND_GRANT, readSendClient, validateSendGrant, validateSendEnvironment, loadSendConfig };
