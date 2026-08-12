'use strict';

const SMS_PROVIDER_SAFE_ERRORS = Object.freeze([
  'invalid_destination',
  'blocked_destination',
  'provider_rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'misconfigured',
]);

const SMS_PROVIDER_RESULT_STATUSES = Object.freeze(['queued', 'sent', 'rejected']);

function assertSmsProviderRequest({ toE164, code, challengeId, expiresAt, environment } = {}) {
  if (!/^\+[1-9]\d{7,14}$/.test(String(toE164 || ''))) throw new TypeError('toE164 must be canonical E.164');
  if (!/^\d{6}$/.test(String(code || ''))) throw new TypeError('code must be six digits');
  if (!/^[0-9a-f-]{36}$/i.test(String(challengeId || ''))) throw new TypeError('challengeId is required');
  if (!Number.isFinite(Date.parse(String(expiresAt || '')))) throw new TypeError('expiresAt is required');
  if (!['qa', 'production'].includes(String(environment || ''))) throw new TypeError('environment is invalid');
  return true;
}

function assertSmsProviderResult({ provider, messageId, status } = {}) {
  if (!/^[a-z0-9_-]{1,40}$/.test(String(provider || ''))) throw new TypeError('provider is invalid');
  if (!String(messageId || '').trim() || String(messageId).length > 255) throw new TypeError('messageId is invalid');
  if (!SMS_PROVIDER_RESULT_STATUSES.includes(String(status || ''))) throw new TypeError('status is invalid');
  return true;
}

module.exports = {
  SMS_PROVIDER_RESULT_STATUSES,
  SMS_PROVIDER_SAFE_ERRORS,
  assertSmsProviderRequest,
  assertSmsProviderResult,
};
