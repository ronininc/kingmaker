import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheCandidatesForTask,beforeModelSelection} from '../lib/weight-hunter.mjs';
const model=(tag,score)=>({tag,slug:tag,weights:{sha256:'a'.repeat(64),gguf:'x.gguf',parts:[{size:4}]},bench:[{fits:true,tokS:100,tools:score,route:score,write:score}]});
const library={models:[model('winner',90),...Array.from({length:100},(_,i)=>model(`other${i}`,30))]};
test('101 model catalog probes only winning score and ensures only one model',async()=>{
 const candidates=cacheCandidatesForTask({text:'write a story',library});assert.deepEqual(candidates.map(x=>x.tag),['winner']);
 const ensures=[];const r=await beforeModelSelection({text:'write a story',library,calibration:{weightHunter:{on:true}},allowDownload:true,ensure:async p=>ensures.push(p.tag)});
 assert.equal(r.model,'winner');assert.deepEqual(ensures,['winner']);
});
test('installed winner needs no cache probes or materialization',async()=>{
 assert.deepEqual(cacheCandidatesForTask({text:'write a story',library,installed:['winner']}),[]);
 let ensures=0;await beforeModelSelection({text:'write a story',library,installed:['winner'],calibration:{weightHunter:{on:true}},ensure:async()=>ensures++});assert.equal(ensures,0);
});
test('ties retain cache preference; irrelevant lane avoids probing',()=>{
 const tied={models:[model('one',90),model('two',90),model('lower',2)]};
 assert.deepEqual(cacheCandidatesForTask({text:'write a story',library:tied}).map(x=>x.tag),['one','two']);
 assert.deepEqual(cacheCandidatesForTask({text:'open https://example.com',library:tied}),[]);
});
test('disabled hunter does not load catalog or ensure weights',async()=>{
 const bad=async()=>{throw new Error('unexpected I/O');};const r=await beforeModelSelection({text:'write',calibration:{},loadLibrary:bad,ensure:bad});assert.equal(r.enabled,false);
});
test('verified cached selected GGUF transfers zero remote bytes',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');const {materializeLibraryModel}=await import('../lib/brain-library-fetch.mjs');
 const dir=await mkdtemp(join(tmpdir(),'weight-cache-'));let requests=0;
 try{const bytes=Buffer.from('GGUF');const sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(dir,'fixture.gguf'),bytes);await writeFile(join(dir,'Modelfile'),'FROM "fixture.gguf"\n');
 const r=await materializeLibraryModel({tag:'fixture',weights:{gguf:'fixture.gguf',size:4,sha256,parts:[{name:'fixture.gguf',size:4,sha256}]}},{dir,create:false,fetchImpl:async()=>{requests++;throw Error('unexpected network');}});
 assert.equal(requests,0);assert.equal(r.transport,'cached-file');assert.equal(r.streamedToOllama,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('default hunter never ensures missing weights',async()=>{
 let ensured=0;const r=await beforeModelSelection({text:'write a story',library,calibration:{weightHunter:{on:true}},ensure:async()=>ensured++});assert.equal(ensured,0);assert.equal(r.reason,'weights-not-local-download-disabled');
});
test('offline materializer refuses absent weights without network',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {materializeLibraryModel}=await import('../lib/brain-library-fetch.mjs');const dir=await mkdtemp(join(tmpdir(),'offline-weights-'));let calls=0;
 try{await assert.rejects(materializeLibraryModel({...library.models[0],weights:{...library.models[0].weights,size:4}},{dir,offline:true,fetchImpl:async()=>{calls++;throw Error('network');}}),/download disabled/);assert.equal(calls,0);}finally{await rm(dir,{recursive:true,force:true});}
});
test('pause policy is reversible and blocked hunter carries no fallback model',async()=>{
 const {normalize}=await import('../lib/calibration.mjs');
 assert.equal(normalize({}).weightHunter.retrievalPolicy,'local-only');
 assert.equal(normalize({weightHunter:{retrievalPolicy:'approved-download'}}).weightHunter.retrievalPolicy,'approved-download');
 const r=await beforeModelSelection({text:'write a story',library,profileModel:'unwanted-fallback',calibration:{weightHunter:{on:true}}});assert.equal(r.blocked,true);assert.equal(r.model,null);
});

test('local-only ranks available models before inference without materializing remote winner', async()=>{
 const l={models:[model('remote',100),model('local',80),model('cached',90)]};let ensured=[];
 const r=await beforeModelSelection({text:'write a story',library:l,installed:['local'],cached:['cached'],calibration:{weightHunter:{on:true}},ensure:async p=>ensured.push(p.tag)});
 assert.equal(r.model,'cached');assert.equal(r.availability,'cached');assert.deepEqual(ensured,['cached']);assert.equal(r.swap,false);
 const only=await beforeModelSelection({text:'write a story',library:l,installed:['local'],calibration:{weightHunter:{on:true}},ensure:async()=>{throw Error('unexpected ensure')}});assert.equal(only.model,'local');
});
test('local-only cache candidates include locally cached alternatives below remote score',()=>{
 const l={models:[model('remote',100),model('cached',90),model('local',80),model('lower',20)]};
 assert.deepEqual(cacheCandidatesForTask({text:'write a story',library:l,installed:['local'],allowDownload:false}).map(m=>m.tag),['remote','cached']);
});
test('execution loop honors the same local-only selection',async()=>{
 const {executionLoopBeforeWeights}=await import('../lib/weight-hunter.mjs');
 const hook=executionLoopBeforeWeights({library:{models:[model('remote',100),model('local',80)]},installed:['local'],calibration:{weightHunter:{on:true}},ensure:async()=>{throw Error('unexpected ensure')}});
 const r=await hook({request:'write a story',records:[]});assert.equal(r.model,'local');
});
