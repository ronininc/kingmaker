// Colloquial request -> admitted method proposal -> explicit approval -> receipts.
// No implicit model, tool installation, source admission, credentials or CLI bypass.
import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
const MAX_BYTES=128*1024;
const fail=s=>{throw new Error(`native-creation: ${s}`);};
const serial=x=>JSON.stringify(x);
const digest=x=>createHash('sha256').update(serial(x)).digest('hex');
const clone=x=>JSON.parse(serial(x));
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function parse(raw){if(typeof raw==='string'){if(Buffer.byteLength(raw)>MAX_BYTES)fail('plan exceeds budget');raw=JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n/,'').replace(/\n```$/,''));}if(Buffer.byteLength(serial(raw)??'')>MAX_BYTES)fail('plan exceeds budget');return raw;}
function references(value,prior){
 if(!value||typeof value!=='object')return;
 if(Object.hasOwn(value,'$from')){const r=value.$from;if(Object.keys(value).length!==1||!r||Object.keys(r).sort().join(',')!=='output,step'||!prior.has(r.step)||typeof r.output!=='string'||!r.output)fail('invalid or forward output reference');return;}
 for(const [key,v] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))fail('unsafe input key');references(v,prior);}
}
function resolveInputs(value,receipts){
 if(!value||typeof value!=='object')return value;
 if(Object.hasOwn(value,'$from')){const r=value.$from,outputs=receipts.get(r.step)?.outputs;if(!outputs||!Object.hasOwn(outputs,r.output))fail(`missing output ${r.step}/${r.output}`);const result=outputs[r.output];if(Buffer.byteLength(serial(result)??'')>MAX_BYTES)fail('composed output exceeds budget');return clone(result);}
 return Array.isArray(value)?value.map(x=>resolveInputs(x,receipts)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveInputs(v,receipts)]));
}
export function createNativeCreationRuntime({conductor,admittedMethodIds,planner,approve,reasoner=null,filmProducer=null,filmQualityTarget='procedural-proof'}={}){
 if(!conductor||typeof conductor.listMethods!=='function'||typeof conductor.conduct!=='function')fail('conductor required');
 if(!Array.isArray(admittedMethodIds)||!admittedMethodIds.length)fail('explicit admitted method IDs required');
 const admitted=new Set(admittedMethodIds), issued=new WeakSet(), consumed=new WeakSet();
 async function methods(){return (await conductor.listMethods()).filter(m=>admitted.has(m.id));}
 async function propose(request){
  if(typeof request!=='string'||!request.trim()||Buffer.byteLength(request)>32768)fail('bounded nonempty request required');
  if(typeof planner!=='function')fail('governed planner required');
  const available=await methods();if(!available.length)fail('no admitted methods available');
  const byId=new Map(available.map(m=>[m.id,m]));
  const raw=parse(await planner({request,methods:clone(available),filmQualityTarget,
   contract:'Return JSON {steps:[{id,methodId,inputs}]}, 1..8 sequential steps. Select only supplied admitted IDs and declared input keys. To compose a prior result, use {"$from":{"step":"prior-id","output":"output-store-name"}}. No code, shell commands, new methods or invented assets. Preserve the requested quality target; never downgrade. This is a proposal, not authority to execute.'}));
  if(!Array.isArray(raw?.steps)||!raw.steps.length||raw.steps.length>8)fail('expected 1..8 method steps');
  const prior=new Set();
  const steps=raw.steps.map(s=>{
   if(!s||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(s.id)||prior.has(s.id))fail('invalid or duplicate step id');
   const m=byId.get(s.methodId);if(!m)fail('method is not admitted');
   if(!/^[a-f0-9]{64}$/.test(m.sha256??''))fail('method digest required');
   const inputs=s.inputs??{};if(typeof inputs!=='object'||Array.isArray(inputs)||!inputs)fail('inputs must be an object');
   if(Object.keys(inputs).some(k=>!m.inputKeys.includes(k)))fail('undeclared method input');
   references(inputs,prior);prior.add(s.id);
   return {id:s.id,methodId:m.id,version:m.version,sha256:m.sha256,inputs:clone(inputs)};
  });
  const body={schema:'kingmaker.creation-proposal/1',request,filmQualityTarget,steps};
  const proposal=freeze({...body,proposalSha256:digest(body),status:'proposed'});issued.add(proposal);return proposal;
 }
 async function execute(proposal,{workDir}={}){
  if(!issued.has(proposal)||consumed.has(proposal))fail('original unconsumed proposal required');
  if(typeof approve!=='function')return {status:'approval-required',proposal};
  const approval=await approve(proposal);
  if(approval?.approved!==true||approval.proposalSha256!==proposal.proposalSha256)return {status:'approval-required',proposal};
  const available=new Map((await methods()).map(m=>[m.id,m]));
  for(const s of proposal.steps)if(available.get(s.methodId)?.sha256!==s.sha256)fail('admitted method changed; propose and approve again');
  const root=await realpath(workDir);
  if(consumed.has(proposal))fail('proposal already consumed');
  consumed.add(proposal);
  const receipts=new Map(),runs=[];
  for(const [index,s] of proposal.steps.entries()){
   const dir=join(root,`creation-${proposal.proposalSha256.slice(0,12)}-${index+1}-${s.id}`);
   // Never reuse a previous run directory or follow a caller-preplaced symlink.
   await mkdir(dir,{recursive:false});
   let result;
   try{result=await conductor.conduct(s.methodId,{workDir:dir,inputs:resolveInputs(s.inputs,receipts),reasoner,filmProducer,filmQualityTarget:proposal.filmQualityTarget});}
   catch(error){return {status:'failed',proposalSha256:proposal.proposalSha256,runs,failedStep:s.id,reason:String(error.message)};}
   runs.push({id:s.id,workDir:dir,result});receipts.set(s.id,result);
   if(result.status!=='completed'||result.declared?.length)return {status:result.status==='completed'?'incomplete':result.status,proposalSha256:proposal.proposalSha256,runs,failedStep:s.id,reason:result.reason??'method not fully executed'};
  }
  return {status:'completed',proposalSha256:proposal.proposalSha256,runs,limitations:['Completion covers the conducted methods, not independent visual quality or production acceptance.']};
 }
 return {propose,execute};
}
