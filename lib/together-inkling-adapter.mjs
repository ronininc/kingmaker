// Optional, OFF by default. No env/keychain discovery, provider fallback or automatic retry.
import {createHash} from 'node:crypto';
export const TOGETHER_INKLING_MODEL='thinkingmachines/Inkling-2-Small';
const ENDPOINT='https://api.together.ai/v1/chat/completions';
const fail=s=>{throw Error(`remote-inkling: ${s}`);};
const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
export function createTogetherInklingAdapter({enabled=false,selectedProvider,limits,pricingQuote,authorizeRequest,credentialProvider,countInputTokens,fetchImpl=fetch,now=Date.now}={}){
 let reservedMicroUsd=0,blocked=false;
 // Clone caller configuration so no asynchronous consent/budget check can be changed in place.
 const cap=limits?structuredClone(limits):null,price=pricingQuote?structuredClone(pricingQuote):null;
 async function complete({messages,dataScope,maxOutputTokens}={}){
  if(!enabled||selectedProvider!=='together')fail('explicit user-selected remote provider required');
  if(blocked)fail('provider/accounting violation requires review');
  if(!cap||!integer(cap.maxInputTokens,1,131072)||!integer(cap.maxOutputTokens,1,4096)||!integer(cap.maxRequestMicroUsd,1,100000000)||!integer(cap.maxSessionMicroUsd,1,100000000)||!Array.isArray(cap.allowedDataScopes)||cap.allowedDataScopes.some(s=>typeof s!=='string'||!s||s.length>128)||typeof dataScope!=='string'||!cap.allowedDataScopes.includes(dataScope))fail('explicit token, spend and privacy scope limits required');
  if(!price||price.currency!=='USD'||!integer(price.inputMicroUsdPerMillion,0,1000000000)||!integer(price.outputMicroUsdPerMillion,0,1000000000)||!integer(price.expiresAt,1,Number.MAX_SAFE_INTEGER)||price.expiresAt<=now())fail('current independently verified pricing quote required');
  if(typeof authorizeRequest!=='function'||typeof credentialProvider!=='function'||typeof countInputTokens!=='function')fail('approval, scoped credential and exact tokenizer adapters required');
  if(!Array.isArray(messages)||!messages.length||messages.length>32||messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||Object.keys(m).some(k=>!['role','content'].includes(k))))fail('bounded text-only messages required');
  const msgs=structuredClone(messages);if(Buffer.byteLength(JSON.stringify(msgs))>256*1024)fail('input byte budget exceeded');
  if(!integer(maxOutputTokens,1,cap.maxOutputTokens))fail('output token limit exceeded');
  let counted;try{counted=await countInputTokens({model:TOGETHER_INKLING_MODEL,messages:structuredClone(msgs)});}catch{fail('token accounting unavailable');}
  if(counted?.model!==TOGETHER_INKLING_MODEL||counted.accounting!=='exact-provider-template'||!integer(counted.inputTokens,1,cap.maxInputTokens))fail('verified input token limit unavailable or exceeded');
  const maxCost=Math.ceil((counted.inputTokens*price.inputMicroUsdPerMillion+maxOutputTokens*price.outputMicroUsdPerMillion)/1000000);
  if(maxCost>cap.maxRequestMicroUsd)fail('per-request spend limit exceeded');
  const body={model:TOGETHER_INKLING_MODEL,messages:msgs,max_tokens:maxOutputTokens,stream:false,n:1,temperature:0,context_length_exceeded_behavior:'error'};
  const review={provider:'together',endpoint:ENDPOINT,model:TOGETHER_INKLING_MODEL,dataScope,body,pricingQuote:price,maxCostMicroUsd:maxCost,inputTokens:counted.inputTokens,maxOutputTokens};
  const requestSha256=createHash('sha256').update(JSON.stringify(review)).digest('hex');
  let authorization;try{authorization=await authorizeRequest({...structuredClone(review),requestSha256});}catch{fail('request authorization unavailable');}
  if(authorization?.approved!==true||authorization.requestSha256!==requestSha256)fail('exact payload, recipient, privacy and spend approval required');
  if(price.expiresAt<=now())fail('pricing quote expired during review');
  if(reservedMicroUsd+maxCost>cap.maxSessionMicroUsd)fail('session spend limit exceeded');
  // Reserve before any async credential/network step. Unknown failures retain the reservation.
  reservedMicroUsd+=maxCost;
  let key;try{key=await credentialProvider({provider:'together',origin:'https://api.together.ai',requestSha256});}catch{fail('credential unavailable');}
  if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))fail('credential unavailable');
  let response;
  try{response=await fetchImpl(ENDPOINT,{method:'POST',redirect:'error',headers:{'content-type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});}catch{fail('request failed; charge status unknown; no retry');}finally{key=null;}
  try{
   if(!response.ok)fail(`provider HTTP ${response.status}; no retry`);
   const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024)fail('response byte limit exceeded');chunks.push(Buffer.from(chunk));}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid provider response');}
   const usage=data.usage;
   if(data.model!==TOGETHER_INKLING_MODEL||!integer(usage?.prompt_tokens,0,counted.inputTokens)||!integer(usage?.completion_tokens,0,maxOutputTokens)){blocked=true;fail('model or token accounting violation');}
   const actualMicroUsd=Math.ceil((usage.prompt_tokens*price.inputMicroUsdPerMillion+usage.completion_tokens*price.outputMicroUsdPerMillion)/1000000);
   if(actualMicroUsd>maxCost){blocked=true;fail('reported spend exceeded reservation');}
   const choice=data.choices?.[0];if(typeof choice?.message?.content!=='string'||choice.message.tool_calls?.length)fail('text-only result required');
   return {status:choice.finish_reason==='stop'?'completed':'incomplete',text:choice.message.content,receipt:{provider:'together',model:TOGETHER_INKLING_MODEL,requestSha256,dataScope,inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,reportedCostMicroUsd:actualMicroUsd,reservedMicroUsd:maxCost,sessionReservedMicroUsd:reservedMicroUsd,currency:'USD',limitations:['Cost uses caller-verified tariff and exact tokenizer; provider billing remains authoritative.','Reservation retained conservatively, including failed requests.','Output is untrusted text, not executable authority or learned capability.']}};
  }finally{try{await response.body?.cancel();}catch{}}
 }
 return Object.freeze({complete,status:()=>({enabled:Boolean(enabled&&selectedProvider==='together'),blocked,reservedMicroUsd,model:TOGETHER_INKLING_MODEL})});
}
