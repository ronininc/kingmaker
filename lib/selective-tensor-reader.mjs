// Select named tensor byte ranges from an externally pinned manifest. No model
// inference, automatic downloads or claims that arbitrary tensor subsets can run.
import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {fetchModelRange} from './brain-library-fetch.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const WIDTH={F32:4,F16:2,BF16:2,I64:8,I32:4,I8:1,U8:1};
export function validateTensorManifest(raw,expectedSha256){
 if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);
 if(raw.length>1024*1024||!HASH.test(expectedSha256??'')||sha(raw)!==expectedSha256)throw Error('tensor manifest pin mismatch or budget exceeded');
 const m=JSON.parse(raw.toString('utf8'));
 if(m.schema!=='kingmaker.tensor-ranges/1'||!m.source?.id||!HASH.test(m.source.sha256??'')||!Number.isSafeInteger(m.source.bytes)||m.source.bytes<1||!Array.isArray(m.tensors)||m.tensors.length>10000)throw Error('invalid tensor manifest');
 const names=new Set();let end=0;
 for(const t of [...m.tensors].sort((a,b)=>a.offset-b.offset)){
  if(typeof t.name!=='string'||!t.name||names.has(t.name)||!HASH.test(t.sha256??'')||!Number.isSafeInteger(t.offset)||!Number.isSafeInteger(t.length)||t.length<1||t.offset<end||!Number.isSafeInteger(t.offset+t.length)||t.offset+t.length>m.source.bytes)throw Error('invalid tensor range');
  if(!WIDTH[t.dtype]||!Array.isArray(t.shape)||!t.shape.length||t.shape.some(x=>!Number.isSafeInteger(x)||x<1)||t.shape.reduce((n,x)=>n*x,WIDTH[t.dtype])!==t.length)throw Error('invalid tensor shape');
  if(!Array.isArray(t.dependencies)||t.dependencies.some(x=>typeof x!=='string'))throw Error('invalid tensor dependency list');
  names.add(t.name);end=t.offset+t.length;
 }
 for(const t of m.tensors)if(t.dependencies.some(x=>!names.has(x)))throw Error('unknown tensor dependency');
 return m;
}
export function createSelectiveTensorReader({manifestBytes,manifestSha256,readRange,maxReadBytes=8*1024*1024,maxTensorBytes=4*1024*1024,chunkBytes=1024*1024}={}){
 const manifest=validateTensorManifest(manifestBytes,manifestSha256);
 if(typeof readRange!=='function'||![maxReadBytes,maxTensorBytes,chunkBytes].every(n=>Number.isSafeInteger(n)&&n>0)||chunkBytes>1024*1024||maxReadBytes>16*1024*1024||maxTensorBytes>16*1024*1024)throw Error('invalid tensor reader budget');
 const byName=new Map(manifest.tensors.map(t=>[t.name,t]));
 return {manifest:structuredClone(manifest),read:async names=>{
  if(!Array.isArray(names)||!names.length||names.length>256)throw Error('invalid tensor selection');
  const selected=new Map(),visiting=new Set();
  function visit(name){if(visiting.has(name))throw Error('tensor dependency cycle');if(selected.has(name))return;const t=byName.get(name);if(!t)throw Error('unknown selected tensor');visiting.add(name);for(const d of t.dependencies)visit(d);visiting.delete(name);selected.set(name,t);}
  names.forEach(visit);const tensors=[...selected.values()],planned=tensors.reduce((n,t)=>n+t.length,0);
  if(planned>maxReadBytes||tensors.some(t=>t.length>maxTensorBytes))throw Error('tensor selection exceeds read budget');
  const outputs=Object.create(null),ranges=[];let fetched=0;
  for(const t of tensors){const pieces=[];
   for(let at=t.offset;at<t.offset+t.length;){const length=Math.min(chunkBytes,t.offset+t.length-at);const bytes=Buffer.from(await readRange({start:at,end:at+length-1,source:manifest.source}));if(bytes.length!==length)throw Error('tensor range length mismatch');pieces.push(bytes);ranges.push({start:at,end:at+length-1,bytes:length});fetched+=length;at+=length;}
   const bytes=Buffer.concat(pieces);if(sha(bytes)!==t.sha256)throw Error('selected tensor digest mismatch');outputs[t.name]=bytes;
  }
  return {tensors:outputs,receipt:{schema:'kingmaker.selective-tensor-read/1',manifestSha256,source:manifest.source.id,checkpointSha256:manifest.source.sha256,requested:[...names],selected:tensors.map(t=>t.name),ranges,weightBytesRead:fetched,checkpointBytes:manifest.source.bytes,unselectedBytesRead:0,verification:'pinned-manifest-selected-tensor-digests',fullCheckpointRehashed:false,inferenceExecuted:false}};
 }};
}
export async function createLocalTensorRangeSource(path){
 const file=await open(path,'r'),initial=await file.stat();if(!initial.isFile()){await file.close();throw Error('tensor source is not a file');}
 return {close:()=>file.close(),readRange:async({start,end,source})=>{const stat=await file.stat();if(stat.size!==source.bytes||stat.size!==initial.size||stat.mtimeMs!==initial.mtimeMs)throw Error('tensor source changed or size mismatch');const buf=Buffer.alloc(end-start+1);const {bytesRead}=await file.read(buf,0,buf.length,start);return buf.subarray(0,bytesRead);}};
}
export function createLibraryTensorRangeSource({model,allowNetwork=false,fetchRange=fetchModelRange,...options}={}){
 return {readRange:async({start,end,source})=>{
  if(!allowNetwork)throw Error('remote tensor reads are disabled');
  if(model?.weights?.sha256!==source.sha256||model?.weights?.size!==source.bytes)throw Error('tensor source does not match catalog');
  const result=await fetchRange({...options,model,start,end,mode:'stream'});
  if(result.start!==start||result.end!==end)throw Error('provider returned different byte range');return result.bytes;
 }};
}
export function tensorProviderReadiness({provider,manifestAvailable=false}={}){
 return {provider,selectiveReadSupported:provider==='local-file'||provider==='github-release-range',manifestRequired:true,manifestAvailable,inferenceReady:false,reason:provider==='ollama'?'Ollama requires a complete local GGUF; selected tensors are not an inference model.':'Selective reads are available only with a pinned tensor manifest; no generic tensor-consumer inference adapter is wired.'};
}
