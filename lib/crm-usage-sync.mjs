// Explicit reporting bridge. The caller supplies its approved authenticated transport.
// No credential lookup, identity mutation, background network request or quota estimation.
import {appendFileSync,mkdirSync,readFileSync,statSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const agents=new Set(['codex','claude','dot','grok','muse','kingmaker']);
const providerAgent={codex:'codex',openai:'codex','claude-code':'claude',claude:'claude',anthropic:'claude',dot:'dot',grok:'grok',xai:'grok',muse:'muse',ollama:'kingmaker'};
const number=v=>v===null||v===undefined?null:Number.isSafeInteger(v)&&v>=0?v:null;
/** Bind to the Launcher's existing authenticated request function; this function never looks up a key. */
export function launcherUsageTransport(request){
 if(typeof request!=='function')throw Error('An approved authenticated Launcher request function is required');
 return async snapshot=>{
  const response=await request('/api/launcher/agent-usage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(snapshot)});
  if(!response?.ok)throw Error('Launcher usage report was refused');
  return response.json();
 };
}
/** Installation is explicit; the returned flush performs the bounded push, never a model turn. */
export function attachCrmUsageSync({meter,file,request,now,sessionId}){
 if(typeof meter?.setCrmUsageObserver!=='function')throw Error('Token meter observer API is required');
 const sync=createCrmUsageSync({file,send:request?launcherUsageTransport(request):undefined,now,sessionId});
 meter.setCrmUsageObserver(sync.observe);
 return {...sync,detach:()=>meter.setCrmUsageObserver(null)};
}
export function createCrmUsageSync({file,send,now=Date.now,sessionId=randomUUID()}={}){
 const totals=new Map(),pending=new Map();let sequence=0,flushing=null,recoveryError=null;
 if(file){try{
  if(statSync(file).size>4*1024*1024)throw Error('usage recovery file exceeds bounded window');
  for(const line of readFileSync(file,'utf8').split('\n')){
   if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{continue;}
   if(!agents.has(r.agent)||typeof r.report_id!=='string'||!Number.isInteger(r.observed_at))continue;
   const snapshot={agent:r.agent,report_id:r.report_id,observed_at:r.observed_at,prompt_tokens:number(r.prompt_tokens),generated_tokens:number(r.generated_tokens)};
   totals.set(r.agent,{prompt_tokens:snapshot.prompt_tokens,generated_tokens:snapshot.generated_tokens});pending.set(r.agent,snapshot);
  }
 }catch(e){if(e.code!=='ENOENT')recoveryError='local_recovery_unavailable';}}
 function observe(record){
  try{
   if(recoveryError)return false;
   const agent=providerAgent[record?.provider];if(!agents.has(agent))return false;
   const previous=totals.get(agent),failed=record.outcome&&record.outcome!=='ok',p=failed?null:number(record.prompt),g=failed?null:number(record.generated);
   const sum=(a,b)=>a===null||b===null||!Number.isSafeInteger(a+b)?null:a+b;
   const total={prompt_tokens:previous?sum(previous.prompt_tokens,p):p,generated_tokens:previous?sum(previous.generated_tokens,g):g};
   totals.set(agent,total);
   const report={agent,report_id:`${sessionId}:${++sequence}`,observed_at:Math.floor(now()/1000),...total};
   // Only allowed numeric evidence is persisted, never the original provider object.
   if(file){mkdirSync(dirname(file),{recursive:true,mode:0o700});appendFileSync(file,JSON.stringify({...report,provenance:'local_provider_report'})+'\n',{mode:0o600});chmodSync(file,0o600);}
   pending.set(agent,report);return true;
  }catch{return false;}
 }
 async function flush(){
  if(recoveryError)return {ok:false,reason:recoveryError,pending:pending.size};
  if(flushing)return flushing;
  if(typeof send!=='function')return {ok:false,reason:'authenticated_transport_unavailable',pending:pending.size};
  flushing=(async()=>{
   const receipts=[];
   for(const [agent,snapshot]of [...pending].slice(0,6)){
    try{
     const response=await send(Object.freeze({...snapshot}));
     const r=response?.receipt;
     if(response?.ok!==true||!r||r.agent!==snapshot.agent||r.report_id!==snapshot.report_id||r.observed_at!==snapshot.observed_at||r.provenance!=='paired_launcher_provider_report')return {ok:false,reason:'unverified_receipt',pending:pending.size,receipts};
     if(pending.get(agent)?.report_id===snapshot.report_id)pending.delete(agent);
     receipts.push(r);
    }catch{return {ok:false,reason:'transport_failed',pending:pending.size,receipts};}
   }
   return {ok:pending.size===0,pending:pending.size,receipts};
  })();
  try{return await flushing;}finally{flushing=null;}
 }
 return {observe,flush,pending:()=>pending.size,totals:()=>Object.fromEntries(totals)};
}
