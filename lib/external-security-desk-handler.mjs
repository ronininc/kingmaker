import { runExternalSecurityInventory } from './external-security-inventory-runtime.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,SHA=/^[a-f0-9]{64}$/,trusted=new WeakSet();
export function createExternalSecurityDeskMapping({deskSlug,pairingId,executorRegistrationId,executorFingerprint}={}){
  if(!['muse','grok-bot','codex'].includes(String(deskSlug))||!UUID.test(String(pairingId))||typeof executorRegistrationId!=='string'||executorRegistrationId.length<3||executorRegistrationId.length>120||!SHA.test(String(executorFingerprint)))throw new Error('EXTERNAL_DESK_MAPPING');
  const mapping=Object.freeze({schema:'ronin.external-security-desk-mapping/v1',deskSlug,pairingId,executorRegistrationId,executorFingerprint});trusted.add(mapping);return mapping;
}
/** Discovery only: ordinary local_work never carries security credentials, receipts, manifests or paths. */
export function createExternalSecurityDeskAttemptBridge({mapping,discoverAttempt,loadAttempt,runInventory=runExternalSecurityInventory}={}){
  if(!trusted.has(mapping)||typeof discoverAttempt!=='function'||typeof loadAttempt!=='function'||typeof runInventory!=='function')throw new Error('EXTERNAL_DESK_CONFIG');
  return async({signal}={})=>{
    if(signal?.aborted)throw new Error('EXTERNAL_DESK_ABORTED');
    const discovered=await discoverAttempt({schema:'ronin.external-security-attempt-discovery/v1',deskSlug:mapping.deskSlug,pairingId:mapping.pairingId,executorRegistrationId:mapping.executorRegistrationId,executorFingerprint:mapping.executorFingerprint,signal});
    if(!discovered||discovered.schema!=='ronin.external-security-available-attempt/v1'||!UUID.test(String(discovered.attemptId))||discovered.executorRegistrationId!==mapping.executorRegistrationId||discovered.executorFingerprint!==mapping.executorFingerprint)throw new Error('EXTERNAL_DESK_DISCOVERY_BINDING');
    const bound=await loadAttempt(discovered.attemptId);
    if(!bound||typeof bound!=='object'||!bound.config||!bound.crmClient||typeof bound.verifyDispatchReceipt!=='function'||!bound.job||bound.config.attemptId!==discovered.attemptId||bound.executorRegistrationId!==mapping.executorRegistrationId||bound.executorFingerprint!==mapping.executorFingerprint)throw new Error('EXTERNAL_DESK_LOCAL_BINDING');
    const out=await runInventory({config:bound.config,crmClient:bound.crmClient,verifyDispatchReceipt:bound.verifyDispatchReceipt,job:bound.job,completedAt:bound.completedAt(),signal});
    if(out.reviewRequired!==true||out.submissionAllowed!==false||out.evidence?.vulnerabilityDiscoveryClaimed!==false||out.evidence?.targetCodeExecuted!==false)throw new Error('EXTERNAL_DESK_SCOPE_WIDENED');
    return{attemptId:discovered.attemptId,crmStatus:out.crmStatus,inventoryAuditId:out.evidence.auditId,reviewRequired:true,submissionAllowed:false,vulnerabilityAnalysisPerformed:false,targetCodeExecuted:false};
  };
}
