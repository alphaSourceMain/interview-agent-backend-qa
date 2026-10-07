'use strict';
// Deliberately separate from the raw verifier's narrow profile/raw/thread paths.
const { OWNER } = require('./qa-config');
const { GROUP } = require('../../src/lib/supportEmailPolicy');
const { readJson } = require('./qa-store');
async function listOwnerMessages({ accessToken, cutoverMs, deadline }) {
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(accessToken) ||
      !Number.isSafeInteger(cutoverMs) || cutoverMs <= 0 || !Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error('SUPPORT_EMAIL_QA_LIST');
  const query = `from:${OWNER} to:${GROUP} after:${Math.floor(cutoverMs / 1000)} -in:spam -in:trash`;
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=' + encodeURIComponent(query),
    { headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(Math.min(15000, deadline - Date.now())) });
  if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('SUPPORT_EMAIL_QA_LIST');
  return readJson(response);
}
module.exports = { listOwnerMessages };
