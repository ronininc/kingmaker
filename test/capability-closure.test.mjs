import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { payloadFiles, EMBEDDED_ARMOR_FILES } from '../lib/payload.mjs';
import { validateProductionCapabilityClosure } from '../scripts/capability-closure.mjs';
function write(file, data) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, data); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-capabilities-'));
  const dir = join(root, 'knowledge-runtime/models/static-embedding');
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: 'F32', shape: [2,2], data_offsets: [0,16] } }));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  write(join(dir,'model.safetensors'), Buffer.concat([size,header,Buffer.alloc(16)]));
  write(join(dir,'tokenizer.json'), JSON.stringify({model:{vocab:{'[UNK]':0,fixture:1}}}));
  write(join(root,'kingmaker-runtime/server/node_modules/playwright-core/browsers.json'), JSON.stringify({browsers:[{name:'chromium-headless-shell',revision:'1228'}]}));
  const shell = join(root,'playwright-browsers/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  write(shell,'#!/bin/sh\nexit 0\n');chmodSync(shell,0o755);
  write(join(root,'app.asar/desktop/headless-server.mjs'),'// fixture dependency-layout marker: SOLOMON_STATIC_EMBEDDING_DIR');
  return {root,dir,shell,check:()=>validateProductionCapabilityClosure(root,{platform:'darwin',arch:'arm64'})};
}
test('production closure requires a parseable shared tensor/tokenizer, pinned executable and launcher wiring', () => {
  const f=fixture();try {const result=f.check();assert.equal(result.embedding.dimensions,2);assert.equal(result.browserRevision,'1228');assert.match(result.scope,/dependency-layout-only/);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('missing or truncated embedding assets and tokenizer mismatch are fatal', () => {
  for (const kind of ['missing','truncated','vocab']) {
    const f=fixture();try {
      if(kind==='missing')rmSync(join(f.dir,'model.safetensors'));
      if(kind==='truncated')writeFileSync(join(f.dir,'model.safetensors'),Buffer.from('bad'));
      if(kind==='vocab')writeFileSync(join(f.dir,'tokenizer.json'),JSON.stringify({model:{vocab:{bad:9}}}));
      assert.throws(f.check,/missing|invalid|vocabulary/);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  }
});
test('wrong browser revision, architecture, permissions and old headless wiring cannot pass production closure', () => {
  for(const kind of ['revision','architecture','permissions','wiring']) {
    const f=fixture();try {
      if(kind==='revision')writeFileSync(join(f.root,'kingmaker-runtime/server/node_modules/playwright-core/browsers.json'),JSON.stringify({browsers:[{name:'chromium-headless-shell',revision:'1229'}]}));
      if(kind==='architecture'){assert.throws(()=>validateProductionCapabilityClosure(f.root,{platform:'darwin',arch:'x64'}),/missing/);continue;}
      if(kind==='permissions')chmodSync(f.shell,0o644);
      if(kind==='wiring')writeFileSync(join(f.root,'app.asar/desktop/headless-server.mjs'),'// previous launcher');
      assert.throws(f.check,/missing|executable|does not resolve/);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  }
});

test('embedded compatibility files carry only the Kingmaker product identity policy', () => {
  const root=mkdtempSync(join(tmpdir(),'kingmaker-product-policy-'));
  try {
    for(const file of EMBEDDED_ARMOR_FILES)write(join(root,'scripture-armor',file),'fixture');
    writeFileSync(join(root,'scripture-armor/product.json'),JSON.stringify({schema:'scripture-armor.product/1',product:'standalone'}));
    assert.throws(()=>payloadFiles(root,['scripture-armor']),/refuses a standalone/);
    writeFileSync(join(root,'scripture-armor/product.json'),JSON.stringify({schema:'scripture-armor.product/1',product:'kingmaker'}));
    const files=payloadFiles(root,['scripture-armor']);assert.equal(files.length,5);assert.ok(files.includes('scripture-armor/product-paths.mjs'));
    assert.ok(!files.some(file=>file.includes('dashboard')||file.includes('account-session')));
  }finally{rmSync(root,{recursive:true,force:true});}
});
