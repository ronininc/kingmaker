import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reviewUploadedFile} from '../sandbox-review.mjs';
import {createOriginalEjection,reviewSource} from '../review-ejection.mjs';
test('inert dangerous-code fixture is flagged, explained and ejected without executing it', {skip:process.platform!=='darwin',timeout:30000},async()=>{
  // This is source text only: it computes a constant if run. It is never run.
  const text=['ev','al'].join('')+'("1+1");';
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-ejection-original-')),original=path.join(temp,'inert.js');
  fs.writeFileSync(original,text);
  try{
    const before=new Set(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('armor-review-')));
    const rejected=await reviewUploadedFile(Buffer.from(text),'inert.js');
    assert.equal(rejected.disposition,'ejected');assert.equal(rejected.risk.level,'high');assert.equal(rejected.preview,null);
    assert.match(rejected.announcement,/Runs code assembled from text/);assert.match(rejected.announcement,/Danger rating: HIGH/);
    assert.equal(rejected.targetExecuted,false);assert.equal(rejected.commandAuthority,false);
    assert.equal(rejected.isolation.workspaceDestroyedOnReturn,true);assert.equal(rejected.isolation.originalFileRemoved,false);
    assert.equal(rejected.isolation.ownerKeysCopied,false);assert.equal(fs.readFileSync(original,'utf8'),text);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('armor-review-')&&!before.has(n)),[]);
    const fresh=await reviewUploadedFile(Buffer.from('{"fresh":true}'),'fresh.json');
    assert.notEqual(fresh.isolation.reviewId,rejected.isolation.reviewId);assert.notEqual(fresh.isolation.policySha256,rejected.isolation.policySha256);
    assert.equal(fresh.disposition,'reviewed');assert.match(fresh.preview.text,/fresh/);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('native original ejection removes only the reviewed unchanged fixture, once', {skip:process.platform!=='darwin',timeout:30000},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-original-ejection-')),identityDir=path.join(temp,'identity'),original=path.join(temp,'fixture.js');
  const content=['ev','al'].join('')+'("1+1");';fs.writeFileSync(original,content);
  try{
    const source=reviewSource(original,{identityDir}),review=await reviewUploadedFile(source.bytes,'fixture.js');source.bytes.fill(0);
    const registry=createOriginalEjection({identityDir}),id=registry.register(source,review);assert.ok(id);
    assert.equal(registry.register(source,{...review,contentSha256:'0'.repeat(64)}),null);
    assert.equal(registry.register(source,{...review,format:'Sensitive key material'}),null);
    const result=registry.eject(id);assert.equal(result.originalFileRemoved,true);assert.equal(fs.existsSync(original),false);
    assert.match(result.announcement,/Unknown copies, backups/);assert.throws(()=>registry.eject(id),/already used/);
    fs.writeFileSync(original,content);const changed=reviewSource(original,{identityDir}),changedId=registry.register(changed,review);changed.bytes.fill(0);
    fs.writeFileSync(original,'changed fixture');assert.throws(()=>registry.eject(changedId),/changed/);assert.equal(fs.readFileSync(original,'utf8'),'changed fixture');
    const alias=path.join(temp,'alias');fs.symlinkSync(original,alias);assert.throws(()=>reviewSource(alias,{identityDir}),/symlink/);
    const cleared=registry.register(source,review);registry.clear();assert.throws(()=>registry.eject(cleared),/expired|already used/);
    const hard=path.join(temp,'hard');fs.linkSync(original,hard);assert.throws(()=>reviewSource(original,{identityDir}),/single-link/);
    assert.deepEqual(fs.readdirSync(temp).filter(p=>p.startsWith('.armor-ejection-')),[]);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
test('webpage content is text-only and unknown data never receives a safety guarantee', {skip:process.platform!=='darwin',timeout:30000},async()=>{
  const html=Buffer.from('<html><body><h1>Visible fixture</h1><script>globalThis.inert=true</script><img src="https://never-request.invalid/pixel"></body></html>');
  const result=await reviewUploadedFile(html,'page.html');
  assert.equal(result.targetExecuted,false);assert.equal(result.preview.mode,'inert-text');assert.equal(result.preview.markupRemoved,true);
  assert.match(result.preview.text,/Visible fixture/);assert.doesNotMatch(result.preview.text,/<img|<script|never-request/);
});
