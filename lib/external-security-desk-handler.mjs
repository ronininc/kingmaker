import { runExternalSecurityInventory } from './external-security-inventory-runtime.mjs';
import { runSecurity } from './keychain-seal.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,SHA=/^[a-f0-9]{64}$/,trusted=new WeakSet();
const CRM_ORIGIN='https://www.ronininc.org',MAX_BODY=256*1024,TIMEOUT=15_000;
export const EXTERNAL_DESK_MAPPING_KEYCHAIN=Object.freeze({service:'com.ronininc.kingmaker.external-security',account:'desk-mapping-v1'});
export function createExternalSecurityDeskMapping({deskSlug,pairingId,executorRegistrationId,executorFingerprint}={}){
  if(!['muse','grok-bot','codex'].includes(String(deskSlug))||!UUID.test(String(pairingId))||typeof executorRegistrationId!=='string'||executorRegistrationId.length<3||executorRegistrationId.length>120||!SHA.test(String(executorFingerprint)))throw new Error('EXTERNAL_DESK_MAPPING');
  const mapping=Object.freeze({schema:'ronin.external-security-desk-mapping/v1',deskSlug,pairingId,executorRegistrationId,executorFingerprint});trusted.add(mapping);return mapping;
}
/** Read the owner-provisioned public binding from one fixed macOS Keychain item. This never creates or updates it. */
export function loadExternalSecurityDeskMapping({run=runSecurity}={}){
  if(typeof run!=='function')throw new Error('EXTERNAL_DESK_MAPPING_KEYCHAIN');
  const result=run(['find-generic-password','-s',EXTERNAL_DESK_MAPPING_KEYCHAIN.service,'-a',EXTERNAL_DESK_MAPPING_KEYCHAIN.account,'-w']);
  if(!result||result.status!==0||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>64*1024)throw new Error('EXTERNAL_DESK_MAPPING_KEYCHAIN');
  let raw;try{raw=JSON.parse(result.stdout)}catch{throw new Error('EXTERNAL_DESK_MAPPING_KEYCHAIN')}
  if(!raw||Object.keys(raw).sort().join(',')!=='deskSlug,executorFingerprint,executorRegistrationId,pairingId,schema'||raw.schema!=='ronin.external-security-desk-mapping/v1')throw new Error('EXTERNAL_DESK_MAPPING_KEYCHAIN');
  return createExternalSecurityDeskMapping(raw);
}
const parseRpc=(text)=>{const line=String(text).split('\n').find(v=>v.startsWith('data:'));let rpc;try{rpc=JSON.parse(line?line.slice(5).trim():text)}catch{throw new Error('EXTERNAL_DESK_BAD_RESPONSE')}if(rpc?.error||rpc?.result?.isError)throw new Error('EXTERNAL_DESK_REFUSED');const value=rpc?.result?.structuredContent??rpc?.result?.content?.[0]?.text;if(typeof value==='string'){try{return JSON.parse(value)}catch{throw new Error('EXTERNAL_DESK_BAD_RESPONSE')}}return value;};
export function createExternalSecurityDeskDiscoveryClient({baseUrl=CRM_ORIGIN,bearer,fetchImpl=globalThis.fetch}={}){
  let origin;try{origin=new URL(baseUrl).origin}catch{throw new Error('EXTERNAL_DESK_CLIENT_CONFIG')}
  if(baseUrl!==origin||origin!==CRM_ORIGIN||typeof bearer!=='string'||bearer.length<16||typeof fetchImpl!=='function')throw new Error('EXTERNAL_DESK_CLIENT_CONFIG');let id=0;
  return async(input)=>{
    const {signal,...args}=input??{},controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);timer.unref?.();const abort=()=>controller.abort();signal?.addEventListener?.('abort',abort,{once:true});
    try{
      const res=await fetchImpl(`${origin}/mcp/desk`,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${bearer}`,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'external_security_attempt_discovery',arguments:args}})});
      if(!res.ok)throw new Error(`EXTERNAL_DESK_HTTP_${res.status}`);const declared=Number(res.headers?.get?.('content-length')||0);if(declared>MAX_BODY)throw new Error('EXTERNAL_DESK_RESPONSE_TOO_LARGE');
      const reader=res.body?.getReader();let total=0,chunks=[];
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY){controller.abort();throw new Error('EXTERNAL_DESK_RESPONSE_TOO_LARGE')}chunks.push(Buffer.from(value))}
      else{const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>MAX_BODY)throw new Error('EXTERNAL_DESK_RESPONSE_TOO_LARGE');chunks=[bytes]}
      return parseRpc(Buffer.concat(chunks).toString('utf8'));
    }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',abort)}
  };
}
/** Discovery only: ordinary local_work never carries security credentials, receipts, manifests or paths. */
export function createExternalSecurityDeskAttemptBridge({mapping,discoverAttempt,loadAttempt,runInventory=runExternalSecurityInventory}={}){
  if(!trusted.has(mapping)||typeof discoverAttempt!=='function'||typeof loadAttempt!=='function'||typeof runInventory!=='function')throw new Error('EXTERNAL_DESK_CONFIG');
  return async({signal}={})=>{
    if(signal?.aborted)throw new Error('EXTERNAL_DESK_ABORTED');
    const discovered=await discoverAttempt({schema:'ronin.external-security-attempt-discovery/v1',deskSlug:mapping.deskSlug,pairingId:mapping.pairingId,executorRegistrationId:mapping.executorRegistrationId,executorFingerprint:mapping.executorFingerprint,signal});
    if(discovered===null)return{idle:true,reason:'no_approved_attempt',reviewRequired:false,submissionAllowed:false};
    if(!discovered||discovered.schema!=='ronin.external-security-available-attempt/v1'||!UUID.test(String(discovered.attemptId))||discovered.executorRegistrationId!==mapping.executorRegistrationId||discovered.executorFingerprint!==mapping.executorFingerprint)throw new Error('EXTERNAL_DESK_DISCOVERY_BINDING');
    const bound=await loadAttempt(discovered.attemptId);
    if(!bound||typeof bound!=='object'||!bound.config||!bound.crmClient||typeof bound.verifyDispatchReceipt!=='function'||!bound.job||bound.config.attemptId!==discovered.attemptId||bound.executorRegistrationId!==mapping.executorRegistrationId||bound.executorFingerprint!==mapping.executorFingerprint)throw new Error('EXTERNAL_DESK_LOCAL_BINDING');
    const out=await runInventory({config:bound.config,crmClient:bound.crmClient,verifyDispatchReceipt:bound.verifyDispatchReceipt,job:bound.job,completedAt:bound.completedAt(),signal});
    if(out.reviewRequired!==true||out.submissionAllowed!==false||out.evidence?.vulnerabilityDiscoveryClaimed!==false||out.evidence?.targetCodeExecuted!==false)throw new Error('EXTERNAL_DESK_SCOPE_WIDENED');
    return{attemptId:discovered.attemptId,crmStatus:out.crmStatus,inventoryAuditId:out.evidence.auditId,reviewRequired:true,submissionAllowed:false,vulnerabilityAnalysisPerformed:false,targetCodeExecuted:false};
  };
}
/** Assemble the accepted path. Construction reads the fixed public mapping; it performs no CRM call until invoked. */
export function createGovernedExternalSecurityDeskBridge({deskBearer,loadAttempt,run=runSecurity,fetchImpl=globalThis.fetch,runInventory=runExternalSecurityInventory}={}){
  const mapping=loadExternalSecurityDeskMapping({run});
  const discoverAttempt=createExternalSecurityDeskDiscoveryClient({bearer:deskBearer,fetchImpl});
  return createExternalSecurityDeskAttemptBridge({mapping,discoverAttempt,loadAttempt,runInventory});
}
