'use strict';
// Explicit compiled destinations. Never accept a caller-supplied URL or profile.
const { address } = require('../../src/lib/supportEmailPolicy');
const QA = Object.freeze({ environment: 'qa', name: 'alphascreen-alphy-mail-qa',
  url: 'https://yjjxzxoghlpguquknyso.supabase.co', ref: 'yjjxzxoghlpguquknyso', ownerOnly: true });
const PROD = Object.freeze({ environment: 'production', name: 'alphascreen-alphy-mail-prod',
  url: 'https://rytlclkkcvvnkoncfaid.supabase.co', ref: 'rytlclkkcvvnkoncfaid' });
const PROD_OWNER = Object.freeze({ ...PROD, ownerOnly: true });
const PROD_CUSTOMER = Object.freeze({ ...PROD, ownerOnly: false });
const fail = () => { throw Error('SUPPORT_EMAIL_RUNTIME_PROFILE'); };
function getRuntimeProfile(env = process.env) {
  if (env.SUPPORT_EMAIL_ENVIRONMENT === 'qa') {
    if (env.SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED === 'true' || env.SUPPORT_EMAIL_MAILBOX_RETIRED === 'true') fail();
    return QA;
  }
  if (env.SUPPORT_EMAIL_ENVIRONMENT !== 'production' || env.SUPPORT_EMAIL_PRODUCTION_RELEASE_APPROVED !== 'true' ||
      env.SUPPORT_EMAIL_PRODUCTION_SERVICE_ROLE_APPROVED !== 'true' ||
      !['production-draft', 'production-canary', 'production-auto'].includes(env.SUPPORT_EMAIL_WORKER_MODE)) fail();
  const ownerOnly = env.SUPPORT_EMAIL_WORKER_MODE !== 'production-auto';
  if (!ownerOnly && env.SUPPORT_EMAIL_CUSTOMER_RESPONSES_APPROVED !== 'true') fail();
  return ownerOnly ? PROD_OWNER : PROD_CUSTOMER;
}
function assertRuntimeProfile(profile) {
  if (![QA, PROD_OWNER, PROD_CUSTOMER].includes(profile)) fail();
  return profile;
}
function safeExternalSender(sender) {
  return typeof sender === 'string' && address(sender) === sender && !sender.endsWith('@alphasourceai.com') &&
    !/(?:no[._-]?reply|mailer-daemon|postmaster|bounce)/i.test(sender.split('@')[0]);
}
module.exports = { QA_PROFILE: QA, getRuntimeProfile, assertRuntimeProfile, safeExternalSender };
