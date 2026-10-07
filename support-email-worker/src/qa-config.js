'use strict';
const crypto = require('node:crypto');
const { parse } = require('dotenv');
const { secureReadText, readExistingClient, CLIENT } = require('../../src/lib/supportEmailInstaller');
const { READONLY_SCOPE } = require('../../src/lib/supportEmailAdapters');
const QA = 'https://yjjxzxoghlpguquknyso.supabase.co';
const ENV_FILE = '/Users/jasongardner/Desktop/ai-interview-final/QA/interview-agent-backend-qa/.env';
const CLIENT_FILE = '/Users/jasongardner/Downloads/client_secret_940084368446-rmd990rkphtbbshq85tk357kcd3dl0t8.apps.googleusercontent.com.json';
const GRANT_FILE = '/Users/jasongardner/Downloads/alphy-support-qa/grant.json';
const MAILBOX = 'alphy@alphasourceai.com';
const OWNER = 'jason@gardner.ltd';
const fail = () => { throw new Error('SUPPORT_EMAIL_QA_CONFIG'); };
const printable = (s, min = 20) => typeof s === 'string' && s.length >= min && s.length <= 8192 && /^[\x21-\x7e]+$/.test(s);

function validateGrant(g, now = Date.now()) {
  if (!g || Object.keys(g).sort().join(',') !== 'accessTokenExpiresAt,baselineHistoryId,capturedAt,clientId,mailbox,refreshToken,scope' ||
      g.clientId !== CLIENT || g.mailbox !== MAILBOX || g.scope !== READONLY_SCOPE || !printable(g.refreshToken, 1) ||
      !/^\d{1,30}$/.test(g.baselineHistoryId || '') || typeof g.capturedAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(g.capturedAt) ||
      !Number.isSafeInteger(Date.parse(g.capturedAt)) || new Date(g.capturedAt).toISOString() !== g.capturedAt ||
      Date.parse(g.capturedAt) > now || Date.parse(g.capturedAt) < 1704067200000 ||
      !Number.isSafeInteger(g.accessTokenExpiresAt) || g.accessTokenExpiresAt <= Date.parse(g.capturedAt) ||
      g.accessTokenExpiresAt > Date.parse(g.capturedAt) + 7200000) fail();
  return Object.freeze(g);
}
function validateConfig(env, grant) {
  const cutoverMs = Date.parse(env.SUPPORT_EMAIL_CUTOVER_AT || '');
  if (env.SUPPORT_EMAIL_ENABLED !== 'true' || env.SUPPORT_EMAIL_OAUTH_ENABLED !== 'true' || env.SUPPORT_EMAIL_MODE !== 'qa-draft' ||
      env.SUPPORT_EMAIL_ENVIRONMENT !== 'qa' || env.SUPABASE_URL !== QA || env.SUPPORT_EMAIL_MAILBOX !== MAILBOX ||
      env.SUPPORT_EMAIL_OWNER_TEST_ONLY !== 'true' || env.SUPPORT_EMAIL_OWNER_TEST_SENDER !== OWNER ||
      env.SUPPORT_EMAIL_BASELINE_HISTORY_ID !== grant.baselineHistoryId || !Number.isSafeInteger(cutoverMs) ||
      cutoverMs < Date.parse(grant.capturedAt) || cutoverMs > Date.now() ||
      !printable(env.XAI_API_KEY) || !printable(env.SUPABASE_SERVICE_ROLE_KEY)) fail();
  // This is a local binding check, not signature verification. The server verifies
  // the actual credential via a non-inserting RPC before mailbox/model access.
  try {
    const parts = env.SUPABASE_SERVICE_ROLE_KEY.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) fail();
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims.role !== 'service_role' || claims.ref !== 'yjjxzxoghlpguquknyso' ||
        !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now() + 240000) fail();
  } catch (_) { fail(); }
  return Object.freeze({ ...env, cutoverMs });
}
function loadQaConfig() {
  // No process.env merge, path argument, dotenv expansion or ambient override.
  const text = secureReadText(ENV_FILE, 65536);
  const names = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/gm)].map(m => m[1]);
  if (names.length !== new Set(names).size) fail();
  const grant = validateGrant(JSON.parse(secureReadText(GRANT_FILE)));
  const env = validateConfig(parse(text), grant);
  const client = readExistingClient(CLIENT_FILE);
  const binding = crypto.createHash('sha256').update(JSON.stringify({ env, grant, client })).digest('hex');
  return Object.freeze({ env, grant, client, binding });
}
module.exports = { QA, MAILBOX, OWNER, validateGrant, validateConfig, loadQaConfig };
