import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {preparePackagedAnalysisRuntime} from '../analysis-runtime.mjs';

test('analysis runtime writes stay outside signed bundle; cache rejects tampering and unexpected code',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-analysis-runtime-'));
 try {
  const bundleRoot=path.join(temp,'signed'),cacheBase=path.join(temp,'cache');fs.mkdirSync(cacheBase);
  const files={'support/analyzeHeadless':'inert launcher fixture','Ghidra/Processors/Test/data/languages/test.sla':'inert language fixture','Ghidra/Processors/Test/data/languages/test.slaspec':'inert language source fixture'};
  const records=[];
  for(const [rel,text] of Object.entries(files)){const file=path.join(bundleRoot,'tools/ghidra',rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode:0o600});records.push({path:'tools/ghidra/'+rel,size:Buffer.byteLength(text),mode:0o600,sha256:crypto.createHash('sha256').update(text).digest('hex')});}
  const manifest=path.join(bundleRoot,'BUNDLE.json');fs.writeFileSync(manifest,JSON.stringify({schema:'scripture-armor.standalone-bundle/1',files:records}));
  fs.mkdirSync(path.join(bundleRoot,'tools/ghidra/empty-extension-directory'));
  const runtime=preparePackagedAnalysisRuntime({bundleRoot,cacheBase});
  assert(!runtime.startsWith(bundleRoot));assert.equal(fs.statSync(runtime).mode&0o777,0o700);
  const compiled=fs.statSync(path.join(runtime,'Ghidra/Processors/Test/data/languages/test.sla')).mtimeMs;
  const source=fs.statSync(path.join(runtime,'Ghidra/Processors/Test/data/languages/test.slaspec')).mtimeMs;
  assert(compiled>0&&compiled>=source,'copy order must not make unchanged sources trigger recompilation');
  const lock='Ghidra/Processors/Test/data/languages/test.sla.lock';fs.writeFileSync(path.join(runtime,lock),'');
  assert.equal(fs.existsSync(path.join(bundleRoot,'tools/ghidra',lock)),false);
  assert.equal(preparePackagedAnalysisRuntime({bundleRoot,cacheBase}),runtime);
  fs.writeFileSync(path.join(runtime,'support/unexpected-plugin.jar'),'inert');assert.throws(()=>preparePackagedAnalysisRuntime({bundleRoot,cacheBase}),/Unexpected/);fs.rmSync(path.join(runtime,'support/unexpected-plugin.jar'));
  fs.writeFileSync(path.join(runtime,'support/analyzeHeadless'),'tampered');assert.throws(()=>preparePackagedAnalysisRuntime({bundleRoot,cacheBase}),/integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(bundleRoot,'tools/ghidra/support/analyzeHeadless'),'utf8'),files['support/analyzeHeadless']);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('cache alias and malicious manifest traversal fail closed before writes',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-analysis-alias-'));
 try {
  const bundleRoot=path.join(temp,'signed'),cacheBase=path.join(temp,'cache');fs.mkdirSync(bundleRoot);fs.mkdirSync(cacheBase);
  const manifest=path.join(bundleRoot,'BUNDLE.json');fs.writeFileSync(manifest,JSON.stringify({schema:'scripture-armor.standalone-bundle/1',files:[{path:'tools/ghidra/../../outside',size:0,mode:0o600,sha256:'a'.repeat(64)}]}));
  assert.throws(()=>preparePackagedAnalysisRuntime({bundleRoot,cacheBase}),/Invalid/);assert.equal(fs.existsSync(path.join(cacheBase,'Ronin Inc')),false);
  fs.writeFileSync(manifest,JSON.stringify({schema:'scripture-armor.standalone-bundle/1',files:[{path:'tools/ghidra/safe',size:0,mode:0o600,sha256:'a'.repeat(64)}]}));
  fs.symlinkSync(bundleRoot,path.join(cacheBase,'Ronin Inc'));assert.throws(()=>preparePackagedAnalysisRuntime({bundleRoot,cacheBase}),/not an alias/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
