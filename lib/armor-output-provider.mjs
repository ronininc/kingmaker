// Public protocol only: encryption and private keys stay in standalone Armor.
import {createHash,randomBytes,verify} from 'node:crypto';
import {validateArmorPublicIdentity,armorOwnerRoundTrip,requestStandaloneArmorProof} from './armor-dock-provider.mjs';
import {createUnifiedCapabilityAccess,createUnifiedCapabilityAccessForFixture} from './unified-capability-access.mjs';
import {createGeneratedOutputProtection} from './generated-output-protection.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain='scripture-armor.output-receipt/1';
export function createArmorOutputChallenge({bytes,language,recipient,publicIdentity,now=Date.now}={}) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>262144||!/^[-A-Za-z0-9_.+]{1,64}$/.test(language||''))throw Error('ARMOR_OUTPUT_INPUT_INVALID');
  const identity=structuredClone(publicIdentity),keys=validateArmorPublicIdentity(identity),receiver=structuredClone(recipient);
  validateArmorPublicIdentity(receiver);
  const inputHash=hash(bytes),recipientHash=hash(JSON.stringify(receiver)),issued=now();
  const request=Object.freeze({cmd:'seal-output',audience:'kingmaker.output/1',challenge:randomBytes(32).toString('hex'),language,plaintext:bytes.toString('base64'),recipient:receiver});
  let consumed=false;
  return {request,verify(response){
    if(consumed)throw Error('ARMOR_OUTPUT_CHALLENGE_CONSUMED');consumed=true;
    const r=response?.receipt,at=now();
    if(response?.ok!==true||typeof response.package!=='string'||!response.package.length||Buffer.byteLength(response.package)>2*1024*1024)throw Error('ARMOR_OUTPUT_PACKAGE_INVALID');
    if(!r||Object.keys(r).join(',')!=='schema,audience,challenge,issuedAt,expiresAt,language,inputHash,packageHash,recipientHash,providerIdentity'
      ||r.schema!==domain||r.audience!==request.audience||r.challenge!==request.challenge||r.language!==language
      ||r.inputHash!==inputHash||r.packageHash!==hash(response.package)||r.recipientHash!==recipientHash
      ||JSON.stringify(r.providerIdentity)!==JSON.stringify(identity)||!Number.isSafeInteger(r.issuedAt)||!Number.isSafeInteger(r.expiresAt)
      ||r.issuedAt<issued-5000||r.issuedAt>at+5000||r.expiresAt<=at||r.expiresAt>r.issuedAt+60000||at-issued>60000)throw Error('ARMOR_OUTPUT_RECEIPT_INVALID');
    const payload=Buffer.from(domain+'\n'+JSON.stringify(r));
    for(const name of ['ed25519','mldsa65']) {
      const s=response.signatures?.[name];
      if(typeof s!=='string'||s.length>10000||Buffer.from(s,'base64').toString('base64')!==s||!verify(null,payload,keys[name],Buffer.from(s,'base64')))throw Error('ARMOR_OUTPUT_SIGNATURE_INVALID');
    }
    return {packageBytes:Buffer.from(response.package),receipt:structuredClone(r),signatures:structuredClone(response.signatures)};
  }};
}
export async function requestStandaloneArmorSeal(options={}) {
  const c=createArmorOutputChallenge(options);
  return c.verify(await armorOwnerRoundTrip({request:c.request,home:options.home,timeoutMs:options.timeoutMs,maxResponseBytes:2*1024*1024}));
}

// Fixed authority in production. Fetch callbacks are untrusted transports: every
// result must pass pinned signatures and fresh one-shot status verification.
export function createStandaloneGeneratedOutputProtection(config={}) {
  if('transport' in config||'certKeyPem' in config||'installation' in config||'access' in config)throw Error('PRODUCTION_TRUST_OVERRIDE_FORBIDDEN');
  return compose(config,createUnifiedCapabilityAccess(config),{proof:requestStandaloneArmorProof,seal:requestStandaloneArmorSeal});
}
export function createStandaloneGeneratedOutputProtectionForFixture(config={},certKeyPem,transport) {
  if(process.env.NODE_ENV!=='test'||process.env.KINGMAKER_DOUBLE_FIXTURE_GATE!=='1')throw Error('FIXTURE_TRUST_DISABLED');
  return compose(config,createUnifiedCapabilityAccessForFixture(config,certKeyPem),transport||{proof:requestStandaloneArmorProof,seal:requestStandaloneArmorSeal});
}
function compose(config,access,transport) {
  const {readGrant,checkGrantStatus,now=Date.now}=config;
  if(typeof readGrant!=='function'||typeof checkGrantStatus!=='function')throw Error('CAPABILITY_AUTHORITY_UNAVAILABLE');
  const publicIdentity=structuredClone(config.publicIdentity),recipient=structuredClone(config.recipient);
  validateArmorPublicIdentity(recipient);const recipientId=hash(JSON.stringify(recipient));
  async function authorize(){
    const grant=await readGrant(),challenge=access.begin(grant);
    const status=await checkGrantStatus({grant,challenge});
    const providerProof=await transport.proof({publicIdentity,home:config.home,now});
    return access.authorize({capability:'scripture-armor.pqc',grant,status,providerProof});
  }
  return async function protectOutput({bytes,language}={}) {
    // Each invocation owns its verifier; receipts cannot be replayed across jobs.
    let verifiedReceipt;
    const wrapper=createGeneratedOutputProtection({protect:async input=>{
      if(input.bytes.length>262144)throw Error('ARMOR_OUTPUT_INPUT_INVALID');
      await authorize();
      const result=await transport.seal({bytes:input.bytes,language:input.language,recipient,publicIdentity,home:config.home,now});
      // Recheck current entitlement and local withdrawal after the async operation.
      await authorize();
      verifiedReceipt={schema:'kingmaker.protected-output/1',inputSha256:input.inputSha256,packageSha256:hash(result.packageBytes),recipientId,language:input.language,protection:'scripture-armor',status:'sealed',providerReceipt:result.receipt,providerSignatures:result.signatures};
      return {packageBytes:result.packageBytes,receipt:verifiedReceipt};
    },verifyReceipt:receipt=>!!verifiedReceipt&&JSON.stringify(receipt)===JSON.stringify(verifiedReceipt)});
    return wrapper({bytes,language,recipientId});
  };
}
