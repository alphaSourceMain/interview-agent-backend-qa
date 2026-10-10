'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

test('authored DOCX raw-text extraction never loads vulnerable CLI formatting dependencies', () => {
  const result=cp.spawnSync(process.execPath,['-e',`
    const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
    const mammoth=require('mammoth');
    const fixture=path.join(path.dirname(require.resolve('mammoth')),'../test/test-data/single-paragraph.docx');
    mammoth.extractRawText({buffer:fs.readFileSync(fixture)}).then(result=>{
      assert.equal(result.value.trim(),'Walking on imported air');
      const loaded=Object.keys(require.cache);
      assert.ok(!loaded.some(p=>/node_modules[\\\\/](argparse|sprintf-js)[\\\\/]|mammoth[\\\\/]bin[\\\\/]/.test(p)));
      process.stdout.write('library-only-pass');
    }).catch(()=>process.exit(1));
  `],{cwd:path.resolve(__dirname,'..'),env:{},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'library-only-pass');
});
test('app uses only mammoth buffer extraction, never its CLI or formatting dependency', () => {
  const root=path.resolve(__dirname,'../src');
  const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):entry.name.endsWith('.js')?[path.join(dir,entry.name)]:[]);
  const callers=walk(root).filter(file=>/require\(['"]mammoth['"]\)/.test(fs.readFileSync(file,'utf8')));
  assert.equal(callers.length,3);
  for(const file of callers){const source=fs.readFileSync(file,'utf8');assert.match(source,/mammoth\.extractRawText\(\{\s*buffer/);assert.doesNotMatch(source,/mammoth\.(convert|embedStyle)|mammoth\/bin|require\(['"](?:argparse|sprintf-js)['"]\)/);}
});
