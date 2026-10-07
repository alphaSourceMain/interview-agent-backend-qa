'use strict';
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const { arc } = require('mailauth/lib/arc');
const { headersAndBody, one, tags, mimeVersion, exactMailbox, plainQuestion, toPolicyMessage } = require('./raw-message');

const REQUIRED = Object.freeze(['from', 'to', 'subject', 'message-id', 'list-id', 'sender', 'precedence', 'x-original-sender', 'content-type', 'content-transfer-encoding', 'mime-version']);
const fail = () => { throw new Error('SUPPORT_EMAIL_AUTH_REJECTED'); };
const covered = signature => new Set(String(signature.h || '').toLowerCase().split(':').map(v => v.trim()));
function signatureShape(signature, domain, received, now, optionalTime = false) {
  if (signature.d !== domain || signature.a !== 'rsa-sha256' || !/^[a-z0-9-]{1,40}$/.test(signature.s || '') || Object.hasOwn(signature, 'l')) fail();
  if (optionalTime && signature.t === undefined && signature.x === undefined) return;
  if (!/^\d{1,12}$/.test(signature.t || '')) fail();
  const time = Number(signature.t) * 1000;
  if (Math.abs(time - received) > 3600000 || time > now + 300000) fail();
  if (signature.x !== undefined && (!/^\d{1,12}$/.test(signature.x) || Number(signature.x) < Number(signature.t) || Number(signature.x) * 1000 < now - 300000)) fail();
}

// The sealed original ingress AAR authenticates the domain, not the person.
function ingressSender(value, from) {
  if (!from || from.endsWith('@alphasourceai.com')) return false;
  // A conservative subset of Google's AAR syntax. Unsupported syntax -> public.
  if (/\([^()]*\([^()]*\)/.test(value)) return false;
  value = value.replace(/\([^()]*\)/g, ' ');
  if (/[()"\\]/.test(value)) return false;
  const clauses = value.split(';').map(v => v.trim());
  if (clauses.shift() !== 'i=1' || clauses.shift() !== 'mx.google.com') return false;
  const passes = clauses.filter(v => /^dkim\s*=\s*pass(?:\s|$)/.test(v));
  if (passes.length !== 1) return false;
  const properties = Object.create(null);
  const tokens = passes[0].replace(/^dkim\s*=\s*pass/, '').trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const match = /^([a-z]+\.[a-z]+)=([^\s;]+)$/.exec(token);
    if (!match || Object.hasOwn(properties, match[1])) return false;
    properties[match[1]] = match[2];
  }
  const domain = from.slice(from.lastIndexOf('@') + 1);
  return (properties['header.i'] === '@' + domain || properties['header.i'] === from) &&
    (!Object.hasOwn(properties, 'header.d') || properties['header.d'] === domain);
}

async function authenticateRaw({ raw, envelope, keys, now = Date.now() }) {
  let body;
  let stage = 'raw';
  try {
    const parsed = headersAndBody(raw);
    body = parsed.body;
    const headers = parsed.headers;
    for (const name of ['arc-seal', 'arc-message-signature', 'arc-authentication-results']) if (headers.filter(h => h.name === name).length > 10) fail();
    stage = 'group_fields';
    for (const name of REQUIRED) one(headers, name, true);
    // Encoded reply/forward subjects cannot bypass initial-message policy.
    if (one(headers, 'subject').includes('=?')) fail();
    const from = exactMailbox(one(headers, 'from'));
    if (!from || exactMailbox(one(headers, 'to')) !== 'support@alphasourceai.com' ||
      exactMailbox(one(headers, 'sender')) !== 'support@alphasourceai.com' || one(headers, 'list-id') !== '<support.alphasourceai.com>' ||
      one(headers, 'precedence').toLowerCase() !== 'list' || !mimeVersion(one(headers, 'mime-version'))) fail();
    const dkimRows = headers.filter(h => h.name === 'dkim-signature');
    stage = 'group_signature_policy';
    if (!dkimRows.length || dkimRows.length > 10) fail();
    const candidates = dkimRows.map(h => tags(h.value)).filter(s => s.d === 'alphasourceai.com');
    if (candidates.length !== 1 || candidates[0].s !== 'google') fail();
    signatureShape(candidates[0], 'alphasourceai.com', Number(envelope.internalDate), now);
    if (REQUIRED.some(name => !covered(candidates[0]).has(name))) fail();
    stage = 'group_crypto';
    const proof = await dkimVerify(raw, { strict: true, minBitLength: 2048, resolver: keys.resolver, curTime: new Date(now) });
    keys.assertBudget();
    const group = proof.results.filter(r => r.signingDomain === 'alphasourceai.com' && r.selector === 'google' && r.status.result === 'pass' &&
      r.algo === 'rsa-sha256' && !r.status.testing && !r.canonBodyLengthLimited && r.signatureTimeValid && r.modulusLength >= 2048);
    if (group.length !== 1) fail();
    // Only after full-body Group authentication may any MIME be decoded.
    stage = 'mime';
    const question = plainQuestion(headers, body);
    const message = toPolicyMessage(envelope, headers, question);
    let senderVerified = false;
    let senderReason = 'arc_structure';
    try {
      const seals = headers.filter(h => h.name === 'arc-seal').map(h => tags(h.value));
      const ams = headers.filter(h => h.name === 'arc-message-signature').map(h => tags(h.value));
      const aar = headers.filter(h => h.name === 'arc-authentication-results');
      if (!seals.length || seals.length > 10 || ams.length !== seals.length || aar.length !== seals.length) fail();
      for (let instance = 1; instance <= seals.length; instance++) {
        const seal = seals.filter(s => s.i === String(instance));
        const signature = ams.filter(s => s.i === String(instance));
        const result = aar.filter(h => new RegExp('^i=' + instance + ';').test(h.value));
        if (seal.length !== 1 || signature.length !== 1 || result.length !== 1) fail();
        if (seal[0].cv !== (instance === 1 ? 'none' : 'pass')) fail();
        signatureShape(seal[0], 'google.com', Number(envelope.internalDate), now);
        signatureShape(signature[0], 'google.com', Number(envelope.internalDate), now, true);
        if (!covered(signature[0]).has('from')) fail();
        await keys.resolver(seal[0].s + '._domainkey.google.com', 'TXT');
        await keys.resolver(signature[0].s + '._domainkey.google.com', 'TXT');
      }
      senderReason = 'arc_crypto';
      const chain = await arc(proof.arc, { strict: true, minBitLength: 2048, resolver: keys.resolver });
      keys.assertBudget();
      const original = aar.find(h => /^i=1;/.test(h.value));
      senderReason = 'ingress_sender';
      senderVerified = chain.status.result === 'pass' && chain.i === seals.length &&
        exactMailbox(one(headers, 'x-original-sender')) === from && ingressSender(original.value, from);
    } catch (_) { senderVerified = false; }
    keys.assertBudget();
    return Object.freeze({ message, senderVerified, senderReason: senderVerified ? 'verified' : senderReason });
  } catch (_) { const error = new Error('SUPPORT_EMAIL_AUTH_REJECTED'); error.stage = stage; throw error; }
  finally { if (body) body.fill(0); }
}
module.exports = { authenticateRaw, ingressSender, REQUIRED };
