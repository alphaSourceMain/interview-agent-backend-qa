'use strict';
// Pure owner-only wire formatting/readback checks. No credentials or transport.
const { randomBytes } = require('node:crypto');
const { renderSupportEmailPreview } = require('../../src/lib/supportEmailPreview');
const { MAILBOX, OWNER } = require('./qa-config');
const { headersAndBody, one } = require('./raw-message');
const { hex, decodeEnvelope } = require('./gmail-read');
const fail = () => { throw new Error('SUPPORT_EMAIL_QA_MIME'); };
const messageId = value => typeof value === 'string' && value.length <= 502 &&
  /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,250}@[A-Za-z0-9][A-Za-z0-9.-]{0,249}>$/.test(value);
const fold64 = bytes => bytes.toString('base64').match(/.{1,76}/g).join('\r\n');

function buildQaMime(record, body) {
  if (!record || record.sender !== OWNER || record.senderVerified !== true || !hex(record.gmailId) || !hex(record.threadId) ||
    !messageId(record.rfcMessageId) || typeof record.subject !== 'string' || !/^[\x20-\x7e]{1,300}$/.test(record.subject) || record.subject.includes('=?')) fail();
  const preview = renderSupportEmailPreview(body, 'brand-horizontal');
  // Both options are bounded/hash checked, but only the approved default is sent.
  const alternativePreview = renderSupportEmailPreview(body, 'compact-symbol');
  alternativePreview.inlineImage.bytes.fill(0);
  const related = 'alphy-related-' + randomBytes(24).toString('hex');
  const alternative = 'alphy-alternative-' + randomBytes(24).toString('hex');
  const headers = Object.freeze({
    from: MAILBOX, to: OWNER, subject: record.subject,
    'in-reply-to': record.rfcMessageId, references: record.rfcMessageId,
    'auto-submitted': 'auto-replied', 'x-auto-response-suppress': 'All', 'mime-version': '1.0',
    'content-type': 'multipart/related; boundary="' + related + '"',
  });
  // Every boundary contains '-', which cannot occur in standard base64 parts.
  const encode = bytes => { const value = fold64(bytes); if (value.includes(related) || value.includes(alternative)) fail(); return value; };
  const part = (type, bytes) => 'Content-Type: ' + type + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' + encode(bytes) + '\r\n';
  const content = '--' + related + '\r\nContent-Type: multipart/alternative; boundary="' + alternative + '"\r\n\r\n' +
    '--' + alternative + '\r\n' + part('text/plain; charset=utf-8', Buffer.from(preview.text)) +
    '--' + alternative + '\r\n' + part('text/html; charset=utf-8', Buffer.from(preview.html)) +
    '--' + alternative + '--\r\n\r\n--' + related + '\r\nContent-Type: image/png\r\n' +
    'Content-Disposition: inline; filename="alphy.png"\r\nContent-ID: <' + preview.inlineImage.cid + '>\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' + encode(preview.inlineImage.bytes) + '\r\n--' + related + '--\r\n';
  preview.inlineImage.bytes.fill(0);
  const raw = Buffer.from(Object.entries(headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n' + content);
  if (raw.length > 240 * 1024 || raw.toString('ascii').split('\r\n').some(line => line.length > 998)) { raw.fill(0); fail(); }
  return Object.freeze({ raw, headers, content, threadId: record.threadId, originalId: record.gmailId });
}

function verifyQaSent(envelope, result, wire, thread) {
  if (!result || !hex(result.id) || result.id === wire.originalId || result.threadId !== wire.threadId || envelope?.id !== result.id ||
    envelope.threadId !== wire.threadId || !Array.isArray(envelope.labelIds) || !envelope.labelIds.includes('SENT') ||
    envelope.labelIds.some(label => ['INBOX', 'DRAFT', 'TRASH', 'SPAM'].includes(label)) || !thread || thread.id !== wire.threadId ||
    !Array.isArray(thread.messages) || thread.messages.length !== 2 ||
    thread.messages.some(m => !hex(m.id) || m.threadId !== wire.threadId) ||
    new Set(thread.messages.map(m => m.id)).size !== 2 || !thread.messages.some(m => m.id === result.id) ||
    !thread.messages.some(m => m.id === wire.originalId)) fail();
  const raw = decodeEnvelope(envelope, result.id);
  let parsed;
  try {
    parsed = headersAndBody(raw);
    // Google may add routing/DKIM headers, but may not change any expected header,
    // duplicate it, add extra recipients or rewrite the exact generated MIME body.
    for (const [name, expected] of Object.entries(wire.headers)) if (one(parsed.headers, name, true) !== expected) fail();
    for (const name of ['date', 'message-id']) one(parsed.headers, name);
    for (const name of ['cc', 'bcc', 'resent-to', 'resent-cc', 'resent-bcc', 'reply-to', 'content-transfer-encoding']) {
      if (parsed.headers.some(h => h.name === name)) fail();
    }
    if (!parsed.body.equals(Buffer.from(wire.content))) fail();
    return true;
  } catch (_) { fail(); }
  finally { raw.fill(0); if (parsed) parsed.body.fill(0); }
}
module.exports = { buildQaMime, verifyQaSent, messageId };
