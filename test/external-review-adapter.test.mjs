import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableJobPool } from '../lib/durable-job-pool.mjs';
import { createJobDispatcher } from '../lib/job-dispatcher.mjs';
import { createLocalStaticReviewAdapter, EXTERNAL_REVIEW_ADAPTER } from '../lib/external-review-adapter.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'external-review-'));
function manifest(root,id='review-job-0001') { return { schema:'ronin.external-review.job/v1', uniqueJobId:id, executionMode:'local-static-source-review',
  program:{name:'Fixture Program',rulesUrl:'https://program.invalid/rules',rulesSha256:'a'.repeat(64)},
  source:{repositoryUrl:'https://github.com/cli/cli',commit:'63837fb778d6a39f02be0ce76ff89f2bc8d74bdc',localPath:root},
  scope:{assets:['local source tree'],methods:['static-source-review','mocked-transport-credential-routing'],exclusions:['live services']},
  policy:{network:false,credentials:'fake-only',submission:'owner-approval-required',aiAnalysis:'allowed'},
  eligibility:{state:'verified',approvalState:'approved-for-local-review'} }; }

test('durable external review stays local and ends in independent review',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const audit=[];
  const pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite')});
  const m=manifest(source), job=pool.submit({jobId:m.uniqueJobId,text:JSON.stringify(m),idempotencyKey:'external:fixture:0001',adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});
  let calls=0;const adapter=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:m.source.repositoryUrl,commit:m.source.commit,clean:true}),auditAppend:(e)=>audit.push(e),analyze:async(input)=>{calls++;assert.equal(input.network,false);assert.equal(input.credentials,'fake-only');return{findings:[{title:'Fixture routing issue',severity:'medium',file:'pkg/example.go',evidence:'mock transport only'}],evidence:{mocked:true}};}});
  const dispatcher=createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}});
  const done=await dispatcher.runOne();assert.equal(done.state,'done');assert.equal(calls,1);assert.equal(done.evidence.productionReady,false);assert.equal(done.evidence.reviewRequired,true);assert.equal(done.evidence.submissionAllowed,false);
  assert.deepEqual(pool.events(job.id).map((e)=>e.event),['submitted','claimed','acknowledged','started','evidence_recorded','review_required','completed']);
  assert.deepEqual(audit.map((e)=>e.event),['external_review_started','external_review_evidence']);pool.close();
});

test('adapter refuses live, credentialed, command, scope and source widening',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const base=manifest(source);
  const run=async(change)=>{const pool=createDurableJobPool({path:join(temp(),'queue','jobs.sqlite'),maxAttempts:1});const m=structuredClone(base);change(m);pool.submit({jobId:m.uniqueJobId,text:JSON.stringify(m),idempotencyKey:`external:refuse:${Math.random()}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});const a=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:base.source.repositoryUrl,commit:base.source.commit,clean:true}),analyze:async()=>{throw new Error('must not run');}});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:a}}).runOne();assert.equal(out.state,'failed');pool.close();};
  await run((m)=>{m.policy.network=true;}); await run((m)=>{m.policy.credentials='live';}); await run((m)=>{m.command='curl target';}); await run((m)=>{m.scope.methods=['active-scan'];}); await run((m)=>{m.source.commit='0'.repeat(40);});
});
