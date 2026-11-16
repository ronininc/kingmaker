// Local-only real workerd service-binding proof. Synthetic identities and records only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {generateKeyPairSync,createHash,sign,verify} from 'node:crypto';
const crm=process.env.PLATFORM_AUTHORITY_CHECKOUT;
if(!crm) throw new Error('PLATFORM_AUTHORITY_CHECKOUT must identify the reviewed CRM checkout');
const require=createRequire(resolve(crm,'package.json'));
const {build}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare');
const bundle=await build({entryPoints:[resolve(crm,'worker/platform-authority-rpc.ts')],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
const bridge=await build({entryPoints:[resolve(crm,'worker/platform-authority-bridge.ts')],bundle:true,write:false,format:'esm',platform:'node'});
const {signAuthorityEnvelope}=await import('data:text/javascript;base64,'+Buffer.from(bridge.outputFiles[0].text).toString('base64'));
const ingestionBundle=await build({entryPoints:[resolve(crm,'worker/platform-authority-ingestion.ts')],bundle:true,write:false,format:'esm',platform:'node'});
const {ingestPlatformAuthorityEvent}=await import('data:text/javascript;base64,'+Buffer.from(ingestionBundle.outputFiles[0].text).toString('base64'));
const authority=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const host=generateKeyPairSync('ec',{namedCurve:'P-256'}),pub=host.publicKey.export({type:'spki',format:'pem'});
const sha=x=>createHash('sha256').update(x).digest('hex');
const bearer='local-synthetic-token',installId='12345678-1234-1234-1234-123456789012',deviceSha256='a'.repeat(64),providerFingerprint='b'.repeat(64);
const mf=new Miniflare(convertV4MiniflareOptions({workers:[
 {name:'update-host',modules:true,script:await readFile(new URL('../update-host/worker.js',import.meta.url),'utf8'),compatibilityDate:'2026-09-01',kvNamespaces:['DEVICES'],r2Buckets:['RELEASES'],bindings:{CERT_SIGNING_KEY:host.privateKey.export({type:'pkcs8',format:'pem'})},serviceBindings:{CRM_CAPABILITIES:{name:'crm-authority',entrypoint:'PlatformCapabilityAuthority'}}},
 {name:'crm-authority',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-01',d1Databases:['DB'],bindings:{PLATFORM_AUTHORITY_RECORD_PUBLIC_KEYS:JSON.stringify({synthetic:await crypto.subtle.exportKey('jwk',authority.publicKey)})}}
]}));
try{
 const db=await mf.getD1Database('DB','crm-authority');
 for(const sql of (await readFile(resolve(crm,'docs/review/platform-authority-schema.sql'),'utf8')).replace(/--[^\n]*/g,'').split(';').filter(s=>s.trim())) await db.prepare(sql).run();
 for(const sql of [
 'CREATE TABLE launcher_device_identity_heads(current_event_id TEXT,tenant_id TEXT,certified_installation_id TEXT,application_id TEXT,member_id TEXT)',
 'CREATE TABLE launcher_device_identity_events(id TEXT,tenant_id TEXT,certified_installation_id TEXT,application_id TEXT,member_id TEXT,device_sha256 TEXT,state TEXT)',
 'CREATE TABLE member_application_bindings(tenant_id TEXT,application_id TEXT,member_id TEXT)'
 ]) await db.prepare(sql).run();
 await db.prepare("INSERT INTO launcher_device_identity_heads VALUES('event','ronin',?,'app','member')").bind(installId).run();
 await db.prepare("INSERT INTO launcher_device_identity_events VALUES('event','ronin',?,'app','member',?,'valid')").bind(installId,deviceSha256).run();
 await db.prepare("INSERT INTO member_application_bindings VALUES('ronin','app','member')").run();
 await (await mf.getKVNamespace('DEVICES','update-host')).put('key:'+sha(bearer),JSON.stringify({device:deviceSha256,revoked:false}));
 await (await mf.getR2Bucket('RELEASES','update-host')).put('latest.json',JSON.stringify({tag:'v4.5.3'}));
 const payload=JSON.stringify({schema:'ronin.install-cert/1',issuer:'ronin-update-host',bundleId:'com.ronininc.solghost',installId,deviceSha256,keySha:sha(bearer),releaseTag:'v4.5.3',issuedAt:new Date().toISOString()});
 const cert={payload,sig:sign('sha256',Buffer.from(payload),host.privateKey).toString('base64'),alg:'ES256'};
 const call=(path,body)=>mf.dispatchFetch('https://local.test/'+path,{method:'POST',headers:{authorization:'Bearer '+bearer},body:JSON.stringify({installCertificate:cert,...body})});
 assert.notEqual((await call('capability-grant',{providerFingerprint,basis:'paid'})).status,200,'no records must deny');
 for(const basis of ['paid','fleet']){
  const at=Date.now(),binding={memberId:'member',installId,deviceSha256,providerFingerprint};
  const current={id:'current',startsAt:at-1000,expiresAt:at+120000,revokedAt:null};
  const snapshot={binding,account:{...current,active:true},device:{...current,active:true,proofVerified:true},provider:{...current,active:true,proofVerified:true},paid:{...current,confirmed:true,product:'ronin-platform',offerId:'ronin-platform-usd-99-monthly-v1'},fleet:{...current,id:'consent',decision:'affirmative',proofVerified:true,purpose:'fleet-participation-for-platform-benefits',consentVersion:1,disclosureDigest:'e36af28bdeb5fe7ad71fae31ba727d700a9d0e193ea6cc2073904a44999f9d32',binding},grantRevoked:false};
  const source=basis==='paid'?'confirmed-payment-authority':'authenticated-consent-authority';
  const policy={sourceKeyId:'synthetic',sourcePublicKey:authority.publicKey,recordKeyId:'synthetic',recordPrivateKey:authority.privateKey,source,approvedOffer:{id:'ronin-platform-usd-99-monthly-v1',amountMinor:9900,currency:'USD',cadence:'monthly'},approvedDisclosure:{version:1,digest:'e36af28bdeb5fe7ad71fae31ba727d700a9d0e193ea6cc2073904a44999f9d32'}};
  const event={schema:'ronin.platform-authority-event/1',audience:'ronin-crm',source,id:'rpc-'+basis,issuedAt:at,expiresAt:at+60000,query:{...binding,basis},action:'grant',snapshot,payment:{state:'confirmed',reference:'synthetic-payment',periodStartsAt:current.startsAt,periodEndsAt:current.expiresAt,offerId:'ronin-platform-usd-99-monthly-v1',amountMinor:9900,currency:'USD',cadence:'monthly'},consent:{action:'affirmative',authenticatedMemberId:'member',sessionEvidenceRef:'synthetic-session',disclosureDigest:policy.approvedDisclosure.digest,sharingScope:'generalized-skills-and-tool-use-only'}};
  const signedEvent=await signAuthorityEnvelope(event,'synthetic',authority.privateKey);
  const ingested=await ingestPlatformAuthorityEvent(db,signedEvent,policy,at);assert.equal(ingested.accepted,true,JSON.stringify(ingested));
  assert.equal((await ingestPlatformAuthorityEvent(db,signedEvent,policy,at)).duplicate,true);
  const response=await call('capability-grant',{providerFingerprint,basis});assert.equal(response.status,200,await response.clone().text());
  const grant=await response.json();assert(verify('sha256',Buffer.from(grant.payload),pub,Buffer.from(grant.sig,'base64')));
  assert.equal(JSON.parse(grant.payload).memberId,'member');
  const challenge={schema:'ronin.capability-status-challenge/1',nonce:'f'.repeat(64),grantDigest:sha(grant.payload),installId,deviceSha256};
  assert.equal((await call('capability-status',{grant,challenge})).status,200);
  const withdrawal={...event,id:'revoke-'+basis,action:'revoke',evidenceId:ingested.evidenceId};
  assert.equal((await ingestPlatformAuthorityEvent(db,await signAuthorityEnvelope(withdrawal,'synthetic',authority.privateKey),policy,Date.now())).revoked,true);
  assert.notEqual((await call('capability-status',{grant,challenge})).status,200);
 }
 console.log('PASS real local workerd named service binding: host -> CRM WorkerEntrypoint -> D1. Verified signed-source ingestion and idempotency, both signed paid/fleet grants and current status succeed; missing records and revoked evidence deny. Synthetic only; no deployed binding, ingestion, billing or consent claimed.');
}finally{await mf.dispose();}
