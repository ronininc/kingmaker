// Pure host boundaries. Actual SQLite DO concurrency/storage tests live in
// fleet-coordinator-workerd.proof.mjs and must run for the release review.
import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,createHash} from 'node:crypto';
import worker,{signFleet,RECEIPT_DOMAIN} from '../fleet-host/worker.js';
import {receiptValid,createFleetBundleChallenge} from '../lib/fleet-transport.mjs';
import {buildReusableSkillPacket} from '../lib/reusable-skill-policy.mjs';import {METHOD_IDS,materializeReviewedMethod} from '../lib/reusable-skill-catalog.mjs';import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';
const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({type:'spki',format:'pem'}),priv=keys.privateKey.export({type:'pkcs8',format:'pem'}),id='fi_'+'a'.repeat(32),proof='b'.repeat(64);
const env={FLEET_PUBLIC_KEY:pub,FLEET_SIGNING_KEY:priv,FLEET:{get(){throw Error('KV fallback forbidden');},put(){throw Error('KV fallback forbidden');}},PACKETS:{put(){throw Error('R2 authorization fallback forbidden');}}};
const req=(path,body)=>new Request('https://fleet.test'+path,{method:body?'POST':'GET',headers:{'x-fleet-install':id,'x-fleet-proof':proof},...(body?{body:JSON.stringify(body)}:{})});
test('missing coordinator fails closed without KV/R2 authorization fallback',async()=>{
 const packet=buildReusableSkillPacket({installationId:id,methodIds:['file-review']});assert.equal((await worker.fetch(req('/challenge',{operation:'contribute',requestHash:'a'.repeat(64),certDigest:'b'.repeat(64)}),env)).status,503);assert.equal((await worker.fetch(req('/contribute',{packet,authorization:{}}),env)).status,403);assert.equal((await worker.fetch(req('/bundle',{nonce:'c'.repeat(64),authorization:{}}),env)).status,403);assert.equal((await worker.fetch(req('/forget',{}),env)).status,503);
});
test('host rejects hostile content with signed fixed refusal, no values echoed',async()=>{
 const packet=buildReusableSkillPacket({installationId:id,methodIds:['file-review']});packet.methods[0].instructions+='password: SECRET';packet.packetId='SECRET';const response=await worker.fetch(req('/contribute',{packet}),env);const body=await response.json();assert.equal(body.receipt.accepted,false);assert.equal(body.receipt.packetId,'invalid');assert.ok(!JSON.stringify(body).includes('SECRET'));assert.equal(receiptValid(body.receipt,{publicKeyPem:pub,installationId:id}),true);
 assert.equal((await worker.fetch(new Request('https://fleet.test/contribute',{method:'POST',body:'x'.repeat(262145)}),env)).status,413);
});
test('receipt pins and catalog verifier reject altered signatures/content/replay',async()=>{
 const unsigned={installationId:id,packetId:'fp_'+'a'.repeat(32),accepted:true};const receipt={...unsigned,signature:await signFleet(priv,RECEIPT_DOMAIN,unsigned)};assert.equal(receiptValid(receipt,{publicKeyPem:pub,installationId:id}),true);assert.equal(receiptValid({...receipt,accepted:false},{publicKeyPem:pub,installationId:id}),false);
 const c=createFleetBundleChallenge({publicKeyPem:pub,installationId:id}),methods=METHOD_IDS.map(materializeReviewedMethod),issuedAt=Date.now();const doc={schema:'kingmaker.fleet-bundle/1',installationId:id,nonce:c.nonce,issuedAt,expiresAt:issuedAt+60000,catalogHash:createHash('sha256').update(canonicalJson(methods)).digest('hex'),methods};const r={doc,signature:await signFleet(priv,'kingmaker.fleet-bundle/1',doc)};assert.equal(c.verify(r).verified,true);assert.throws(()=>c.verify(r),/REPLAY/);
 const other=createFleetBundleChallenge({publicKeyPem:pub,installationId:id});assert.throws(()=>other.verify(r),/UNTRUSTED/);
});

test('fleet verifier pin equals existing enrollment authority and fixture override is double gated',async()=>{
 const {readFileSync}=await import('node:fs');const {INSTALL_AUTHORITY_PUBLIC_KEY}=await import('../fleet-host/install-authority-key.mjs');const {createFleetWorkerForFixture}=await import('../fleet-host/worker.js');
 assert.equal(INSTALL_AUTHORITY_PUBLIC_KEY,readFileSync(new URL('../lib/ronin-install-cert-public.pem',import.meta.url),'utf8'));
 const old=process.env.NODE_ENV;delete process.env.NODE_ENV;try{assert.throws(()=>createFleetWorkerForFixture('fake'),/FIXTURE_TRUST_DISABLED/);}finally{if(old!==undefined)process.env.NODE_ENV=old;}
});
