'use strict';
const { hex, decimal } = require('./gmail-read');
const { readJson } = require('./qa-store');
const fail = () => { throw Error('SUPPORT_EMAIL_HISTORY_HELD'); };
function validateHistory(value, cursor) {
  if (!decimal(cursor) || !value || typeof value !== 'object' || Array.isArray(value) || value.nextPageToken ||
      !decimal(value.historyId) || BigInt(value.historyId) < BigInt(cursor) ||
      (value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 25))) fail();
  const ids = new Set();
  let previous = BigInt(cursor);
  for (const event of value.history || []) {
    if (!decimal(event.id) || BigInt(event.id) <= previous || BigInt(event.id) > BigInt(value.historyId) ||
        !Array.isArray(event.messagesAdded) || event.messagesAdded.length > 25) fail();
    previous = BigInt(event.id);
    for (const addition of event.messagesAdded) {
      const m = addition?.message;
      if (!hex(m?.id) || !hex(m.threadId) || !Array.isArray(m.labelIds) || m.labelIds.length > 100 ||
          m.labelIds.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(label))) fail();
      ids.add(m.id);
      if (ids.size > 25) fail();
    }
  }
  return Object.freeze({ next: value.historyId, ids: Object.freeze([...ids]) });
}
async function readHistory(accessToken, cursor, deadline) {
  if (!decimal(cursor) || typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(accessToken) || !Number.isSafeInteger(deadline) || Date.now() + 10000 > deadline) fail();
  const query = new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded', maxResults: '25' });
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/history?' + query, {
    headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  // Expiry/404 deliberately requires operator reconciliation; never backfill.
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
  return validateHistory(await readJson(response), cursor);
}
module.exports = { validateHistory, readHistory };
