import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createIndexedWeightSelector,createProductionIndexedWeightSelector} from '../lib/indexed-weight-selector.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const model=(tag)=>({tag,weights:{sha256:sha(tag)},bench:[{fits:true,tools:90,route:90,write:90,tokS:30}]});
const library={models:[model('one'),model('two')]};
const raw=JSON.stringify({schema:'kingmaker.weight-index/1',candidates:library.models.map(m=>({tag:m.tag,sha256:m.weights.sha256}))});
const evidence={search:async()=> 'b1',receipt:async()=>({text:raw,sha256:sha(raw)})};
const response={answers:{weight_model:{probabilities:{one:0.95,two:0.05},answer:'one'}}};
test('bounded metadata selection and exact request reuse skip second scoring, never read weights',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'indexed-'));let scores=0;
 try{const select=createIndexedWeightSelector({evidence,registryDir:dir,scorerIdentity:'test-pinned',score:async()=>{scores++;return response;}});
 const a=await select({text:'write a story',library,installed:['one','two']}),b=await select({text:'write a story',library,installed:['one','two']});assert.equal(scores,1);assert.equal(a.receipt.reused,false);assert.equal(b.receipt.reused,true);assert.equal(b.receipt.weightBytesRead,0);assert.equal(b.library.models[0].tag,'one');
 await select({text:'write another story',library,installed:['one','two']});assert.equal(scores,2);
 const path=join(dir,a.receipt.key+'.json'),r=JSON.parse(await readFile(path));r.selected='two';await writeFile(path,JSON.stringify(r));await select({text:'write a story',library,installed:['one','two']});assert.equal(scores,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('unavailable evidence and changed pin fail closed before scorer',async()=>{
 for(const e of [{search:async()=>{throw Error('offline')},receipt:evidence.receipt},{search:evidence.search,receipt:async()=>({text:raw,sha256:'bad'})}]){
 const s=createIndexedWeightSelector({evidence:e,scorerIdentity:'test',score:async()=>{throw Error('should not score')}});await assert.rejects(s({text:'write a story',library,installed:['one','two']}));}
 const changed={models:library.models.map(m=>({...m,weights:{sha256:sha('changed')}}))};const s=createIndexedWeightSelector({evidence,scorerIdentity:'test',score:async()=>response});await assert.rejects(s({text:'write a story',library:changed,installed:['one','two']}),/shortlist empty/);
});
test('scorer cannot invent tags or return low confidence',async()=>{
 for(const probabilities of [{outside:1},{one:0.5,two:0.5}]){const s=createIndexedWeightSelector({evidence,scorerIdentity:'test',score:async()=>({answers:{weight_model:{probabilities}}})});await assert.rejects(s({text:'write a story',library,installed:['one','two']}));}
});
test('production opt-in requires bound Bili and explicitly local OpenJEV; default inert',()=>{
 assert.equal(createProductionIndexedWeightSelector({env:{}}),null);
 assert.throws(()=>createProductionIndexedWeightSelector({env:{KINGMAKER_WEIGHT_INDEX:'on'}}),/Bili/);
 assert.throws(()=>createProductionIndexedWeightSelector({env:{KINGMAKER_WEIGHT_INDEX:'on',BILI_MCP_PROXY:'x',BILI_CONVERSATION_ID:'x',KINGMAKER_OPENJEV_MODEL:'open-jev',KINGMAKER_OPENJEV_REVISION:'a'.repeat(64),KINGMAKER_OPENJEV_ENDPOINT:'https://external.example'}}),/loopback/);
});
test('retrieval policy removes remote candidates before scorer, and revalidates before reuse',async()=>{
 let calls=0;const select=createIndexedWeightSelector({evidence,scorerIdentity:'test',score:async payload=>{calls++;assert.deepEqual(payload.questions.weight_model.options,['two']);return {answers:{weight_model:{probabilities:{two:1},answer:'two'}}};}});
 assert.equal((await select({text:'write a story',library,installed:['two']})).receipt.selected,'two');
 await assert.rejects(select({text:'write a story',library}),/retrieval policy/);assert.equal(calls,1);
});
test('OpenJEV HTTP client prohibits redirects and bounds stream before buffering',async()=>{
 const {createLocalOpenJevScorer}=await import('../lib/indexed-weight-selector.mjs');let cancel=false,reads=0;
 const scorer=createLocalOpenJevScorer({url:new URL('http://127.0.0.1:1234'),model:'open-jev',fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error');return new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(33000));},cancel(){cancel=true;}}));}});
 await assert.rejects(scorer({}),/byte budget/);assert.equal(cancel,true);assert.ok(reads<=3);
});
