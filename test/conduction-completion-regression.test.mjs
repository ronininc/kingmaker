import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMethodConductor } from '../lib/method-conductor.mjs';
import { iterateMethod } from '../lib/method-iteration.mjs';

async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), 'km-conduct-proof-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const spec = {id:'proof', title:'Proof media', domain:'media', inputs:{prompt:'Make a reel'}, steps};
  const readText = async url => String(url).endsWith('index.json')
    ? JSON.stringify({schema:'kingmaker.methods/1',methods:[{id:'proof',title:'Proof',domain:'media',file:'proof.md',quality:{tier:'draft',score:1}}]})
    : '```kingmaker-method\n'+JSON.stringify(spec)+'\n```';
  return {root, conductor:createMethodConductor({indexUrl:'file:///fixture/index.json',readText,toolProvider:null})};
}
test('missing reasoner is incomplete, not a success', async t => {
  const {root,conductor}=await fixture(t,[{id:'think',type:'reason',into:'answer'}]);
  const r=await conductor.conduct('proof',{workDir:root});
  assert.equal(r.status,'incomplete'); assert.equal(r.haltedAt,'think'); assert.equal(r.declared.length,1);
});
test('a real reasoner and written output complete', async t => {
  const {root,conductor}=await fixture(t,[{id:'think',type:'reason',into:'answer'},{id:'write',type:'render',path:'brief.md',template:'{{answer}}'}]);
  let calls=0;
  const r=await conductor.conduct('proof',{workDir:root,reasoner:async()=>{calls++;return 'Measured brief';}});
  assert.equal(r.status,'completed');assert.equal(calls,1);assert.equal(await readFile(join(root,'brief.md'),'utf8'),'Measured brief');
});
test('declared rendering is not promoted by a successful metadata check', async t => {
  const {root,conductor}=await fixture(t,[{id:'render',type:'declare',action:'Render a film'}, {id:'record',type:'write-json',path:'film.json',value:{deliverable:'proof-cut'}}, {id:'verify',type:'verify',assertions:[{file:'film.json',field:'deliverable',exists:true}]}]);
  const r=await conductor.conduct('proof',{workDir:root});assert.equal(r.status,'incomplete');assert.equal(r.trace.at(-1).status,'executed');
});
test('incomplete or declared-only work cannot be iterated as successful defaults',async()=>{
  for(const conduction of [{status:'incomplete',declared:[]},{status:'completed',declared:[{step:'render'}]}])
    await assert.rejects(iterateMethod({methodId:'proof',storeDir:'/unused',conduction}),/cannot learn/);
});
test('the actual shipped cinematic method cannot claim a completed film',async t=>{
 const root=await mkdtemp(join(tmpdir(),'km-film-proof-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'intent.txt'),'Hoid at a desk with holograms, vertical narrated reel');
 const conductor=createMethodConductor({toolProvider:null});
 const r=await conductor.conduct('escapement-film-loop',{workDir:root,reasoner:async()=> 'fixture only: no real generated scene'});
 assert.equal(r.status,'incomplete');assert.ok(r.declared.some(x=>x.step==='render-proof'));
 assert.equal(r.outputs.proofCut,undefined);
});

test('execution loop forwards governed reasoner and supports per-run override',async t=>{
 const {createExecutionLoop}=await import('../lib/execution-loop.mjs');
 const {root,conductor}=await fixture(t,[{id:'think',type:'reason',into:'answer'}]);
 const defaultReasoner=async({model,weights})=> { assert.equal(model,'fixture-model'); assert.equal(weights.model,model); return 'default'; };
 const loop=createExecutionLoop({conductor,reasoner:defaultReasoner,remote:false,sandboxPosture:false,
 reader:{readForSession:async()=>({text:'',parts:[],stats:{partFilesRead:[]}})},
 beforeWeights:async()=>({model:'fixture-model',genTokS:10,loadS:0})});
 const first=await loop.run('proof media',{workDir:root,methodHint:'proof',capacityOverride:'sequential'});
 assert.equal(first.refused,false,JSON.stringify({reason:first.reason,coverage:first.coverage}));assert.equal(first.conduction.status,'completed');assert.equal(first.conduction.outputs.answer,'default');
 const second=await loop.run('proof media',{workDir:root,methodHint:'proof',reasoner:async()=> 'override',capacityOverride:'sequential'});
 assert.equal(second.conduction.outputs.answer,'override');
});

test('film production requires an explicitly approved producer',async t=>{
 const {root,conductor}=await fixture(t,[{id:'film',type:'produce-film',spec:{title:'fixture'}}]);
 const r=await conductor.conduct('proof',{workDir:root});assert.equal(r.status,'incomplete');
});

test('film seam verifies actual bytes and persisted receipt, not merely ok:true',async t=>{
 const {createHash}=await import('node:crypto');
 const {root,conductor}=await fixture(t,[{id:'film',type:'produce-film',spec:{title:'fixture'}}]);
 const bytes='fixture artifact, not a real video';const file='fixture.mp4';await writeFile(join(root,file),bytes);
 const record={status:'completed',deliverable:{path:file,sha256:createHash('sha256').update(bytes).digest('hex'),width:16,height:16,frames:2,duration:1}};
 const recordPath='record.json';await writeFile(join(root,recordPath),JSON.stringify(record));
 const filmProducer=async({spec,workDir})=>{assert.equal(spec.title,'fixture');assert.ok(workDir.endsWith(root.split('/').at(-1)));return {ok:true,file,recordPath,record};};
 const good=await conductor.conduct('proof',{workDir:root,filmProducer});assert.equal(good.status,'completed',good.reason);
 await writeFile(join(root,file),'modified');
 const changed=await conductor.conduct('proof',{workDir:root,filmProducer});assert.equal(changed.status,'failed');assert.match(changed.reason,/hash mismatch/);
});

test('film seam rejects missing metrics and escaped output paths',async t=>{
 const {root,conductor}=await fixture(t,[{id:'film',type:'produce-film',spec:{}}]);
 const bad=await conductor.conduct('proof',{workDir:root,filmProducer:async()=>({ok:true})});assert.equal(bad.status,'failed');
 const escaped=await conductor.conduct('proof',{workDir:root,filmProducer:async()=>({ok:true,file:'/outside/film.mp4',recordPath:'record.json',record:{status:'completed',deliverable:{path:'/outside/film.mp4',sha256:'a'.repeat(64),width:16,height:16,frames:1,duration:1}}})});
 assert.equal(escaped.status,'failed');assert.match(escaped.reason,/escapes the workDir/);
});

test('actual cinematic method passes reasoner JSON into approved producer',async t=>{
 const root=await mkdtemp(join(tmpdir(),'km-film-seam-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'intent.txt'),'Hologram desk proof, no claims of final reel');
 const conductor=createMethodConductor({toolProvider:null});let calls=0;
 const r=await conductor.conduct('escapement-film-loop',{workDir:root,
 reasoner:async()=> ++calls===1 ? 'Bounded procedural proof only' : '```json\n{"schema":"kingmaker.film-plan/1","title":"Data plan"}\n```',
 filmProducer:async({spec})=>{assert.equal(spec.title,'Data plan');return {ok:false,why:'fixture reached producer; no real render'};}});
 assert.equal(calls,2);assert.equal(r.status,'failed');assert.match(r.reason,/fixture reached producer/);
 assert.equal(await readFile(join(root,'BRIEF.md'),'utf8'),'Bounded procedural proof only');
});

test('owner production quality target cannot be erased by model plan or producer',async t=>{
 const {root,conductor}=await fixture(t,[{id:'film',type:'produce-film',spec:{qualityTarget:'procedural-proof'}}]);let invoked=false;
 const r=await conductor.conduct('proof',{workDir:root,filmQualityTarget:'cyberpunk-2077',filmProducer:async()=>{invoked=true;return {ok:true};}});
 assert.equal(r.status,'failed');assert.match(r.reason,/quality target cyberpunk-2077 is unsupported/);assert.equal(invoked,false);
});
