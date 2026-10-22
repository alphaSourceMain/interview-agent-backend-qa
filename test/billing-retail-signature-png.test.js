'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),{loadImage,createCanvas}=require('@napi-rs/canvas');
const {parseRetailSignature}=require('../src/services/retailSignaturePng');
const {signature,png,chunk,dataUrl,magic}=require('./fixtures/retail-signature');
const safari=require('./fixtures/safari-canvas-signature.json');
function chunks(bytes){const out=[];for(let at=8;at<bytes.length;){const n=bytes.readUInt32BE(at);out.push({type:bytes.toString('ascii',at+4,at+8),data:bytes.subarray(at+8,at+8+n)});at+=n+12;}return out;}
const fromChunks=parts=>Buffer.concat([magic,...parts.map(({type,data})=>chunk(type,data))]);
test('actual Safari canvas PNG with eXIf normalizes to the identical pixels and metadata-free RGBA image',async()=>{
  const source=Buffer.from(safari.dataUrl.split(',')[1],'base64'),parts=chunks(source);
  assert.deepEqual(parts.map(p=>p.type),['IHDR','sRGB','eXIf','IDAT','IEND']);
  assert.equal(parts.find(p=>p.type==='eXIf').data.length,68);
  const parsed=parseRetailSignature(safari.dataUrl),without=parseRetailSignature(dataUrl(fromChunks(parts.filter(p=>p.type!=='eXIf'))));
  assert.equal(parsed.width,safari.width);assert.equal(parsed.height,safari.height);
  assert.deepEqual(chunks(parsed.bytes).map(p=>p.type),['IHDR','IDAT','IEND']);
  assert.deepEqual(parsed.bytes,without.bytes);assert.equal(parsed.pixels_sha256,without.pixels_sha256);
  const a=await loadImage(source),b=await loadImage(parsed.bytes);
  const pixels=image=>{const c=createCanvas(image.width,image.height),x=c.getContext('2d');x.drawImage(image,0,0);return x.getImageData(0,0,image.width,image.height).data;};
  assert.deepEqual(pixels(a),pixels(b));assert.equal(parseRetailSignature(parsed.dataUrl).sha256,parsed.sha256);
});
test('EXIF is opaque and stripped; exact size bounds and identical canonical output enforced',()=>{
  const old=parseRetailSignature(dataUrl(png()));
  for(const n of [1,68,65536]){
    const result=parseRetailSignature(dataUrl(png({extra:[chunk('eXIf',Buffer.alloc(n,0xff))]})));
    assert.deepEqual(result.bytes,old.bytes);assert.equal(result.sha256,old.sha256);assert.equal(result.pixels_sha256,old.pixels_sha256);
  }
  for(const n of [0,65537])assert.throws(()=>parseRetailSignature(dataUrl(png({extra:[chunk('eXIf',Buffer.alloc(n))]}))),e=>e.code==='signature_invalid');
});
test('EXIF before header, after IDAT, duplicated or corrupt remains rejected',()=>{
  const parts=chunks(png()),exif={type:'eXIf',data:Buffer.from('opaque')};
  for(const order of [[exif,...parts],[parts[0],parts[1],exif,parts[2]],[parts[0],exif,exif,...parts.slice(1)]])
    assert.throws(()=>parseRetailSignature(dataUrl(fromChunks(order))),e=>e.code==='signature_invalid');
  const corrupt=png({extra:[chunk('eXIf',Buffer.from('opaque'))]});corrupt[44]^=1;
  assert.throws(()=>parseRetailSignature(dataUrl(corrupt)),e=>e.code==='signature_invalid');
});
test('EXIF cannot rescue blank, invalid-filter, or overflowing image data',()=>{
  const extra=[chunk('eXIf',Buffer.from('opaque'))];
  for(const bytes of [png({extra,width:1,height:1,pixels:Buffer.from([255,255,255,255])}),
    png({extra,rawChange:r=>{r[0]=5;return r;}}),png({extra,rawChange:r=>Buffer.concat([r,Buffer.from([0])])})])
    assert.throws(()=>parseRetailSignature(dataUrl(bytes)),e=>e.code==='signature_invalid');
});
test('native canvas signature decodes/reencodes and strips sBIT/sRGB; independent native pixels preserved',async()=>{
  const input=signature(),p=parseRetailSignature(input),a=await loadImage(Buffer.from(input.split(',')[1],'base64')),b=await loadImage(p.bytes);
  const pixels=image=>{const c=createCanvas(image.width,image.height),x=c.getContext('2d');x.drawImage(image,0,0);return [...x.getImageData(0,0,image.width,image.height).data];};
  assert.deepEqual(pixels(a),pixels(b));assert.equal(p.width,300);assert.equal(p.height,100);
  assert.equal(p.bytes.includes(Buffer.from('sBIT')),false);assert.equal(p.bytes.includes(Buffer.from('sRGB')),false);
  assert.equal(parseRetailSignature(p.dataUrl).sha256,p.sha256);assert.equal(parseRetailSignature(p.dataUrl).pixels_sha256,p.pixels_sha256);
});
test('all five PNG filters give same independently decoded pixel identity and canonical bytes',()=>{
  const parsed=[0,1,2,3,4].map(filter=>parseRetailSignature(dataUrl(png({filter}))));
  assert.equal(new Set(parsed.map(p=>p.pixels_sha256)).size,1);assert.equal(new Set(parsed.map(p=>p.sha256)).size,1);
  // Captured with the pre-fix decoder at QA baseline 8d3a75b0.
  for(const p of parsed){
    assert.equal(p.sha256,'b51740d431e911b25a0b9cce23bd736ce6b50037dad0108412fb6c1d10502dc4');
    assert.equal(p.pixels_sha256,'f8ea441abf36b79c57e9372a772b9e92efe52913328dc3935a665d829908f78b');
  }
});
test('strict MIME/base64, byte cap, corruption/truncation/trailing content are rejected',()=>{
  const valid=dataUrl(png());for(const value of [null,'',valid.replace('image/png','image/jpeg'),valid+'=',valid+'\n',valid.replace(';base64,',';base64, '),
    dataUrl(Buffer.concat([png(),Buffer.from('extra')])),dataUrl(png().subarray(0,-1)),dataUrl(Buffer.from('not a png')),'x'.repeat(2097153)])
    assert.throws(()=>parseRetailSignature(value),e=>e.code==='signature_invalid');
  const bad=png();bad[bad.length-1]^=1;assert.throws(()=>parseRetailSignature(dataUrl(bad)),e=>e.code==='signature_invalid');
});
test('unknown, compressed/text, animation and duplicate header chunks held even with valid CRC',()=>{
  for(const t of ['iCCP','tEXt','zTXt','iTXt','acTL','fcTL','fdAT','ABCD','IHDR'])
    assert.throws(()=>parseRetailSignature(dataUrl(png({extra:[chunk(t,Buffer.from('x'))]}))),e=>e.code==='signature_invalid');
});
test('dimension limits checked before inflate; wrong filter/overflow/underflow held',()=>{
  const base=png(),header=Buffer.from(base.subarray(16,29));header.writeUInt32BE(0xffffffff);
  const large=Buffer.concat([magic,chunk('IHDR',header),base.subarray(33)]);
  for(const b of [large,png({rawChange:r=>{r[0]=5;return r;}}),png({rawChange:r=>Buffer.concat([r,Buffer.from([0])])}),png({rawChange:r=>r.subarray(0,-1)})])
    assert.throws(()=>parseRetailSignature(dataUrl(b)),e=>e.code==='signature_invalid');
});
test('every compressed IDAT byte must be consumed; trailing compressed stream or garbage held',()=>{
  const base=png();for(const extra of [Buffer.from([1,2,3]),require('node:zlib').deflateSync(Buffer.from('extra'))]){
    let o=8;const parts=[magic];while(o<base.length){const n=base.readUInt32BE(o),type=base.subarray(o+4,o+8).toString(),data=base.subarray(o+8,o+8+n);
      parts.push(chunk(type,type==='IDAT'?Buffer.concat([data,extra]):data));o+=n+12;}
    assert.throws(()=>parseRetailSignature(dataUrl(Buffer.concat(parts))),e=>e.code==='signature_invalid');
  }
});
test('transparent/white/too-low-alpha samples are blank; stated dark RGBA threshold accepted',()=>{
  for(const rgba of [[0,0,0,0],[255,255,255,255],[20,20,20,31],[231,20,20,255]])
    assert.throws(()=>parseRetailSignature(dataUrl(png({width:1,height:1,pixels:Buffer.from(rgba)}))),e=>e.code==='signature_invalid');
  assert.equal(parseRetailSignature(dataUrl(png({width:1,height:1,pixels:Buffer.from([230,230,230,32])}))).width,1);
});
