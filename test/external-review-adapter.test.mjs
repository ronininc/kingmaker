import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableJobPool } from '../lib/durable-job-pool.mjs';
import { createJobDispatcher } from '../lib/job-dispatcher.mjs';
import { createExternalDispatchReceiptVerifier, createLocalStaticReviewAdapter, externalSecurityManifestSha256, EXTERNAL_REVIEW_ADAPTER } from '../lib/external-review-adapter.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'external-review-'));
const externalJobId='11111111-1111-4111-8111-111111111111',boardJobId='22222222-2222-4222-8222-222222222222',nativeOpportunityId='44444444-4444-4444-8444-444444444444';
function manifest() { return {schema:'ronin.external-security-scope/v1',program:'GitHub CLI Security Bug Bounty',officialRulesUrl:'https://bounty.example.invalid/rules',rulesVersion:'pending-official-payload',repositoryUrl:'https://github.com/cli/cli',commitSha:'63837fb778d6a39f02be0ce76ff89f2bc8d74bdc',includedAssets:['github.com/cli/cli at the exact commit'],excludedAssets:['live GitHub accounts','production credentials'],allowedMethods:['offline source review','mocked transport tests'],prohibitedMethods:['live credential access','production probing'],aiPolicy:'AI-assisted analysis requires independent verification.',credentialPolicy:'Synthetic tokens and mocked transports only until separately approved.',submissionPolicy:'Owner review is required before any external submission.',safeHarbor:'Official scope must authorize this exact review.',rulesSnapshotDigest:'d'.repeat(64)}; }
function dispatch(root) { const m=manifest();return {schema:'ronin.external-security-local-dispatch/v1',externalJobId,boardJobId,nativeOpportunityId,manifest:m,manifestSha256:externalSecurityManifestSha256(m),dispatchReceipt:{fixture:'signed-receipt'},execution:{mode:'local-static-source-review',localSourcePath:root,network:false,credentials:'fake-only',submission:'owner-approval-required'}}; }
const treeSha256='b'.repeat(64);
const trust={verifyDispatchReceipt:async()=>({authorized:true,receiptId:'receipt-fixture',attemptId:'attempt-fixture',authorityKeyId:'fixture-key'}),verifyAnalyzerAttestation:async()=>({verified:true,networkIsolation:'enforced',credentialIsolation:'synthetic-only'})};

test('durable external review uses exact CRM manifest digest and stays review-held',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const m=dispatch(source);
  const pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite')});
  const job=pool.submit({jobId:m.externalJobId,text:JSON.stringify(m),idempotencyKey:`external:${m.externalJobId}:${m.manifestSha256}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});
  let calls=0;const adapter=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:m.manifest.repositoryUrl,commit:m.manifest.commitSha,clean:true,immutableSnapshot:true,treeSha256,snapshotId:'snapshot-fixture'}),...trust,analyze:async(input)=>{calls++;assert.equal(input.sourceTreeSha256,treeSha256);return{attestation:{fixture:true},findings:[{title:'Fixture routing issue',severity:'medium',file:'pkg/example.go',evidence:'mock transport only'}],evidence:{mocked:true}};}});
  const done=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}}).runOne();
  assert.equal(done.state,'done');assert.equal(calls,1);assert.equal(done.evidence.externalJobId,externalJobId);assert.equal(done.evidence.boardJobId,boardJobId);assert.equal(done.evidence.manifestSha256,m.manifestSha256);assert.equal(done.evidence.reviewRequired,true);assert.equal(done.evidence.submissionAllowed,false);assert.equal(done.evidence.networkIsolation,'enforced');
  assert.deepEqual(pool.events(job.id).map((e)=>e.event),['submitted','claimed','acknowledged','started','evidence_recorded','review_required','completed']);pool.close();
});

test('adapter refuses pending scope, digest, policy, method, source or id widening',async()=>{
  const dir=temp(),source=join(dir,'source');mkdirSync(source);const base=dispatch(source);
  const run=async(change,id=externalJobId,receiptVerifier=trust.verifyDispatchReceipt)=>{const pool=createDurableJobPool({path:join(temp(),'queue','jobs.sqlite'),maxAttempts:1});const m=structuredClone(base);change(m);pool.submit({jobId:id,text:JSON.stringify(m),idempotencyKey:`external:refuse:${Math.random()}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});const a=createLocalStaticReviewAdapter({allowedRoots:[dir],inspectSource:()=>({repositoryUrl:base.manifest.repositoryUrl,commit:base.manifest.commitSha,clean:true,immutableSnapshot:true,treeSha256,snapshotId:'snapshot-fixture'}),...trust,verifyDispatchReceipt:receiptVerifier,analyze:async()=>{throw new Error('must not run');}});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:a}}).runOne();assert.equal(out.state,'failed');pool.close();};
  await run(()=>{},externalJobId,async()=>({authorized:false}));await run((m)=>{m.manifestSha256='0'.repeat(64);});await run((m)=>{m.execution.network=true;});await run((m)=>{m.command='curl target';});await run((m)=>{m.manifest.allowedMethods=['active scan'];m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run((m)=>{m.manifest.commitSha='0'.repeat(40);m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run(()=>{},'33333333-3333-4333-8333-333333333333');
});

test('adapter rejects source aliases, source mutation and oversized evidence',async()=>{
  const run=async({symlink=false,mutate=false,oversize=false})=>{const dir=temp(),real=join(dir,'real');mkdirSync(real);const source=symlink?join(dir,'alias'):real;if(symlink)symlinkSync(real,source);const m=dispatch(source),pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite'),maxAttempts:1});pool.submit({jobId:externalJobId,text:JSON.stringify(m),idempotencyKey:`external:boundary:${Math.random()}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});let inspections=0;const adapter=createLocalStaticReviewAdapter({allowedRoots:[dir],...trust,inspectSource:()=>({repositoryUrl:m.manifest.repositoryUrl,commit:m.manifest.commitSha,clean:true,immutableSnapshot:true,treeSha256:mutate&&inspections++>0?'c'.repeat(64):treeSha256,snapshotId:'snapshot-fixture'}),analyze:async()=>({attestation:{fixture:true},evidence:oversize?{text:'x'.repeat(33_000)}:{fixture:true}})});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}}).runOne();assert.equal(out.state,'failed');pool.close();};
  await run({symlink:true});await run({mutate:true});await run({oversize:true});
});

test('CRM Ed25519 receipt binds exact fresh scope, registered authority and one nonce',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),nowMs=1_800_000_000_000,executor={id:'executor-fixture',fingerprint:'e'.repeat(64)},spent=new Set();
  const verifier=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=> 'active',executorStatus:async()=> 'active',consumeNonce:async({keyId,nonce})=>{const k=`${keyId}:${nonce}`;if(spent.has(k))return false;spent.add(k);return true;}});
  const expected={externalJobId,nativeOpportunityId,manifestSha256:'a'.repeat(64),rulesSnapshotDigest:'d'.repeat(64),commitSha:'63837fb778d6a39f02be0ce76ff89f2bc8d74bdc'};
  const receipt={schema:'ronin.external-security-dispatch/v1',jobId:externalJobId,nativeOpportunityId,manifestDigest:expected.manifestSha256,rulesSnapshotDigest:expected.rulesSnapshotDigest,sourceCommit:expected.commitSha,executorRegistrationId:executor.id,executorFingerprint:executor.fingerprint,attemptId:'attempt-fixture',leaseExpiresAt:Math.floor(nowMs/1000)+600,nonce:'fresh_nonce_12345678901234567890',issuedAt:Math.floor(nowMs/1000)};
  const envelope=(r=receipt)=>({receipt:r,signature:{keyId:'key-fixture',value:sign(null,Buffer.from(JSON.stringify(r,Object.keys(r).sort())),privateKey).toString('base64url')}});
  assert.equal((await verifier(envelope(),expected)).authorized,true);await assert.rejects(()=>verifier(envelope(),expected),/REPLAY/);
  const tampered={...receipt,nonce:'other_nonce_12345678901234567890',sourceCommit:'0'.repeat(40)};await assert.rejects(()=>verifier(envelope(tampered),expected),/BINDING/);
  const stale={...receipt,nonce:'stale_nonce_12345678901234567890',issuedAt:Math.floor(nowMs/1000)-1000,leaseExpiresAt:Math.floor(nowMs/1000)-100};await assert.rejects(()=>verifier(envelope(stale),expected),/STALE/);
  const revoked=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=> 'revoked',executorStatus:async()=> 'active',consumeNonce:async()=>true});await assert.rejects(()=>revoked(envelope({...receipt,nonce:'revoked_nonce_12345678901234567'}),expected),/REVOKED/);
});
