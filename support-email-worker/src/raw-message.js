'use strict';

// A deliberately small fail-closed MIME subset, not a general mail viewer.
const MAX_RAW = 256 * 1024;
const MAX_HEADERS = 64 * 1024;
const MAX_QUESTION = 8000;
const fail = () => { throw new Error('SUPPORT_EMAIL_RAW_REJECTED'); };

function headersAndBody(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_RAW || !buffer.length) fail();
  const source = buffer.toString('latin1');
  if (/(?:^|[^\r])\n|\r(?!\n)/.test(source)) fail();
  const end = source.indexOf('\r\n\r\n');
  if (end < 0 || end > MAX_HEADERS) fail();
  const block = source.slice(0, end);
  if (/[^\x09\x20-\x7e\r\n]/.test(block)) fail();
  const rows = block.replace(/\r\n[ \t]+/g, ' ').split('\r\n');
  if (rows.length > 100) fail();
  const headers = rows.map(row => {
    const match = /^([!-9;-~]+):[ \t]*(.*)$/.exec(row);
    if (!match) fail();
    return Object.freeze({ name: match[1].toLowerCase(), value: match[2].trim() });
  });
  return { headers: Object.freeze(headers), body: Buffer.from(source.slice(end + 4), 'latin1') };
}

function one(headers, name, required = false) {
  const rows = headers.filter(h => h.name === name);
  if (rows.length > 1 || (required && rows.length !== 1)) fail();
  return rows[0]?.value || '';
}

function tags(value) {
  const result = Object.create(null);
  for (const item of value.split(';')) {
    if (!item.trim()) continue;
    const match = /^\s*([a-z][a-z0-9]*)\s*=\s*(.*?)\s*$/i.exec(item);
    if (!match || Object.hasOwn(result, match[1].toLowerCase())) fail();
    result[match[1].toLowerCase()] = match[2];
  }
  return result;
}

function mimeVersion(value) {
  // RFC comments can nest (Google Group delivery uses a MIME-library comment).
  if (typeof value !== 'string' || value.length > 512) return false;
  let depth = 0, escaped = false, outside = '';
  for (const char of value) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && depth) { escaped = true; continue; }
    if (char === '(') { if (++depth > 4) return false; continue; }
    if (char === ')') { if (--depth < 0) return false; continue; }
    if (!depth) outside += char;
  }
  return !depth && !escaped && outside.trim() === '1.0';
}

function exactMailbox(value) {
  if (/[\r\n,;:]/.test(value)) return null;
  const match = /^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/.exec(value);
  const email = match && (match[1] || match[2]);
  // Lowercase only, no normalization, folding, Unicode or quoted local-parts.
  return email && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

function decodeTransfer(body, encoding) {
  const source = body.toString('latin1');
  let decoded;
  if (encoding === 'base64') {
    const compact = source.replace(/\r\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) fail();
    decoded = Buffer.from(compact, 'base64');
    if (decoded.toString('base64') !== compact) fail();
  } else if (encoding === 'quoted-printable') {
    if (/=(?![0-9A-Fa-f]{2}|\r\n)/.test(source) || /[^\x09\x20-\x7e\r\n]/.test(source)) fail();
    decoded = Buffer.from(source.replace(/=\r\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  } else if (['7bit', '8bit'].includes(encoding)) {
    if (encoding === '7bit' && /[^\x00-\x7f]/.test(source)) fail();
    decoded = Buffer.from(body);
  } else fail();
  return decoded;
}

function plainQuestion(headers, body, budget = { parts: 0, plains: 0 }) {
  if (++budget.parts > 30) fail();
  const type = one(headers, 'content-type', true).toLowerCase();
  const transferRows = headers.filter(h => h.name === 'content-transfer-encoding');
  if (transferRows.length > 1 || (transferRows.length === 1 && !transferRows[0].value.trim())) fail();
  const transfer = transferRows.length ? transferRows[0].value.toLowerCase() : '7bit';
  // Enforce the container too, not only decoded leaves. A default 7bit outer
  // entity cannot carry raw 8bit bytes in a nested HTML or MIME part.
  if (transfer === '7bit' && body.some(byte => byte > 127)) fail();
  const disposition = one(headers, 'content-disposition');
  if ((disposition && disposition.toLowerCase() !== 'inline') || /(?:name|filename)\s*=/.test(type)) fail();
  if (type.startsWith('multipart/alternative;')) {
    if (transfer !== '7bit' && transfer !== '8bit') fail();
    // Preserve case-sensitive boundary from the original value.
    const match = /^multipart\/alternative;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(one(headers, 'content-type'));
    if (!match) fail();
    const boundary = match[1] || match[2];
    const lines = body.toString('latin1').split('\r\n');
    const pieces = [];
    let current = null, ended = false;
    for (const line of lines) {
      if (line === '--' + boundary || line === '--' + boundary + '--') {
        if (ended) fail();
        if (current) pieces.push(current.join('\r\n') + '\r\n');
        current = [];
        if (line.endsWith('--')) { ended = true; current = null; }
      } else if (current) current.push(line);
      else if (line.trim()) fail(); // No ambiguous preamble/epilogue.
    }
    if (!ended || pieces.length < 1 || pieces.length > 30) fail();
    let question = '';
    for (const piece of pieces) {
      const part = headersAndBody(Buffer.from(piece, 'latin1'));
      try { question += plainQuestion(part.headers, part.body, budget); } finally { part.body.fill(0); }
    }
    return question;
  }
  const match = /^(text\/plain|text\/html)(?:;\s*charset=(?:"(utf-8|us-ascii)"|(utf-8|us-ascii)))?$/i.exec(type);
  if (!match) fail();
  const decoded = decodeTransfer(body, transfer);
  try {
    const charset = match[2] || match[3] || 'us-ascii';
    if (charset === 'us-ascii' && decoded.some(byte => byte > 127)) fail();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    if (match[1] === 'text/html') return ''; // Never use HTML as question input.
    if (++budget.plains !== 1 || decoded.length > MAX_QUESTION || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(text)) fail();
    return text.replace(/\r\n/g, '\n');
  } finally { decoded.fill(0); }
}

function toPolicyMessage(envelope, headers, question) {
  return Object.freeze({ id: envelope.id, threadId: envelope.threadId, historyId: envelope.historyId,
    internalDate: envelope.internalDate, labelIds: Object.freeze([...envelope.labelIds]),
    payload: Object.freeze({ mimeType: 'text/plain', headers,
      body: Object.freeze({ data: Buffer.from(question, 'utf8').toString('base64url') }) }) });
}

module.exports = { MAX_RAW, headersAndBody, one, tags, mimeVersion, exactMailbox, plainQuestion, toPolicyMessage };
