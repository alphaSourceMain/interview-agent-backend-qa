const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { SIGNOFF } = require('../src/lib/supportEmailPolicy');
const { renderSupportEmailPreview: render, supportEmailSignatureOptions: options } = require('../src/lib/supportEmailPreview');
const sourceFile = path.join(__dirname, '../src/lib/supportEmailPreview.js');
const assetDir = path.join(__dirname, '../src/lib/support-email-assets');
const body = 'Thanks for contacting alphaSource.\n\nHere is general guidance.' + SIGNOFF;

for (const [id, hash, cid] of [
  ['brand-horizontal','0eba097b8e2348be37da3d339bab0b00d0d8253cc42ac8fbb5a085203799e07d','alphy-horizontal@alphasourceai.com'],
  ['compact-symbol','bd82c2b32e904ed07701480fae0b862d1ab484dc1ace9581df74e9fd1aca2f0e','alphy-compact@alphasourceai.com'],
]) test(`${id} uses exact approved master, identity and fixed preview-only output`, () => {
  const r = render(body, id);
  assert.deepEqual(Object.keys(r).sort(), ['html','inlineImage','sendable','text']);
  assert.equal(r.sendable, false);
  assert.deepEqual(Object.keys(r.inlineImage).sort(), ['bytes','cid','contentType']);
  assert.equal(r.inlineImage.cid, cid); assert.equal(r.inlineImage.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(r.inlineImage.bytes)); assert.equal(createHash('sha256').update(r.inlineImage.bytes).digest('hex'), hash);
  assert.equal((r.html.match(/<img /g) || []).length, 1);
  assert.ok(r.html.includes(`src="cid:${cid}"`));
  for (const value of ['alphy','AI support assistant','alphaSource','https://www.alphasourceai.com/','mailto:support@alphasourceai.com']) {
    assert.ok(r.text.includes(value)); assert.ok(r.html.includes(value));
  }
  assert.doesNotMatch(r.html, /<script|<style|\son\w+=|src="https?:|srcset|url\(|@import|data:/i);
  assert.doesNotMatch(r.html, /Founder|Global Admin|Jason Gardner|720|303/);
});
test('default is horizontal; metadata is fresh and contains both options', () => {
  assert.deepEqual(render(body), render(body, 'brand-horizontal'));
  assert.deepEqual(options().map(o => [o.id, o.default]), [['brand-horizontal',true],['compact-symbol',false]]);
  const o=options();o[0].id='override';assert.equal(options()[0].id,'brand-horizontal');
});
test('untrusted answer is escaped text, never HTML, CSS or an automatic link', () => {
  const answer='Hi Jason, <script>alert("x")</script> & <img src="https://tracker.invalid" onerror="x">\nhttps://tracker.invalid';
  const r=render(answer+SIGNOFF);
  assert.ok(r.html.includes('&lt;script&gt;'));assert.ok(r.html.includes('&amp;'));assert.ok(r.html.includes('Hi Jason,'));
  assert.equal((r.html.match(/<a /g)||[]).length,2);assert.doesNotMatch(r.html, /<script|<img src="https|href="https:\/\/tracker/);
  assert.ok(r.html.includes('<br>https://tracker.invalid'));
});
test('buffer mutation cannot change a later master or preview', () => {
  const first=render(body);first.inlineImage.bytes.fill(0);assert.equal(render(body).inlineImage.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
});
for (const id of [null, '', 'unknown','constructor','__proto__',0,{},['brand-horizontal']]) test(`reject invalid signature ${JSON.stringify(id)}`,()=>{
  assert.throws(()=>render(body,id),{message:'SUPPORT_EMAIL_PREVIEW_SIGNATURE'});
});
for (const bad of [undefined,null,{},'','answer','answer'+SIGNOFF+' ',SIGNOFF, ' '+SIGNOFF, body+SIGNOFF,
  'a'.repeat(4001)+SIGNOFF, 'é'.repeat(2001)+SIGNOFF, '\ud800'+SIGNOFF, '\udc00'+SIGNOFF]) test(`reject malformed body ${typeof bad}/${String(bad).length}`,()=>{
  assert.throws(()=>render(bad),{message:'SUPPORT_EMAIL_PREVIEW_BODY'});
});
for (const code of [0,1,9,11,12,13,31,127,128,159,0x200b,0x200c,0x200d,0x200e,0x200f,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069,0xfeff]) test(`reject control/visual spoof U+${code.toString(16)}`,()=>{
  assert.throws(()=>render('answer'+String.fromCodePoint(code)+SIGNOFF),{message:'SUPPORT_EMAIL_PREVIEW_BODY'});
});
test('UTF8 byte boundary, LF, and well-formed Unicode remain supported',()=>{
  assert.ok(render('é'.repeat(2000)+SIGNOFF));assert.ok(render('🙂\nHello'+SIGNOFF));assert.ok(render('a'.repeat(4000)+SIGNOFF));
});

function fixture(change) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'alphy-preview-test-'));
  try {
    fs.cpSync(assetDir,path.join(dir,'support-email-assets'),{recursive:true});
    change(path.join(dir,'support-email-assets','horizontal.png'));
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(sourceFile,'utf8'),{module,exports:module.exports,__dirname:dir,Buffer,
      require:name=>name==='./supportEmailPolicy'?{SIGNOFF}:require(name)});
    assert.throws(()=>module.exports.renderSupportEmailPreview(body),error=>error.message==='SUPPORT_EMAIL_PREVIEW_ASSET');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); } // Only this test's freshly created leaf.
}
test('tampered asset rejected before output',()=>fixture(file=>{const b=fs.readFileSync(file);b[100]^=1;fs.writeFileSync(file,b);}));
test('oversized asset rejected before output',()=>fixture(file=>fs.writeFileSync(file,Buffer.alloc(1024*1024+1))));
test('invalid dimensions rejected before output',()=>fixture(file=>{const b=fs.readFileSync(file);b.writeUInt32BE(1,16);fs.writeFileSync(file,b);}));
test('asset symlink rejected',()=>fixture(file=>{fs.unlinkSync(file);fs.symlinkSync(path.join(assetDir,'horizontal.png'),file);}));
test('asset directory symlink rejected',()=>fixture(file=>{const dir=path.dirname(file);fs.rmSync(dir,{recursive:true});fs.symlinkSync(assetDir,dir);}));
test('no socket, provider or mail transport exports',()=>{
  assert.deepEqual(Object.keys(require('../src/lib/supportEmailPreview')).sort(),['renderSupportEmailPreview','supportEmailSignatureOptions']);
  assert.equal(render(body).sendable,false);
});
