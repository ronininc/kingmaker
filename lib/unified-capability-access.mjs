// Free base is independent. Extended Ronin features require an authority-signed
// capability grant and current status, plus real PQ provider possession for Armor.
// Fleet opt-in alone is not a grant; payment assertions are never accepted here.
import { createHash, randomBytes } from 'node:crypto';
import { verifyInstallCertificate } from './install-docking.mjs';
import { CERT_KEY_PEM, verifyEntitlementEnvelope } from './addons.mjs';
import { isVerifiedArmorProviderProof, validateArmorPublicIdentity } from './armor-dock-provider.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const CAPABILITIES = new Set(['ronin.skill-base','scripture-armor.pqc']);
export function createUnifiedCapabilityAccess(config={}) {
  if ('certKeyPem' in config || 'installation' in config || 'now' in config || 'clock' in config) throw Error('PRODUCTION_TRUST_OVERRIDE_FORBIDDEN');
  const cert=verifyInstallCertificate(config.installCertificate,{deviceSha256:config.deviceSha256,certKeyPem:CERT_KEY_PEM,now:Date.now});
  if(!cert.ok)throw Error('VERIFIED_INSTALLATION_REQUIRED');
  return makeAccess({...config,installation:{installId:cert.installId,deviceSha256:cert.deviceSha256}},CERT_KEY_PEM);
}
export function createUnifiedCapabilityAccessForFixture(config={},certKeyPem) {
  if(process.env.NODE_ENV!=='test'||process.env.KINGMAKER_DOUBLE_FIXTURE_GATE!=='1')throw Error('FIXTURE_TRUST_DISABLED');
  return makeAccess(config,certKeyPem);
}
function makeAccess({installation, publicIdentity, readFleetConsent=()=>null, now=Date.now}={},certKeyPem) {
  if(!installation?.installId||!/^[0-9a-f]{64}$/.test(installation.deviceSha256||''))throw Error('VERIFIED_INSTALLATION_REQUIRED');
  validateArmorPublicIdentity(publicIdentity);
  const providerFingerprint=hash(JSON.stringify(publicIdentity));
  const pending=new Map();
  return {
    baseAccess:()=>Object.freeze({allowed:true,basis:'free',capabilities:['kingmaker.base']}),
    begin(grant) {
      const claims=verifyEntitlementEnvelope(grant,certKeyPem);
      if(!claims)throw Error('CAPABILITY_GRANT_SIGNATURE_INVALID');
      const nonce=randomBytes(32).toString('hex'),at=now();
      for(const [n,v]of pending)if(at-v.at>60000)pending.delete(n);
      if(pending.size>=16)throw Error('CAPABILITY_CHALLENGE_LIMIT');
      const grantDigest=hash(grant.payload);
      pending.set(nonce,{at,grantDigest});
      return Object.freeze({schema:'ronin.capability-status-challenge/1',nonce,grantDigest,installId:installation.installId,deviceSha256:installation.deviceSha256});
    },
    async authorize({capability,grant,status,providerProof}={}) {
      if(!CAPABILITIES.has(capability))throw Error('CAPABILITY_UNKNOWN');
      const c=verifyEntitlementEnvelope(grant,certKeyPem),s=verifyEntitlementEnvelope(status,certKeyPem),at=now();
      if(!c||!s)throw Error('CAPABILITY_AUTHORITY_SIGNATURE_REQUIRED');
      const p=pending.get(s.nonce);pending.delete(s.nonce);
      if(!p||at-p.at>60000||s.grantDigest!==p.grantDigest||p.grantDigest!==hash(grant.payload))throw Error('CAPABILITY_STATUS_REPLAY_OR_MISMATCH');
      const timeValid=x=>Number.isSafeInteger(x.issuedAt)&&Number.isSafeInteger(x.expiresAt)&&x.issuedAt<=at&&x.expiresAt>at;
      if(c.schema!=='ronin.capability-grant/1'||c.issuer!=='ronin-update-host'||c.product!=='kingmaker'
        ||!['paid','fleet'].includes(c.basis)||typeof c.grantId!=='string'||!c.grantId||!timeValid(c)
        ||c.installId!==installation.installId||c.deviceSha256!==installation.deviceSha256
        ||c.providerFingerprint!==providerFingerprint||!Array.isArray(c.capabilities)||!c.capabilities.includes(capability)
        ||c.capabilities.some(x=>!CAPABILITIES.has(x)))throw Error('CAPABILITY_GRANT_INVALID');
      if(s.schema!=='ronin.capability-status/1'||s.issuer!=='ronin-update-host'||s.grantId!==c.grantId
        ||s.installId!==c.installId||s.deviceSha256!==c.deviceSha256||s.current!==true||s.revoked!==false
        ||!timeValid(s)||s.issuedAt<p.at||s.expiresAt>s.issuedAt+60000)throw Error('CAPABILITY_STATUS_INVALID');
      if(c.basis==='fleet') {
        const consent=await readFleetConsent();
        if(!c.consent||typeof c.consent.id!=='string'||!c.consent.id||!Number.isSafeInteger(c.consent.version)||c.consent.version<1||!consent||consent.optedIn!==true||consent.withdrawn===true||consent.id!==c.consent.id
          ||consent.version!==c.consent.version||!Number.isSafeInteger(consent.acceptedAt)||consent.acceptedAt>at)throw Error('EXPLICIT_FLEET_CONSENT_REQUIRED');
      }
      if(capability==='scripture-armor.pqc'&&(!isVerifiedArmorProviderProof(providerProof)||providerProof.providerFingerprint!==providerFingerprint||providerProof.expiresAt<=now()))throw Error('VERIFIED_PQC_PROVIDER_REQUIRED');
      return Object.freeze({allowed:true,capability,basis:c.basis,grantId:c.grantId,expiresAt:Math.min(c.expiresAt,s.expiresAt),providerFingerprint});
    },
  };
}
