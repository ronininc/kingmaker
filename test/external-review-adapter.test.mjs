import { armorFixture, armorAttemptId } from './helpers/scripture-command-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableJobPool } from '../lib/durable-job-pool.mjs';
import { createJobDispatcher } from '../lib/job-dispatcher.mjs';
import { createExternalDispatchReceiptVerifier, createLocalStaticReviewAdapter, externalSecurityManifestSha256, normalizeExternalSecurityManifest, EXTERNAL_REVIEW_ADAPTER } from '../lib/external-review-adapter.mjs';
import { ARMOR_KEM_SKIP } from './helpers/host-tool-skips.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'external-review-'));
const externalJobId='11111111-1111-4111-8111-111111111111',boardJobId='22222222-2222-4222-8222-222222222222',nativeOpportunityId='44444444-4444-4444-8444-444444444444';
function manifest(commit='63837fb778d6a39f02be0ce76ff89f2bc8d74bdc') { return {schema:'ronin.external-security-scope/v1',program:'GitHub CLI Security Bug Bounty',officialRulesUrl:'https://bounty.example.invalid/rules',rulesVersion:'pending-official-payload',repositoryUrl:'https://github.com/cli/cli',commitSha:commit,sourceRootId:'fixture-root',includedAssets:['github.com/cli/cli at the exact commit'],excludedAssets:['live GitHub accounts','production credentials'],allowedMethods:['offline source review','mocked transport tests'],prohibitedMethods:['live credential access','production probing'],aiPolicy:'AI-assisted analysis requires independent verification.',credentialPolicy:'Synthetic tokens and mocked transports only until separately approved.',submissionPolicy:'Owner review is required before any external submission.',safeHarbor:'Official scope must authorize this exact review.',rulesSnapshotDigest:'d'.repeat(64)}; }
function dispatch(root,commit) { const m=manifest(commit);return {schema:'ronin.external-security-local-dispatch/v1',externalJobId,boardJobId,nativeOpportunityId,manifest:m,manifestSha256:externalSecurityManifestSha256(m),dispatchReceipt:{fixture:'signed-receipt'},execution:{mode:'local-static-source-review',localSourcePath:root,network:false,credentials:'fake-only',submission:'owner-approval-required'}}; }
function fixtureRepo(){const root=temp(),env={PATH:'/usr/bin:/bin',HOME:root,LANG:'C',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},git=(args)=>execFileSync('/usr/bin/git',['-C',root,...args],{env});git(['init','-q']);writeFileSync(join(root,'fixture.go'),'package fixture\n');git(['add','fixture.go']);git(['commit','-qm','fixture']);return{root,commit:git(['rev-parse','HEAD']).toString().trim()}}
const trust={verifyDispatchReceipt:async()=>({authorized:true,receiptId:'receipt-fixture',attemptId:armorAttemptId,authorityKeyId:'fixture-key',completeAdmission:(e)=>e})};

test('durable external review uses exact CRM manifest digest and stays review-held', { skip: ARMOR_KEM_SKIP }, async()=>{
  const repo=fixtureRepo(),dir=temp(),source=repo.root,m=dispatch(source,repo.commit);
  const pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite')});
  const job=pool.submit({jobId:m.externalJobId,text:JSON.stringify(m),idempotencyKey:`external:${m.externalJobId}:${m.manifestSha256}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});
  const adapter=createLocalStaticReviewAdapter({allowedRoots:[source],...trust,...armorFixture(m),armorAttemptId});
  const done=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}}).runOne();
  assert.equal(done.state,'done');assert.equal(done.evidence.externalJobId,externalJobId);assert.equal(done.evidence.boardJobId,boardJobId);assert.equal(done.evidence.manifestSha256,m.manifestSha256);assert.equal(done.evidence.reviewRequired,true);assert.equal(done.evidence.submissionAllowed,false);assert.equal(done.evidence.networkIsolation,'not-os-enforced');assert.equal(done.evidence.targetCodeExecuted,false);assert.equal(done.evidence.vulnerabilityDiscoveryClaimed,false);assert.equal(done.evidence.analyzerEvidence.files,1);assert.equal(done.evidence.workingTreeRead,false);
  assert.deepEqual(pool.events(job.id).map((e)=>e.event),['submitted','claimed','acknowledged','started','evidence_recorded','review_required','completed']);pool.close();
});

test('adapter refuses pending scope, digest, policy, method, source or id widening', { skip: ARMOR_KEM_SKIP }, async()=>{
  const repo=fixtureRepo(),dir=temp(),source=repo.root,base=dispatch(source,repo.commit);
  const run=async(change,id=externalJobId,receiptVerifier=trust.verifyDispatchReceipt)=>{const pool=createDurableJobPool({path:join(temp(),'queue','jobs.sqlite'),maxAttempts:1});const m=structuredClone(base);change(m);pool.submit({jobId:id,text:JSON.stringify(m),idempotencyKey:`external:refuse:${Math.random()}`,adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});const a=createLocalStaticReviewAdapter({allowedRoots:[source],...trust,verifyDispatchReceipt:receiptVerifier,...armorFixture(m),armorAttemptId});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:a}}).runOne();assert.equal(out.state,'failed');pool.close();};
  await run(()=>{},externalJobId,async()=>({authorized:false}));await run((m)=>{m.manifestSha256='0'.repeat(64);});await run((m)=>{m.execution.network=true;});await run((m)=>{m.command='curl target';});await run((m)=>{m.manifest.allowedMethods=['active scan'];m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run((m)=>{m.manifest.commitSha='0'.repeat(40);m.manifestSha256=externalSecurityManifestSha256(m.manifest);});await run(()=>{},'33333333-3333-4333-8333-333333333333');
});

test('adapter rejects a source-root alias before reading Git objects', { skip: ARMOR_KEM_SKIP }, async()=>{
  const repo=fixtureRepo(),dir=temp(),source=join(dir,'alias');symlinkSync(repo.root,source);const m=dispatch(source,repo.commit),pool=createDurableJobPool({path:join(dir,'queue','jobs.sqlite'),maxAttempts:1});pool.submit({jobId:externalJobId,text:JSON.stringify(m),idempotencyKey:'external:alias:fixture',adapter:EXTERNAL_REVIEW_ADAPTER,attempts:1});const adapter=createLocalStaticReviewAdapter({allowedRoots:[dir],...trust,...armorFixture(m),armorAttemptId});const out=await createJobDispatcher({pool,workerId:'little-brother-local-test',adapters:{[EXTERNAL_REVIEW_ADAPTER]:adapter}}).runOne();assert.equal(out.state,'failed');pool.close();
});

test('source root identifiers exactly match the CRM 1..128 contract',()=>{
  for(const value of ['a','ab','x'.repeat(120),'x'.repeat(128)])assert.equal(normalizeExternalSecurityManifest({...manifest(),sourceRootId:value}).sourceRootId,value);
  for(const value of ['','x'.repeat(129),'bad/root','bad root'])assert.throws(()=>normalizeExternalSecurityManifest({...manifest(),sourceRootId:value}),/EXTERNAL_SCOPE_INCOMPLETE/);
});

test('CRM Ed25519 receipt binds exact fresh scope, registered authority and one nonce',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),nowMs=1_800_000_000_000,executor={id:'executor-fixture',fingerprint:'e'.repeat(64),evidenceSigningFingerprint:'f'.repeat(64)},admitted=new Map(),leaseToken='lease-token-fixture';
  const expected={externalJobId,boardJobId,nativeOpportunityId,sourceRootId:'fixture-root',manifestSha256:'a'.repeat(64),rulesSnapshotDigest:'d'.repeat(64),commitSha:'63837fb778d6a39f02be0ce76ff89f2bc8d74bdc'};
  const attemptId='55555555-5555-4555-8555-555555555555',authorityExpiresAt=Math.floor(nowMs/1000)+1000,leaseTokenHash=createHash('sha256').update(leaseToken).digest('hex'),receipt={schema:'ronin.external-security-dispatch/v1',jobId:externalJobId,boardJobId,sourceRootId:'fixture-root',nativeOpportunityId,manifestDigest:expected.manifestSha256,rulesSnapshotDigest:expected.rulesSnapshotDigest,sourceCommit:expected.commitSha,executorRegistrationId:executor.id,executorFingerprint:executor.fingerprint,executorEvidenceSigningFingerprint:executor.evidenceSigningFingerprint,attemptId,rootAttemptId:attemptId,generation:1,leaseTokenHash,leaseExpiresAt:Math.floor(nowMs/1000)+600,nonce:'fresh_nonce_12345678901234567890',issuedAt:Math.floor(nowMs/1000),authorityExpiresAt};
  const current=(r=receipt)=>({status:'queued',supersededAt:null,jobId:r.jobId,manifestSha256:r.manifestDigest,executorId:r.executorRegistrationId,leaseTokenHash:r.leaseTokenHash,leaseExpiresAt:r.leaseExpiresAt,nonce:r.nonce,dispatchKeyId:'key-fixture',rootAttemptId:r.rootAttemptId,previousAttemptId:r.previousAttemptId??null,generation:r.generation});
  const admissionStore={admit(x){const k=`${x.keyId}:${x.nonce}`,p=admitted.get(k);if(p&&(p.attemptId!==x.attemptId||p.jobId!==x.jobId||p.receiptSha256!==x.receiptSha256))throw new Error('EXTERNAL_DISPATCH_REPLAY_CONFLICT');if(!p)admitted.set(k,{...x,status:'admitted'});return{duplicate:!!p,status:p?.status??'admitted',evidence:p?.evidence??null};},complete(x){const k=`${x.keyId}:${x.nonce}`;admitted.set(k,{...admitted.get(k),status:'completed',evidence:x.evidence});return x.evidence;}};
  const verifier=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=>({active:true,expiresAt:authorityExpiresAt}),executorStatus:async()=>({active:true}),attemptStatus:async()=>current(),admissionStore});
  const envelope=(r=receipt,token=leaseToken)=>({lease_token:token,receipt:r,signature:{keyId:'key-fixture',value:sign(null,Buffer.from(JSON.stringify(r,Object.keys(r).sort())),privateKey).toString('base64url')}});
  const first=await verifier(envelope(),expected);assert.equal(first.authorized,true);assert.equal((await verifier(envelope(),expected)).authorized,true);first.completeAdmission({kind:'fixture'});assert.deepEqual((await verifier(envelope(),expected)).completedEvidence,{kind:'fixture'});
  const conflict={...receipt,issuedAt:receipt.issuedAt-1};await assert.rejects(()=>verifier(envelope(conflict),expected),/REPLAY_CONFLICT/);
  const tampered={...receipt,nonce:'other_nonce_12345678901234567890',sourceCommit:'0'.repeat(40)};await assert.rejects(()=>verifier(envelope(tampered),expected),/BINDING/);
  const stale={...receipt,nonce:'stale_nonce_12345678901234567890',issuedAt:Math.floor(nowMs/1000)-1000,leaseExpiresAt:Math.floor(nowMs/1000)-100};await assert.rejects(()=>verifier(envelope(stale),expected),/STALE/);
  await assert.rejects(()=>verifier(envelope({...receipt,nonce:'token_nonce_123456789012345678'},'wrong-token'),expected),/LEASE_TOKEN/);
  const revoked=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=>({active:false,revoked:true}),executorStatus:async()=>({active:true}),attemptStatus:async()=>current(),admissionStore});await assert.rejects(()=>revoked(envelope({...receipt,nonce:'revoked_nonce_12345678901234567'}),expected),/REVOKED/);
  const expired=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=>({active:true,expiresAt:Math.floor(nowMs/1000)-1}),executorStatus:async()=>({active:true}),attemptStatus:async()=>current(),admissionStore});await assert.rejects(()=>expired(envelope({...receipt,nonce:'expired_nonce_12345678901234567'}),expected),/REVOKED/);
  const changed=createExternalDispatchReceiptVerifier({authorities:{'key-fixture':{publicJwk:publicKey.export({format:'jwk'})}},executorRegistration:executor,now:()=>nowMs,authorityStatus:async()=>({active:true,expiresAt:authorityExpiresAt}),executorStatus:async()=>({active:true}),attemptStatus:async()=>({...current(),status:'cancelled'}),admissionStore});await assert.rejects(()=>changed(envelope({...receipt,nonce:'changed_nonce_12345678901234567'}),expected),/ATTEMPT_CHANGED/);
});

test('authority lookup delay cannot carry an expired admission into Git inventory', { skip: ARMOR_KEM_SKIP }, async () => {
  const repo = fixtureRepo(), m = dispatch(repo.root, repo.commit); let now = Date.now();
  const armor = armorFixture(m, armorAttemptId, { now: () => now });
  const adapter = createLocalStaticReviewAdapter({ allowedRoots: [repo.root], ...armor, armorAttemptId,
    verifyDispatchReceipt: async () => { now += 60_001; return trust.verifyDispatchReceipt(); } });
  await assert.rejects(() => adapter({ id: m.externalJobId, text: JSON.stringify(m), attempt: 1 }), /SCRIPTURE_COMMAND_ADMISSION_REQUIRED/);
  armor.commandGate.close();
});
