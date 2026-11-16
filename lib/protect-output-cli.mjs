// Explicit operation only. Plaintext goes to the local owner socket, never HTTP.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateArmorPublicIdentity} from './armor-dock-provider.mjs';
import {constants} from 'node:fs';
import {createStandaloneGeneratedOutputProtection} from './armor-output-provider.mjs';
import {INSTALL_STATUS_ORIGIN} from './launcher-crm-identity-client.mjs';
export const PROTECT_OUTPUT_USAGE='kingmaker protect-output --input FILE --output FILE --language LANG --config PRIVATE_JSON --enrollment EXISTING_UPDATE_JSON';
async function readBounded(file,max,{privateFile=false}={}) {
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const s=await handle.stat();if(!s.isFile()||s.size>max||s.nlink!==1||(privateFile&&((s.mode&0o077)!==0||s.uid!==process.getuid())))throw Error('PROTECT_OUTPUT_FILE_UNSAFE');
    const data=Buffer.alloc(max+1);let size=0;
    while(size<data.length){const r=await handle.read(data,size,data.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
    if(size>max){data.fill(0);throw Error('PROTECT_OUTPUT_FILE_TOO_LARGE');}return data.subarray(0,size);
  } finally {await handle.close();}
}
async function jsonFile(file,max=65536){return JSON.parse((await readBounded(file,max,{privateFile:true})).toString('utf8'));}
// Transport is not authority: returned envelopes are verified by the fixed-key
// capability consumer. Basis selects a benefit claim; it never creates consent.
export function createOutputCapabilityTransport({installCertificate,publicIdentity,basis,bearer,readFleetConsent=()=>null}) {
  if(!['paid','fleet'].includes(basis))throw Error('PROTECT_OUTPUT_BASIS_REQUIRED');
  validateArmorPublicIdentity(publicIdentity);
  const providerFingerprint=createHash('sha256').update(JSON.stringify(publicIdentity)).digest('hex');
  const certificate=structuredClone(installCertificate);
  async function post(route,body){
    const response=await fetch(new URL(route,INSTALL_STATUS_ORIGIN),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok)throw Error('CAPABILITY_AUTHORITY_UNAVAILABLE');
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('CAPABILITY_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return {
    readGrant:async()=>{
      if(basis==='fleet'){const c=await readFleetConsent();if(c?.optedIn!==true||c.withdrawn===true||typeof c.id!=='string'||!c.id||!Number.isSafeInteger(c.version)||c.version<1||!Number.isSafeInteger(c.acceptedAt)||c.acceptedAt>Date.now())throw Error('EXPLICIT_FLEET_CONSENT_REQUIRED');}
      return post('/capability-grant',{installCertificate:certificate,providerFingerprint,basis});
    },
    checkGrantStatus:async({grant,challenge})=>post('/capability-status',{installCertificate:certificate,grant,challenge}),
  };
}
export async function cmdProtectOutput(args) {
  if(args.length===1&&['--help','-h'].includes(args[0])){console.log(PROTECT_OUTPUT_USAGE);return 0;}
  const allowed=new Set(['input','output','language','config','enrollment']),opts={};
  for(let i=0;i<args.length;i+=2){const k=args[i]?.slice(2);if(!args[i]?.startsWith('--')||!allowed.has(k)||opts[k]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('PROTECT_OUTPUT_ARGUMENTS_INVALID');opts[k]=args[i+1];}
  if(Object.keys(opts).length!==5)throw Error('PROTECT_OUTPUT_ARGUMENTS_INVALID');
  // Existing enrollment storage is read only. Never create or copy a bearer store.
  const enrollment=await jsonFile(opts.enrollment),config=await jsonFile(opts.config,131072);
  if(enrollment.url?.replace(/\/$/,'')!==INSTALL_STATUS_ORIGIN||typeof enrollment.key!=='string'||!enrollment.key||enrollment.key.length>8192)throw Error('PROTECT_OUTPUT_ENROLLMENT_INVALID');
  const fields=new Set(['schema','installCertificate','deviceSha256','publicIdentity','recipient','basis','fleetConsentFile']);
  if(config.schema!=='kingmaker.output-protection-config/1'||Object.keys(config).some(k=>!fields.has(k)))throw Error('PROTECT_OUTPUT_CONFIG_INVALID');
  // publicIdentity must be the independently enrolled pin, never a just-fetched
  // daemon identity. Signed grant providerFingerprint enforces the issuer binding.
  const readFleetConsent=()=>config.fleetConsentFile?jsonFile(config.fleetConsentFile):null;
  const transport=createOutputCapabilityTransport({installCertificate:config.installCertificate,publicIdentity:config.publicIdentity,basis:config.basis,bearer:enrollment.key,readFleetConsent});
  const protect=createStandaloneGeneratedOutputProtection({installCertificate:config.installCertificate,deviceSha256:config.deviceSha256,publicIdentity:config.publicIdentity,recipient:config.recipient,bearer:enrollment.key,readFleetConsent,...transport});
  const bytes=await readBounded(opts.input,262144);let result;
  try{result=await protect({bytes,language:opts.language});}finally{bytes.fill(0);}
  // Exclusive create: no overwrite of source or existing output. Failed write
  // leaves no success message. Receipt remains private/in-memory, not exported.
  const output=await fs.open(opts.output,'wx',0o600);
  try{await output.writeFile(result.packageBytes);await output.sync();}finally{await output.close();}
  console.log('Protected output written. Receipt verified; registration and decryption approval are separate.');return 0;
}
