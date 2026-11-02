import { runExternalSecurityInventory } from './external-security-inventory-runtime.mjs';

export const EXTERNAL_SECURITY_DESK_HANDLER = 'external-security.inventory.v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;

export function parseExternalSecurityDeskInput(value){
  const x=value&&typeof value==='object'?value:{};
  const keys=Object.keys(x).sort().join(',');
  if(keys!=='attemptId,boardJobId,executorRegistrationId,externalJobId,generation,manifestSha256,nativeOpportunityId,rootAttemptId,rulesSnapshotDigest,schema,sourceCommit')throw new Error('EXTERNAL_DESK_FIELDS');
  if(x.schema!=='ronin.local-handler.external-security-inventory/v1'||![x.attemptId,x.rootAttemptId,x.externalJobId,x.boardJobId,x.nativeOpportunityId].every(v=>UUID.test(String(v)))||!Number.isSafeInteger(x.generation)||x.generation<1||!SHA.test(String(x.manifestSha256))||!SHA.test(String(x.rulesSnapshotDigest))||!COMMIT.test(String(x.sourceCommit))||typeof x.executorRegistrationId!=='string'||x.executorRegistrationId.length<3||x.executorRegistrationId.length>120)throw new Error('EXTERNAL_DESK_INPUT');
  return structuredClone(x);
}

/**
 * Paired-desk adapter for an ALREADY authorized dedicated external-security attempt. CRM job prose,
 * credentials, paths and trust roots never enter this handler. `loadAttempt` is the owner-governed
 * local mapping from immutable IDs to the registered executor, signed authority verifier, private
 * evidence journal, approved source root and scoped CRM client.
 */
export function createExternalSecurityDeskHandler({loadAttempt,runInventory=runExternalSecurityInventory}={}){
  if(typeof loadAttempt!=='function'||typeof runInventory!=='function')throw new Error('EXTERNAL_DESK_CONFIG');
  return async(raw,{signal}={})=>{
    const input=parseExternalSecurityDeskInput(raw);if(signal?.aborted)throw new Error('EXTERNAL_DESK_ABORTED');
    const bound=await loadAttempt(input);
    if(!bound||typeof bound!=='object'||!bound.config||!bound.crmClient||typeof bound.verifyDispatchReceipt!=='function'||!bound.job)throw new Error('EXTERNAL_DESK_UNCONFIGURED');
    const job=bound.job,manifest=job.manifest??{};
    const exact=job.externalJobId===input.externalJobId&&job.boardJobId===input.boardJobId&&job.nativeOpportunityId===input.nativeOpportunityId&&bound.config.attemptId===input.attemptId&&job.manifestSha256===input.manifestSha256&&manifest.rulesSnapshotDigest===input.rulesSnapshotDigest&&manifest.commitSha===input.sourceCommit&&bound.executorRegistrationId===input.executorRegistrationId&&bound.rootAttemptId===input.rootAttemptId&&bound.generation===input.generation;
    if(!exact)throw new Error('EXTERNAL_DESK_BINDING');
    const out=await runInventory({config:bound.config,crmClient:bound.crmClient,verifyDispatchReceipt:bound.verifyDispatchReceipt,job,completedAt:bound.completedAt(),signal});
    if(out.reviewRequired!==true||out.submissionAllowed!==false||out.evidence?.vulnerabilityDiscoveryClaimed!==false||out.evidence?.targetCodeExecuted!==false)throw new Error('EXTERNAL_DESK_SCOPE_WIDENED');
    const result=JSON.stringify({schema:'ronin.local-handler.external-security-inventory-evidence/v1',attemptId:input.attemptId,externalJobId:input.externalJobId,manifestSha256:input.manifestSha256,rulesSnapshotDigest:input.rulesSnapshotDigest,sourceCommit:input.sourceCommit,crmStatus:out.crmStatus,inventoryAuditId:out.evidence.auditId,closureSha256:out.evidence.source.closureSha256,reviewRequired:true,submissionAllowed:false,vulnerabilityAnalysisPerformed:false,targetCodeExecuted:false});
    if(result.length>8000)throw new Error('EXTERNAL_DESK_EVIDENCE_TOO_LARGE');return{result};
  };
}
