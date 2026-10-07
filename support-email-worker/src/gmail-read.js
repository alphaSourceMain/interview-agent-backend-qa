'use strict';
const { MAX_RAW } = require('./raw-message');
const hex = value => typeof value === 'string' && /^[a-f0-9]{1,40}$/.test(value);
const decimal = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const fail = () => { throw new Error('SUPPORT_EMAIL_GMAIL_REJECTED'); };

async function boundedJson(path, token, deadline) {
  if (!/^(?:profile|messages\/[a-f0-9]{1,40}\?format=raw|threads\/[a-f0-9]{1,40}\?format=minimal)$/.test(path) ||
    typeof token !== 'string' || !/^[A-Za-z0-9._~-]{20,8192}$/.test(token) || !Number.isSafeInteger(deadline) || deadline <= Date.now()) fail();
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path,
    { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal });
  if (!response.ok || !response.body?.getReader || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail();
  const reader = response.body.getReader();
  let total = 0, combined;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 400 * 1024) { await reader.cancel(); fail(); }
      chunks.push(Buffer.from(value));
    }
    combined = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
  } finally { if (combined) combined.fill(0); for (const chunk of chunks) chunk.fill(0); reader.releaseLock(); }
}

function decodeEnvelope(value, id) {
  if (!hex(id) || !value || value.id !== id || !hex(value.threadId) || !decimal(value.historyId) || !decimal(value.internalDate) ||
    !Number.isSafeInteger(Number(value.internalDate)) || !Array.isArray(value.labelIds) || value.labelIds.length > 100 ||
    value.labelIds.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(label)) ||
    typeof value.raw !== 'string' || value.raw.length > Math.ceil(MAX_RAW * 4 / 3) + 2 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value.raw)) fail();
  const raw = Buffer.from(value.raw, 'base64url');
  const canonical = raw.toString('base64url');
  const padded = canonical + '='.repeat((4 - canonical.length % 4) % 4);
  // Gmail returns padded base64url. Both canonical variants accepted; no lax decoder.
  if (raw.length > MAX_RAW || (value.raw !== canonical && value.raw !== padded)) { raw.fill(0); fail(); }
  return raw;
}
module.exports = { hex, decimal, boundedJson, decodeEnvelope };
