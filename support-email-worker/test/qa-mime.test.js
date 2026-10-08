'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQaMime, verifyQaSent, messageId } = require('../src/qa-mime');
const { SIGNOFF } = require('../../src/lib/supportEmailPolicy');
const record = { sender: 'jason@gardner.ltd', senderVerified: true, gmailId: '123', threadId: '456', rfcMessageId: '<original@mail.example.invalid>', subject: 'Owner QA test' };
const body = 'General product guidance only.' + SIGNOFF;
function sent(wire, change = '') {
  const result = { id: '789', threadId: '456' };
  const raw = 'x-google-extra: synthetic\r\n' + wire.raw.toString().replace(...(change ? ['to: jason@gardner.ltd', change] : ['x-never', 'x-never']));
  const envelope = { id: '789', threadId: '456', historyId: '200', internalDate: String(Date.now()), labelIds: ['SENT'], raw: Buffer.from(raw).toString('base64url') };
  const thread = { id: '456', messages: [{ id: '123', threadId: '456' }, { id: '789', threadId: '456' }] };
  return { result, envelope, thread };
}
test('one owner reply contains default CID logo, alternatives and auto-reply/thread headers', () => {
  const wire = buildQaMime(record, body), text = wire.raw.toString();
  assert.equal(wire.headers.from, 'alphy@alphasourceai.com'); assert.equal(wire.headers.to, 'jason@gardner.ltd');
  assert.equal(wire.headers['in-reply-to'], record.rfcMessageId); assert.equal(wire.headers.references, record.rfcMessageId);
  assert.equal(wire.headers.subject, record.subject); assert.equal(wire.headers['auto-submitted'], 'auto-replied');
  assert.match(text, /multipart\/alternative/); assert.match(text, /Content-ID: <alphy-horizontal@alphasourceai.com>/);
  assert.ok(wire.raw.length < 240 * 1024); assert.equal(/(?:^|\r\n)(?:cc|bcc|date|message-id):/i.test(text), false);
});
test('exact Sent readback permits only added provider headers', () => {
  const wire = buildQaMime(record, body), s = sent(wire); assert.equal(verifyQaSent(s.envelope, s.result, wire, s.thread), true);
});
for (const [key, value] of [['sender', 'other@example.invalid'], ['senderVerified', false], ['threadId', 'bad/path'], ['gmailId', 'bad/path'], ['subject', 'Bad\r\nBcc: evil@example.invalid'], ['subject', '=?UTF-8?B?cmU=?='], ['subject', 'NonASCII \u2028 subject'], ['rfcMessageId', '<bad@x>\r\ncc: evil']]) {
  test('rejects routing/header mutation ' + key, () => assert.throws(() => buildQaMime({ ...record, [key]: value }, body), /QA_MIME/));
}
for (const mutation of ['recipient', 'cc', 'duplicate', 'body', 'thread', 'label', 'inbox', 'extra-thread', 'missing-original']) {
  test('Sent rejects ' + mutation, () => {
    const wire = buildQaMime(record, body), s = sent(wire, mutation === 'recipient' ? 'to: other@example.invalid' : '');
    if (['cc','duplicate','body'].includes(mutation)) { let raw = Buffer.from(s.envelope.raw, 'base64url').toString();
      if (mutation === 'cc') raw = 'cc: other@example.invalid\r\n' + raw;
      if (mutation === 'duplicate') raw = 'to: jason@gardner.ltd\r\n' + raw;
      if (mutation === 'body') raw += 'changed';
      s.envelope.raw = Buffer.from(raw).toString('base64url'); }
    if (mutation === 'thread') s.envelope.threadId = '999';
    if (mutation === 'label') s.envelope.labelIds = ['DRAFT'];
    if (mutation === 'inbox') s.envelope.labelIds = ['SENT','INBOX'];
    if (mutation === 'extra-thread') s.thread.messages.push({id:'aaa',threadId:'456'});
    if (mutation === 'missing-original') s.thread.messages[0].id = 'bbb';
    assert.throws(() => verifyQaSent(s.envelope, s.result, wire, s.thread), /QA_MIME/);
  });
}
test('RFC Message-ID conservative subset rejects controls/comments/quoted forms', () => {
  assert.equal(messageId(record.rfcMessageId),true); for (const value of ['<a b@x>', '<a@x>\n', '<a(b)@x>', '<"a"@x>', '<a@x>:']) assert.equal(messageId(value),false);
});
