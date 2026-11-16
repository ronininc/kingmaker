import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSelectiveTensorReader,createLocalTensorRangeSource,createLibraryTensorRangeSource,tensorProviderReadiness} from '../lib/selective-tensor-reader.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from(Array.from({length:256},(_,i)=>i));
const spec={schema:'kingmaker.tensor-ranges/1',source:{id:'tiny-fixture',bytes:256,sha256:hash(bytes)},tensors:[{name:'a',offset:16,length:8,dtype:'F32',shape:[2],dependencies:[],sha256:hash(bytes.subarray(16,24))},{name:'b',offset:128,length:16,dtype:'F32',shape:[4],dependencies:['a'],sha256:hash(bytes.subarray(128,144))},{name:'unused',offset:200,length:8,dtype:'F32',shape:[2],dependencies:[],sha256:hash(bytes.subarray(200,208))}]};
const raw=Buffer.from(JSON.stringify(spec)),pin=hash(raw);
test('real file reads only selected tensor and declared dependency, not entire checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tensor-read-'));let source;
 try{const path=join(dir,'tiny.bin');await writeFile(path,bytes);source=await createLocalTensorRangeSource(path);const reader=createSelectiveTensorReader({manifestBytes:raw,manifestSha256:pin,readRange:source.readRange,chunkBytes:8});const r=await reader.read(['b']);assert.deepEqual(r.receipt.selected,['a','b']);assert.equal(r.receipt.weightBytesRead,24);assert.equal(r.receipt.ranges.length,3);assert.equal(r.receipt.unselectedBytesRead,0);assert.equal(r.receipt.inferenceExecuted,false);assert.deepEqual(r.tensors.b,bytes.subarray(128,144));}finally{await source?.close();await rm(dir,{recursive:true,force:true});}
});
test('remote disabled by default; synthetic range provider validates catalog binding',async()=>{
 const model={weights:{sha256:hash(bytes),size:256}};let calls=0;const fetchRange=async({start,end})=>{calls++;return {start,end,bytes:bytes.subarray(start,end+1)}};
 const disabled=createLibraryTensorRangeSource({model,fetchRange});await assert.rejects(disabled.readRange({start:16,end:23,source:spec.source}),/disabled/);assert.equal(calls,0);
 const source=createLibraryTensorRangeSource({model,allowNetwork:true,fetchRange});const reader=createSelectiveTensorReader({manifestBytes:raw,manifestSha256:pin,readRange:source.readRange});assert.equal((await reader.read(['a'])).receipt.weightBytesRead,8);assert.equal(calls,1);
});
test('wrong pin, corrupted bytes, unknown selection and budget fail',async()=>{
 assert.throws(()=>createSelectiveTensorReader({manifestBytes:raw,manifestSha256:'0'.repeat(64),readRange:()=>{}}),/pin/);
 const reader=createSelectiveTensorReader({manifestBytes:raw,manifestSha256:pin,readRange:async({start,end})=>Buffer.alloc(end-start+1)});await assert.rejects(reader.read(['a']),/digest/);await assert.rejects(reader.read(['nope']),/unknown/);
 const limited=createSelectiveTensorReader({manifestBytes:raw,manifestSha256:pin,maxReadBytes:4,readRange:()=>{throw Error('must not read')}});await assert.rejects(limited.read(['a']),/budget/);
});
test('provider readiness never conflates reading with inference',()=>{assert.equal(tensorProviderReadiness({provider:'ollama',manifestAvailable:true}).inferenceReady,false);assert.equal(tensorProviderReadiness({provider:'local-file'}).selectiveReadSupported,true);});
