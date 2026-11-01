import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableJobPool } from '../lib/durable-job-pool.mjs';
import { createJobDispatcher } from '../lib/job-dispatcher.mjs';
import { createLocalStaticReviewAdapter, externalSecurityManifestSha256, EXTERNAL_REVIEW_ADAPTER } from '../lib/external-review-adapter.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'external-review-'));
const externalJobId='11111111-1111-4111-8111-111111111111',boardJobId='22222222-2222-4222-8222-222222222222';
function manifest() { return {schema:'ronin.external-security-scope/v1',program:'GitHub CLI Security Bug Bounty',officialRulesUrl:'https://bounty.example.invalid/rules',rulesVersion:'pending-official-payload',repositoryUrl:'https://github.com/cli/cli',commitSha:'63837fb778d6a39f02be0ce76ff89f2bc8d74bdc',includedAssets:['github.com/cli/cli at the exact commit'],excludedAssets:['live GitHub accounts','production credentials'],allowedMethods:['offline source review','mocked transport tests'],prohibitedMethods:['live credential access','production probing'],aiPolicy:'AI-assisted analysis requires independent verification.',credentialPolicy:'Synthetic tokens and mocked transports only until separately approved.',submissionPolicy:'Owner review is required before any external submission.',safeHarbor:'Official scope must authorize this exact review.'}; }
function dispatch(root) { const m=manifest();return {schema:'ronin.external-security-local-dispatch/v1',externalJobId,boardJobId,state:'eligible',hold:'released',manifest:m,manifestSha256:externalSecurityManifestSha256(m),ownerApproval:{decision:'approved-for-local-review',approvedBy:'fixture-owner',approvedAt:'2026-11-01T00:00:00Z'},execution:{mode:'local-static-source-review',localSourcePath:root,network:false,credentials:'fake-only',submission:'owner-approval-required'}}; }

test('durable external review uses exact CRM manifest digest and stays review-held',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const audit=[],m=dispatch(source);
  const pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite')});
  const job=pool.submit({jobId:m.externalJobId,text:JSON.stringify(m),idempotencyKey:`external:${m.externalJobId}:${m.manifestSha256}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});
  let calls=0;const adapter=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:m.manifest.repositoryUrl,commit:m.manifest.commitSha,clean:true}),auditAppend:(e)=>audit.push(e),analyze:async(input)=>{calls++;assert.equal(input.network,false);assert.equal(input.credentials,'fake-only');return{findings:[{title:'Fixture routing issue',severity:'medium',file:'pkg/example.go',evidence:'mock transport only'}],evidence:{mocked:true}};}});
  const done=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}}).runOne();
  assert.equal(done.state,'done');assert.equal(calls,1);assert.equal(done.evidence.externalJobId,externalJobId);assert.equal(done.evidence.boardJobId,boardJobId);assert.equal(done.evidence.manifestSha256,m.manifestSha256);assert.equal(done.evidence.reviewRequired,true);assert.equal(done.evidence.submissionAllowed,false);
  assert.deepEqual(pool.events(job.id).map((e)=>e.event),['submitted','claimed','acknowledged','started','evidence_recorded','review_required','completed']);assert.deepEqual(audit.map((e)=>e.event),['external_review_started','external_review_evidence']);pool.close();
});

test('adapter refuses pending scope, digest, policy, method, source or id widening',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const base=dispatch(source);
  const run=async(change,id=externalJobId)=>{const pool=createDurableJobPool({path:join(temp(),'queue','jobs.sqlite'),maxAttempts:1});const m=structuredClone(base);change(m);pool.submit({jobId:id,text:JSON.stringify(m),idempotencyKey:`external:refuse:${Math.random()}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});const a=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:base.manifest.repositoryUrl,commit:base.manifest.commitSha,clean:true}),analyze:async()=>{throw new Error('must not run');}});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:a}}).runOne();assert.equal(out.state,'failed');pool.close();};
  await run((m)=>{m.state='pending_scope';m.hold='blocked';delete m.ownerApproval;});await run((m)=>{m.manifestSha256='0'.repeat(64);});await run((m)=>{m.execution.network=true;});await run((m)=>{m.command='curl target';});await run((m)=>{m.manifest.allowedMethods=['active scan'];m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run((m)=>{m.manifest.commitSha='0'.repeat(40);m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run(()=>{},'33333333-3333-4333-8333-333333333333');
});
