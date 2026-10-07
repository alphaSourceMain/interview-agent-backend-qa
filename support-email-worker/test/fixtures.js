'use strict';
// Independent signed fixtures only. This file cannot issue production decisions.
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { dkimSign } = require('mailauth/lib/dkim/sign');
const { createSeal } = require('mailauth/lib/arc');
const { REQUIRED } = require('../src/authenticate-raw');
const { boundedResolver } = require('../src/keys');
const strong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const now = Date.now();
const names = ['google._domainkey.alphasourceai.com', 'fixture._domainkey.google.com'];
function keyMaterial(key = strong, flags = '') {
  const der = key.publicKey.export({ type: 'spki', format: 'der' });
  return { record: 'v=DKIM1; k=rsa; p=' + der.toString('base64') + flags,
    pin: crypto.createHash('sha256').update(der).digest('hex'),
    privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
function fixtureKeys({ key = strong, flags = '', alias = false, extra = false, revoked = false, wrongPin = false, deadline = now + 300000 } = {}) {
  const material = keyMaterial(key, flags);
  const calls = [];
  const core = boundedResolver({ deadline, expectedPins: Object.fromEntries(names.map(name => [name, wrongPin ? '0'.repeat(64) : material.pin])),
    query: async (kind, name) => {
      calls.push({ kind, name });
      assert.ok(names.includes(name), 'unexpected DNS name');
      if (kind === 'CNAME') return alias ? ['elsewhere.invalid'] : [];
      const rows = [[revoked ? 'v=DKIM1; k=rsa; p=' : material.record]];
      if (extra) rows.push([material.record]);
      return rows;
    } });
  return { ...core, calls };
}
function base({ replace = {}, append = [], body = 'What does alphaScreen do?\r\n' } = {}) {
  const headers = {
    From: 'QA Sender <person@example.test>', To: 'support@alphasourceai.com', Subject: 'Initial QA inquiry',
    'Message-ID': '<synthetic-one@example.test>', 'List-ID': '<support.alphasourceai.com>', Sender: 'support@alphasourceai.com',
    Precedence: 'list', 'X-Original-Sender': 'person@example.test',
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Transfer-Encoding': '7bit', 'MIME-Version': '1.0',
    'Delivered-To': 'alphy@alphasourceai.com', 'X-BeenThere': 'support@alphasourceai.com', 'Return-Path': '<support+qa@alphasourceai.com>',
    ...replace,
  };
  return Buffer.from(Object.entries(headers).filter(([, value]) => value !== null).map(([name, value]) => name + ': ' + value).concat(append).join('\r\n') + '\r\n\r\n' + body);
}
async function signGroup(input, { key = strong, time = now, headerList = REQUIRED, maxBodyLength, selector = 'google', domain = 'alphasourceai.com' } = {}) {
  const result = await dkimSign(input, { strict: true, signTime: new Date(time), headerList,
    signatureData: [{ signingDomain: domain, selector, privateKey: keyMaterial(key).privateKey, algorithm: 'rsa-sha256', maxBodyLength }] });
  assert.equal(result.errors.length, 0);
  return Buffer.concat([Buffer.from(result.signatures), input]);
}
async function seal(input, { instance = 1, cv = 'none', aar = 'mx.google.com; dkim=pass header.i=@example.test header.s=qa', headerList = REQUIRED, time = now, domain = 'google.com', strict = true } = {}) {
  const result = await createSeal(input, { strict, seal: { i: instance, cv, signingDomain: domain, selector: 'fixture',
    privateKey: keyMaterial().privateKey, algorithm: 'rsa-sha256', signTime: new Date(time), headerList, authResults: aar } });
  assert.equal(result.errors.length, 0);
  return Buffer.concat([Buffer.from(result.headers.join('\r\n') + '\r\n'), input]);
}
async function fixture({ baseOptions, arcOptions, secondArc, groupOptions, noArc = false } = {}) {
  let raw = base(baseOptions);
  if (!noArc) raw = await seal(raw, arcOptions);
  if (secondArc) raw = await seal(raw, { instance: 2, cv: 'pass', ...secondArc });
  return signGroup(raw, groupOptions);
}
const envelope = Object.freeze({ id: 'abc123', threadId: 'def456', historyId: '123456789', internalDate: String(now), labelIds: ['INBOX', 'UNREAD'] });
module.exports = { strong, weak, now, names, keyMaterial, fixtureKeys, base, signGroup, seal, fixture, envelope };
