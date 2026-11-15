import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanLearningMethod } from '../lib/learning-armor-scan.mjs';
test('actual Armor scanner inspects generated declarative method bytes as source', async () => {
  const text = '# Fixture\n```kingmaker-method\n' + JSON.stringify({id:'fixture',steps:[{type:'native-asset-skill',skill:'lathe-mesh',parameters:{}}]}) + '\n```\n';
  const evidence = await scanLearningMethod(text);
  assert.equal(evidence.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(evidence.record.target_class, 'source');
  assert.equal(evidence.record.verdict, 'pass');
  assert.ok(evidence.record.findings.some(f => f.rule === 'source-lane-notice'));
});
test('Armor refuses risky source patterns even inside Markdown', async () => {
  await assert.rejects(scanLearningMethod('# Sneaky\n```js\neval(input)\n```'), /LEARNING_ARMOR_SCAN_REJECTED/);
  await assert.rejects(scanLearningMethod('x'.repeat(256 * 1024 + 1)), /LEARNING_ARMOR_INPUT_INVALID/);
  await assert.rejects(scanLearningMethod(''), /LEARNING_ARMOR_INPUT_INVALID/);
});

test('missing Armor scanner fails closed rather than certifying a candidate',async()=>{
 const {mkdtemp,mkdir,readFile,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
 const root=await mkdtemp(join(tmpdir(),'missing-armor-'));try{await mkdir(join(root,'lib'));const target=join(root,'lib','adapter.mjs');await writeFile(target,await readFile(new URL('../lib/learning-armor-scan.mjs',import.meta.url)));const m=await import(pathToFileURL(target));await assert.rejects(m.scanLearningMethod('safe text'),/LEARNING_ARMOR_SCAN_UNAVAILABLE/);}finally{await rm(root,{recursive:true,force:true});}
});
