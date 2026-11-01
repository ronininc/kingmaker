import { createHash } from 'node:crypto';
import { createLocalStaticReviewAdapter } from './external-review-adapter.mjs';

const sha=(v)=>createHash('sha256').update(v).digest('hex');

/** Explicitly gated inventory-only composition. It never executes target code or submits reports. */
export async function runExternalSecurityInventory({enabled=false,crmClient,verifyDispatchReceipt,job,allowedRoots=[],completedAt,signal}={}){
  if(enabled!==true)throw new Error('EXTERNAL_INVENTORY_RUNTIME_DISABLED');
  if(!crmClient||typeof crmClient.status!=='function'||typeof crmClient.claim!=='function'||typeof crmClient.submitEvidence!=='function'||typeof verifyDispatchReceipt!=='function')throw new Error('EXTERNAL_INVENTORY_RUNTIME_CONFIG');
  if(!job||typeof job!=='object'||!Number.isSafeInteger(completedAt)||completedAt<1)throw new Error('EXTERNAL_INVENTORY_RUNTIME_INPUT');
  const before=await crmClient.status();
  if(!['queued','leased'].includes(before.status)||before.evidenceDigest!=null)throw new Error('EXTERNAL_INVENTORY_ATTEMPT_NOT_RUNNABLE');
  const claimed=await crmClient.claim(),input=structuredClone(job);
  input.dispatchReceipt=claimed.envelope;
  const adapter=createLocalStaticReviewAdapter({allowedRoots,verifyDispatchReceipt});
  const evidence=await adapter({id:input.externalJobId,text:JSON.stringify(input),attempt:input.dispatchReceipt.receipt.generation,signal});
  if(evidence.vulnerabilityDiscoveryClaimed!==false||evidence.targetCodeExecuted!==false||evidence.reviewRequired!==true||evidence.submissionAllowed!==false||evidence.findings?.length)throw new Error('EXTERNAL_INVENTORY_SCOPE_WIDENED');
  const artifactSha=sha(JSON.stringify({auditId:evidence.auditId,closureSha256:evidence.source.closureSha256,manifestSha256:evidence.manifestSha256}));
  const accepted=await crmClient.submitEvidence({result:'negative',summary:'Bounded verified Git-object inventory completed. No vulnerability analysis or target-code execution was performed.',artifacts:[{label:'verified Git-object inventory evidence',sha256:artifactSha}],completedAt});
  const after=await crmClient.status();
  if(after.evidenceDigest!==accepted.evidenceDigest||!['evidence_review','accepted','rejected'].includes(after.status))throw new Error('EXTERNAL_INVENTORY_FINAL_STATUS');
  return{evidence,crmEvidenceDigest:accepted.evidenceDigest,crmStatus:after.status,reviewRequired:true,submissionAllowed:false};
}
