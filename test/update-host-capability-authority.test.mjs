import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,createHash,sign,verify} from 'node:crypto';
import {createUnifiedCapabilityAccessForFixture} from '../lib/unified-capability-access.mjs';
const worker=(await import('data:text/javascript;base64,'+readFileSync(new URL('../update-host/worker.js',import.meta.url)).toString('base64'))).default;
const keys=generateKeyPairSync('ec',{namedCurve:'P-256'}),pem=keys.privateKey.export({type:'pkcs8',format:'pem'}),pub=keys.publicKey.export({type:'spki',format:'pem'});
const bearer='synthetic-capability-bearer',hash=x=>createHash('sha256').update(x).digest('hex');
const identity=Object.fromEntries(Object.entries({x25519:'x25519',ed25519:'ed25519',mlkem768:'ml-kem-768',mldsa65:'ml-dsa-65'}).map(([n,t])=>[n,generateKeyPairSync(t).publicKey.export({type:'spki',format:'der'}).toString('base64')]));
const providerFingerprint=hash(JSON.stringify(identity)),installId='12345678-1234-1234-1234-123456789012',deviceSha256='a'.repeat(64);
const payload=JSON.stringify({schema:'ronin.install-cert/1',issuer:'ronin-update-host',bundleId:'com.ronininc.solghost',installId,deviceSha256,keySha:hash(bearer),releaseTag:'v4.5.3',issuedAt:new Date(Date.now()-1000).toISOString()});
const cert={payload,sig:sign('sha256',Buffer.from(payload),keys.privateKey).toString('base64'),alg:'ES256'};
const env=(overrides={})=>({CERT_SIGNING_KEY:pem,DEVICES:{async get(k){return k===`key:${hash(bearer)}`?{device:deviceSha256,revoked:false}:null;}},RELEASES:{async get(){return{async json(){return{tag:'v4.5.3'};}};}},CRM_CAPABILITIES:{async evaluateCapabilityEvidence(q){const at=Date.now();return {...q,memberId:'member-from-database',current:true,capabilities:['ronin.skill-base','scripture-armor.pqc'],evidenceId:'record-1',consent:q.basis==='fleet'?{id:'consent-1',version:1}:null,verifiedAt:at,expiresAt:at+60000};}},...overrides});
const call=(path,body,e=env(),token=bearer)=>worker.fetch(new Request('https://host/'+path,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({installCertificate:cert,...body})}),e);
const issue=(basis='paid',e=env())=>call('capability-grant',{providerFingerprint,basis},e);
const read=async r=>{assert.equal(r.status,200);const e=await r.json();assert(verify('sha256',Buffer.from(e.payload),pub,Buffer.from(e.sig,'base64')));return e;};
test('real host issued paid/fleet grants and current status accepted by actual consumer',async()=>{
 process.env.NODE_ENV='test';process.env.KINGMAKER_DOUBLE_FIXTURE_GATE='1';
 for(const basis of ['paid','fleet']){
  const grant=await read(await issue(basis));const c=JSON.parse(grant.payload);assert.equal(c.memberId,'member-from-database');assert.equal(c.basis,basis);
  const access=createUnifiedCapabilityAccessForFixture({installation:{installId,deviceSha256},publicIdentity:identity,readFleetConsent:()=>({optedIn:true,withdrawn:false,id:'consent-1',version:1,acceptedAt:Date.now()-1000})},pub);
  const challenge=access.begin(grant),status=await read(await call('capability-status',{grant,challenge}));
  assert.equal((await access.authorize({capability:'ronin.skill-base',grant,status})).basis,basis);
 }
});
test('missing service/signing config and wrong enrollment fail closed',async()=>{
 assert.equal((await issue('paid',env({CRM_CAPABILITIES:undefined}))).status,503);
 assert.equal((await issue('paid',env({CERT_SIGNING_KEY:undefined}))).status,503);
 assert.equal((await call('capability-grant',{providerFingerprint,basis:'paid'},env(),'bad')).status,401);
 assert.equal((await call('capability-grant',{providerFingerprint,basis:'paid',installCertificate:{...cert,payload:payload+' '}})).status,401);
});
test('client payment assertions, bare opt-in, wrong nonce and binding cannot mint grant',async()=>{
 for(const change of [{current:false},{nonce:'bad'},{deviceSha256:'b'.repeat(64)},{memberId:''},{consent:{id:'fake',version:1}},{expiresAt:Date.now()+999999}]){
 const e=env();const original=e.CRM_CAPABILITIES.evaluateCapabilityEvidence;e.CRM_CAPABILITIES.evaluateCapabilityEvidence=async q=>({...await original(q),...change});
 assert.notEqual((await call('capability-grant',{providerFingerprint,basis:'paid',paid:true,optedIn:true},e)).status,200);
 }
});
test('status rechecks evidence and rejects stale, changed, revoked or mismatched grants',async()=>{
 const grant=await read(await issue());const c=JSON.parse(grant.payload);
 const challenge={schema:'ronin.capability-status-challenge/1',nonce:'f'.repeat(64),grantDigest:hash(grant.payload),installId,deviceSha256};
 const e=env();const original=e.CRM_CAPABILITIES.evaluateCapabilityEvidence;e.CRM_CAPABILITIES.evaluateCapabilityEvidence=async q=>({...await original(q),evidenceId:'replacement'});
 assert.equal((await call('capability-status',{grant,challenge},e)).status,403);
 assert.equal((await call('capability-status',{grant,challenge:{...challenge,nonce:'bad'}})).status,401);
 const revoked=env({DEVICES:{async get(){return {device:deviceSha256,revoked:true};}}});assert.equal((await call('capability-status',{grant,challenge},revoked)).status,401);
});
