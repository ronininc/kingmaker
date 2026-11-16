// No client-asserted identity tuples or authorization booleans. Existing pinned
// certificate authority and trusted service bindings are the only authorities.
import {Buffer} from 'node:buffer';
import {createHash,randomBytes,verify} from 'node:crypto';
import {INSTALL_AUTHORITY_PUBLIC_KEY} from './install-authority-key.mjs';
function verifyEntitlementEnvelope(e,pem){try{if(e?.alg!=='ES256'||typeof e.payload!=='string'||e.payload.length>32768||typeof e.sig!=='string'||e.sig.length>256)return null;return verify('sha256',Buffer.from(e.payload),{key:pem,dsaEncoding:'der'},Buffer.from(e.sig,'base64'))?JSON.parse(e.payload):null;}catch{return null;}}
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function createFleetConsentAuthority(){return makeAuthority(INSTALL_AUTHORITY_PUBLIC_KEY);}
export function createFleetConsentAuthorityForFixture(certKeyPem){
 if(process.env.NODE_ENV!=='test'||process.env.KINGMAKER_DOUBLE_FIXTURE_GATE!=='1')throw Error('FIXTURE_TRUST_DISABLED');return makeAuthority(certKeyPem);
}
function makeAuthority(certKeyPem){return async function authorize({env,authorization,fleetInstallId,proof}){
 if(!env.FLEET_AUTHORITY?.evaluateFleetSharingEvidence)throw Error('FLEET_AUTHORITY_UNAVAILABLE');
 if(!authorization||Object.keys(authorization).sort().join(',')!=='installCertificate,providerFingerprint,status'||!/^fi_[a-f0-9]{32}$/.test(fleetInstallId)||!/^[a-f0-9]{64}$/.test(proof))throw Error('FLEET_ENROLLMENT_INVALID');
 const certificate=authorization.installCertificate,c=verifyEntitlementEnvelope(certificate,certKeyPem);
 if(!c||c.schema!=='ronin.install-cert/1'||c.issuer!=='ronin-update-host'||c.bundleId!=='com.ronininc.solghost'||!/^[0-9a-f-]{8,64}$/i.test(c.installId||'')||!/^[a-f0-9]{64}$/.test(c.deviceSha256||'')||!/^[a-f0-9]{64}$/.test(c.keySha||'')||typeof c.releaseTag!=='string'||!c.releaseTag||!Number.isFinite(Date.parse(c.issuedAt))||Date.parse(c.issuedAt)>Date.now()+300000||!/^[a-f0-9]{64}$/.test(authorization.providerFingerprint||''))throw Error('FLEET_ENROLLMENT_INVALID');
 const s=verifyEntitlementEnvelope(authorization.status,certKeyPem),at=Date.now(),seconds=Math.floor(at/1000),certDigest=hash(canonicalJson(certificate));
 if(!s||s.schema!=='ronin.install-cert-status/1'||s.issuer!=='ronin-update-host'||s.bundleId!==c.bundleId||s.installId!==c.installId||s.deviceSha256!==c.deviceSha256||s.keySha!==c.keySha||s.releaseTag!==c.releaseTag||s.certDigest!==Buffer.from(certDigest,'hex').toString('base64url')||!/^[a-f0-9]{64}$/.test(s.nonce||'')||s.complete!==true||s.current!==true||s.revoked!==false||!Number.isInteger(s.issuedAt)||!Number.isInteger(s.expiresAt)||s.issuedAt>seconds+5||s.expiresAt<=seconds||s.expiresAt>s.issuedAt+120)throw Error('FLEET_INSTALL_STATUS_INVALID');
 const authorityNonce=randomBytes(32).toString('hex');let timer,e;
 try{e=await Promise.race([env.FLEET_AUTHORITY.evaluateFleetSharingEvidence({installId:c.installId,deviceSha256:c.deviceSha256,providerFingerprint:authorization.providerFingerprint,fleetInstallId,proofSha256:hash(proof),nonce:authorityNonce}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('authority deadline')),5000);})]);}finally{clearTimeout(timer);}
 const current=Date.now();if(!e||Object.keys(e).sort().join(',')!=='current,expiresAt,nonce,verifiedAt'||e.current!==true||e.nonce!==authorityNonce||!Number.isSafeInteger(e.verifiedAt)||!Number.isSafeInteger(e.expiresAt)||e.verifiedAt<at-5000||e.verifiedAt>current+5000||e.expiresAt<=current||e.expiresAt>e.verifiedAt+60000)throw Error('FLEET_CONSENT_NOT_CURRENT');
 return {expiresAt:Math.min(e.expiresAt,s.expiresAt*1000),nonce:s.nonce,certDigest};
};}
