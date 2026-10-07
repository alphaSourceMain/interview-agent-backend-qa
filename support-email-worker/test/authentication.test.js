'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticateRaw, ingressSender, REQUIRED } = require('../src/authenticate-raw');
const { headersAndBody, plainQuestion, exactMailbox } = require('../src/raw-message');
const { boundedResolver, within } = require('../src/keys');
const { readVerifiedInitial, inspectVerified } = require('../src/verified-gmail');
const { classifyInitialEmail } = require('../../src/lib/supportEmailPolicy');
const F = require('./fixtures');
async function check(raw, keyOptions) {
  const keys = F.fixtureKeys(keyOptions);
  try { return await authenticateRaw({ raw, envelope: F.envelope, keys, now: F.now }); }
  finally { keys.close(); raw.fill(0); }
}
test('independently signed Group + ARC accept raw-derived initial question', async () => {
  const proof = await check(await F.fixture({ secondArc: {} }));
  assert.equal(proof.senderVerified, true);
  assert.equal(Buffer.from(proof.message.payload.body.data, 'base64url').toString(), 'What does alphaScreen do?\n');
  const policy = classifyInitialEmail({ message: proof.message, thread: { id: 'def456', messages: [{ id: 'abc123' }] },
    mailbox: 'alphy@alphasourceai.com', cutoverMs: F.now - 1000, baselineHistoryId: '1', deliveryVerified: true });
  assert.equal(policy.eligible, true);
});
test('signed MIME 1.0 with bounded comment is valid; ambiguous versions fail', async () => {
  assert.equal((await check(await F.fixture({ baseOptions: { replace: { 'MIME-Version': '1.0 (Google Groups)' } } }))).senderVerified, true);
  assert.equal((await check(await F.fixture({ baseOptions: { replace: { 'MIME-Version': '1.0 (library 1.0 (https://example.test/))' } } }))).senderVerified, true);
  for (const value of ['2.0', '1.0; 2.0', '1.0 (too(deep(with(five(levels)))))', '1.0 (unterminated']) await assert.rejects(check(await F.fixture({ baseOptions: { replace: { 'MIME-Version': value } } })));
});
for (const [name, mutate] of [
  ['body', raw => Buffer.concat([raw, Buffer.from('altered\r\n')])],
  ['From', raw => Buffer.from(raw.toString().replace('person@example.test', 'intruder@example.test'))],
  ['To', raw => Buffer.from(raw.toString().replace('To: support@alphasourceai.com', 'To: intruder@example.test'))],
  ['List-ID', raw => Buffer.from(raw.toString().replace('<support.alphasourceai.com>', '<other.example.test>'))],
  ['Sender', raw => Buffer.from(raw.toString().replace('Sender: support@alphasourceai.com', 'Sender: other@example.test'))],
  ['MIME', raw => Buffer.from(raw.toString().replace('charset=utf-8', 'charset=us-ascii'))],
  ['duplicate critical', raw => Buffer.concat([Buffer.from('From: intruder@example.test\r\n'), raw])],
  ['duplicate MIME', raw => Buffer.concat([Buffer.from('Content-Type: text/html\r\n'), raw])],
]) test('cryptographic fixture rejects altered ' + name, async () => assert.rejects(check(mutate(await F.fixture()))));
for (const [name, options] of [
  ['partial body signature', { groupOptions: { maxBodyLength: 5 } }],
  ['missing MIME signature coverage', { groupOptions: { headerList: REQUIRED.filter(v => v !== 'content-type') } }],
  ['old signature', { groupOptions: { time: F.now - 3601000 } }],
  ['future signature', { groupOptions: { time: F.now + 301000 } }],
  ['wrong selector', { groupOptions: { selector: 'other' } }],
  ['wrong domain', { groupOptions: { domain: 'other.example.test' } }],
  ['encoded subject', { baseOptions: { replace: { Subject: '=?UTF-8?B?UmU6IGV4YW1wbGU=?=' } } }],
]) test('validly signed inadmissible ' + name, async () => assert.rejects(check(await F.fixture(options))));
for (const [name, keyOptions] of [
  ['testing key', { flags: '; t=y' }], ['revoked key', { revoked: true }], ['extra TXT', { extra: true }],
  ['CNAME', { alias: true }], ['pin mismatch', { wrongPin: true }], ['deadline', { deadline: 1 }],
]) test('key policy rejects ' + name, async () => assert.rejects(check(await F.fixture(), keyOptions)));
test('weak RSA cryptographic signature is rejected', async () => assert.rejects(check(await F.fixture({ groupOptions: { key: F.weak }, noArc: true }), { key: F.weak })));
for (const [name, options] of [
  ['no ARC', { noArc: true }],
  ['Group-domain ingress DKIM', { arcOptions: { aar: 'mx.google.com; dkim=pass header.i=@alphasourceai.com' } }],
  ['SPF only', { arcOptions: { aar: 'mx.google.com; spf=pass smtp.mailfrom=person@example.test' } }],
  ['ambiguous ingress passes', { arcOptions: { aar: 'mx.google.com; dkim=pass header.i=@example.test; dkim=pass header.i=@example.test' } }],
  ['incorrect authserv', { arcOptions: { aar: 'other.example.test; dkim=pass header.i=@example.test' } }],
  ['original sender mismatch', { baseOptions: { replace: { 'X-Original-Sender': 'other@example.test' } } }],
  ['wrong ARC domain', { arcOptions: { domain: 'other.example.test' } }],
  ['old ARC seal', { arcOptions: { time: F.now - 3601000 } }],
]) test('valid Group proof falls back to public on ' + name, async () => {
  const proof = await check(await F.fixture(options));
  assert.equal(proof.senderVerified, false);
});
test('ARC gap, cv and broken seal fail client proof while re-signed Group passes', async () => {
  for (const [pattern, replacement] of [[/ARC-Seal: i=1/, 'ARC-Seal: i=2'], [/cv=none/, 'cv=pass'], [/b=([A-Za-z0-9])/, 'b=Z']]) {
    const sealed = await F.seal(F.base());
    const altered = Buffer.from(sealed.toString().replace(pattern, replacement));
    assert.equal((await check(await F.signGroup(altered))).senderVerified, false);
  }
});
test('missing historical AMS From coverage cannot select client guidance', async () => {
  const sealed = await F.seal(F.base());
  const altered = Buffer.from(sealed.toString().replace(/h=([^;]+)/, (_, list) => 'h=' + list.replace(/from:?/i, '')));
  assert.equal((await check(await F.signGroup(altered))).senderVerified, false);
});
test('actual reply headers and existing human thread remain ineligible', async () => {
  const proof = await check(await F.fixture({ baseOptions: { append: ['In-Reply-To: <old@example.test>'] } }));
  const args = { message: proof.message, thread: { id: 'def456', messages: [{ id: 'abc123' }] }, mailbox: 'alphy@alphasourceai.com', cutoverMs: F.now - 1000, baselineHistoryId: '1', deliveryVerified: true };
  assert.equal(classifyInitialEmail(args).reason, 'reply_headers');
  args.thread.messages.push({ id: 'human' });
  assert.equal(classifyInitialEmail(args).reason, 'not_initial_thread');
});
test('sealed ingress exact-domain AUID rules', () => {
  const prefix = 'i=1; mx.google.com; dkim=pass ';
  assert.equal(ingressSender(prefix + 'header.i=@example.test', 'person@example.test'), true);
  assert.equal(ingressSender(prefix + 'header.i=person@example.test header.d=example.test', 'person@example.test'), true);
  for (const suffix of ['header.i=other@example.test', 'header.i=@example.test header.d=other.test', 'header.i=@example.test header.i=@example.test', 'header.i=@sub.example.test']) assert.equal(ingressSender(prefix + suffix, 'person@example.test'), false);
});
test('no test result, bool, spread, proxy or forged object can mint production decisions', () => {
  for (const value of [{ eligible: true }, true, Object.freeze({}), new Proxy({}, {})]) assert.throws(() => inspectVerified(value));
});
test('gateway rejects caller path injection before making requests', async () => {
  await assert.rejects(readVerifiedInitial({ accessToken: 'x'.repeat(30), id: '../../profile', cutoverMs: F.now, baselineHistoryId: '1' }));
});
test('resolver never queries unexpected names or default DNS', async () => {
  let queries = 0;
  const keys = boundedResolver({ deadline: Date.now() + 10000, expectedPins: {}, query: async () => { queries++; throw Error('unexpected'); } });
  for (const name of ['qa._domainkey.example.test', 'evil.invalid', 'google._domainkey.alphasourceai.com.evil.invalid']) await assert.rejects(keys.resolver(name, 'TXT'));
  assert.equal(queries, 0);
});
test('resolver cap and timeout are enforced', async () => {
  const material = F.keyMaterial();
  const names = Array.from({ length: 7 }, (_, i) => 'q' + i + '._domainkey.google.com');
  let queries = 0;
  const keys = boundedResolver({ deadline: Date.now() + 10000, expectedPins: Object.fromEntries(names.map(n => [n, material.pin])), query: async kind => { queries++; return kind === 'CNAME' ? [] : [[material.record]]; } });
  for (const name of names.slice(0, 6)) await keys.resolver(name, 'TXT');
  await assert.rejects(keys.resolver(names[6], 'TXT'));
  assert.equal(queries, 12);
  assert.throws(() => keys.assertBudget());
  await assert.rejects(within(new Promise(() => {}), 2));
});
test('strict CRLF, header limit and malformed fields fail before crypto', () => {
  for (const raw of [Buffer.from('From: a\n\nb'), Buffer.alloc(256 * 1024 + 1), Buffer.from('invalid\r\n\r\nbody'), Buffer.from('From: a\r\n' + 'X: b\r\n'.repeat(101) + '\r\nbody')]) assert.throws(() => headersAndBody(raw));
  assert.equal(exactMailbox('Person@example.test'), null);
});
test('supported signed MIME decodes one plain body, rejects ambiguity/attachment/bad encodings', () => {
  const headers = [{ name: 'content-type', value: 'multipart/alternative; boundary="CaseSensitive"' }];
  const body = Buffer.from('--CaseSensitive\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello=20there\r\n--CaseSensitive\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>Hello</b>\r\n--CaseSensitive--\r\n');
  assert.equal(plainQuestion(headers, body).trim(), 'Hello there');
  for (const [type, encoding, value] of [['text/plain; name=x', '7bit', 'hello'], ['text/plain', 'base64', 'YQ='], ['text/plain', 'quoted-printable', '=ZZ'], ['text/plain', 'binary', 'hello'], ['text/plain; charset=iso-8859-1', '7bit', 'hello']]) assert.throws(() => plainQuestion([{ name: 'content-type', value: type }, { name: 'content-transfer-encoding', value: encoding }], Buffer.from(value)));
  const double = Buffer.from(body.toString().replace('text/html', 'text/plain'));
  assert.throws(() => plainQuestion(headers, double));
});
