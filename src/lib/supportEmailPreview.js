// Branded preview only. No mail transport or approval state; never imported by app/start.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SIGNOFF } = require('./supportEmailPolicy');
const MAX_ASSET = 1024 * 1024;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const IDENTITY = 'alphy | AI support assistant | alphaSource | https://www.alphasourceai.com/ | mailto:support@alphasourceai.com';
const OPTIONS = Object.freeze({
  'brand-horizontal': Object.freeze({ filename: 'horizontal.png', cid: 'alphy-horizontal@alphasourceai.com',
    hash: '0eba097b8e2348be37da3d339bab0b00d0d8253cc42ac8fbb5a085203799e07d', length: 155134, width: 3163, height: 752 }),
  'compact-symbol': Object.freeze({ filename: 'compact.png', cid: 'alphy-compact@alphasourceai.com',
    hash: 'bd82c2b32e904ed07701480fae0b862d1ab484dc1ace9581df74e9fd1aca2f0e', length: 128741, width: 1200, height: 1200 }),
});
const fail = code => { throw new Error(code); };
const escape = text => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function readImage(option) {
  const filename = path.join(__dirname, 'support-email-assets', option.filename);
  let fd;
  try {
    if (fs.realpathSync(filename) !== filename || fs.lstatSync(path.dirname(filename)).isSymbolicLink()) fail('SUPPORT_EMAIL_PREVIEW_ASSET');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== option.length || stat.size > MAX_ASSET) fail('SUPPORT_EMAIL_PREVIEW_ASSET');
    const buffer = Buffer.alloc(MAX_ASSET + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, count);
    if (count !== option.length || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 ||
        bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(16) !== option.width || bytes.readUInt32BE(20) !== option.height ||
        createHash('sha256').update(bytes).digest('hex') !== option.hash) fail('SUPPORT_EMAIL_PREVIEW_ASSET');
    return Buffer.from(bytes); // Only verified bytes, new buffer for each preview.
  } catch (_) { fail('SUPPORT_EMAIL_PREVIEW_ASSET'); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { fail('SUPPORT_EMAIL_PREVIEW_ASSET'); } } }
}

function renderSupportEmailPreview(body, signatureId = 'brand-horizontal') {
  if (typeof signatureId !== 'string' || !Object.hasOwn(OPTIONS, signatureId)) fail('SUPPORT_EMAIL_PREVIEW_SIGNATURE');
  if (typeof body !== 'string' || body.length > 4000 + SIGNOFF.length || !body.endsWith(SIGNOFF) ||
      body.indexOf(SIGNOFF) !== body.length - SIGNOFF.length ||
      /[\x00-\x09\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(body) ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(body)) fail('SUPPORT_EMAIL_PREVIEW_BODY');
  const answer = body.slice(0, -SIGNOFF.length);
  if (!answer.trim() || Buffer.byteLength(answer, 'utf8') > 4000) fail('SUPPORT_EMAIL_PREVIEW_BODY');
  const option = OPTIONS[signatureId];
  const bytes = readImage(option);
  const horizontal = signatureId === 'brand-horizontal';
  const image = `<img src="cid:${option.cid}" width="${horizontal ? 150 : 58}" alt="${escape(IDENTITY)}" style="display:block;width:${horizontal ? 150 : 58}px;height:auto">`;
  const contacts = '<strong style="font-size:15px">alphy</strong><br>AI support assistant | alphaSource<br>' +
    '<a href="https://www.alphasourceai.com/" rel="noopener noreferrer" style="color:#27304e;text-decoration:none">alphasourceai.com</a><br>' +
    '<a href="mailto:support@alphasourceai.com" style="color:#27304e">support@alphasourceai.com</a>';
  const signature = `<table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;color:#27304e;font-size:13px"><tr><td style="padding-right:${horizontal ? 18 : 8}px;vertical-align:middle">${image}</td><td style="padding-left:${horizontal ? 18 : 8}px;${horizontal ? 'border-left:2px solid #02abe0;' : ''}line-height:1.6">${contacts}</td></tr></table>`;
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#27304e;line-height:1.6">' +
    escape(answer).split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('') + '</div>' + signature;
  const text = answer + SIGNOFF + '\nhttps://www.alphasourceai.com/\nmailto:support@alphasourceai.com';
  return { text, html, inlineImage: { cid: option.cid, contentType: 'image/png', bytes }, sendable: false };
}

function supportEmailSignatureOptions() {
  return [{ id: 'brand-horizontal', label: 'Body template — horizontal logo', default: true },
    { id: 'compact-symbol', label: 'Footer template — compact symbol', default: false }];
}
module.exports = { renderSupportEmailPreview, supportEmailSignatureOptions };
