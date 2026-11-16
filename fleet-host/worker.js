// fleet-host/worker.js — the collective's front door (Cloudflare Worker "kingmaker-fleet"; design: docs/community-learning.md).
// Receives only exact release-reviewed generic method packets and signs receipts.
// It never executes content; legacy telemetry and unreviewed redistribution are refused.
//   POST /contribute  {packet}         → a signed receipt (accepted or refused, with reasons; never the content)
//   GET  /bundle?nonce=...              → signed exact reviewed catalog, never executable code
//   POST /forget                       → atomically erases packets, retains revocation tombstone/proof hash
//   GET  /key                          → the public key and keyId installs pin
// One SQLite Durable Object owns each install's hashed proof, rate/replay and
// withdrawal state. No KV/R2 authorization fallback or cross-store packet race.
// First proof binding occurs only after signed current enrollment status and
// fresh CRM consent linkage; this ingress does not itself grant paid benefits.
import {createFleetConsentAuthority,createFleetConsentAuthorityForFixture} from './consent-authority.mjs';
import {validateReusableSkillPacket} from '../lib/reusable-skill-catalog.mjs';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';

export const MAX_BODY = 256 * 1024;
export const MAX_PACKETS_PER_DAY = 4;
export const RECEIPT_DOMAIN = 'solomon.fleet-receipt.v1';
const INSTALL_RE = /^fi_[a-f0-9]{32}$/;
const PROOF_RE = /^[a-f0-9]{64}$/;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const pemBytes = (pem) => Uint8Array.from(atob(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/** keyId exactly as the engine computes it (its keyIdOf): km_ + the first 16 hex of sha256(public key PEM). */
export async function keyIdOf(publicKeyPem) { return `km_${(await sha256(String(publicKeyPem).trim())).slice(0, 16)}`; }

/** Sign `value` in `domain` the way the engine verifies it: Ed25519 over "<domain>:<canonical JSON>", base64. */
export async function signFleet(privateKeyPem, domain, value) {
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(privateKeyPem), { name: 'Ed25519' }, false, ['sign']);
  return b64(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`${domain}:${canonicalJson(value)}`)));
}

async function receipt(env, installationId, packetId, accepted, reasons, now) {
  const unsigned = { packetId, installationId, accepted, reasons, day: now.toISOString().slice(0, 10), keyId: await keyIdOf(env.FLEET_PUBLIC_KEY) };
  return { ...unsigned, signature: await signFleet(env.FLEET_SIGNING_KEY, RECEIPT_DOMAIN, unsigned) };
}

async function readBoundedJson(request,max){
 const reader=request.body?.getReader();if(!reader)throw Error('invalid');const chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw Error('too large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
}
async function coordinate(env,install,proof,operation,packet,authority={},extra={}){
 if(!INSTALL_RE.test(install)||!PROOF_RE.test(proof))return {status:403,error:'bad proof'};
 if(!env.FLEET_COORDINATOR)return {status:503,error:'strongly consistent fleet coordinator unavailable'};
 return env.FLEET_COORDINATOR.getByName(install).operate({install,proofHash:await sha256(proof),operation,packet,authorizationExpiresAt:authority.expiresAt,nonce:authority.nonce,certDigest:authority.certDigest,...extra});
}
export function createFleetWorkerForFixture(certKeyPem){return makeWorker(createFleetConsentAuthorityForFixture(certKeyPem));}
export default makeWorker(createFleetConsentAuthority());
function makeWorker(authorize){return {
  async fetch(request, env, ctx, now = new Date()) {
    const url = new URL(request.url);
    const install = request.headers.get('x-fleet-install') || '', proof = request.headers.get('x-fleet-proof') || '';
    try {
      if (request.method === 'GET' && url.pathname === '/key') return json(200, { keyId: await keyIdOf(env.FLEET_PUBLIC_KEY), publicKeyPem: env.FLEET_PUBLIC_KEY });

      if(request.method==='POST'&&url.pathname==='/challenge'){
        let body;try{body=await readBoundedJson(request,2048);}catch(e){return json(e.message==='too large'?413:400,{error:'invalid challenge body'});}
        if(Object.keys(body).sort().join(',')!=='certDigest,operation,requestHash'||!['contribute','bundle'].includes(body.operation)||![body.requestHash,body.certDigest].every(v=>/^[a-f0-9]{64}$/.test(v||'')))return json(400,{error:'bad challenge'});
        const targetKey=await sha256(String(env.FLEET_PUBLIC_KEY).trim()),nonce=hex(crypto.getRandomValues(new Uint8Array(32)));
        const decision=await coordinate(env,install,proof,'challenge',undefined,{}, {challenge:{...body,targetKey,nonce}});
        return decision.status===200?json(200,{schema:'kingmaker.fleet-challenge/1',audience:'kingmaker.fleet-ingress/1',fleetInstallId:install,...body,targetKey,nonce,expiresAt:decision.expiresAt}):json(decision.status,{error:decision.error});
      }
      if (request.method === 'POST' && url.pathname === '/contribute') {
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_BODY) return json(413, { error: 'too large' });
        const reader=request.body?.getReader();if(!reader)return json(400,{error:'body required'});
        const chunks=[];let size=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BODY)return json(413,{error:'too large'});chunks.push(value);}}finally{await reader.cancel();}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const raw=new TextDecoder().decode(bytes);
        let body; try { body = JSON.parse(raw); } catch { return json(400, { error: 'not json' }); }
        const packet = body?.packet;
        // The proof binds the install: a stranger can't contribute under (or erase) someone else's id.
        if (packet?.installationId !== install) return json(400, { error: 'install mismatch' });
        const verdict=validateReusableSkillPacket(packet);
        if(Object.keys(body||{}).sort().join(',')!=='authorization,packet'||!verdict.ok){
          if(!INSTALL_RE.test(install)||!PROOF_RE.test(proof))return json(403,{error:'bad proof'});
          const packetId=/^fp_[a-f0-9]{32}$/.test(packet?.packetId||'')?packet.packetId:'invalid';
          return json(200,{receipt:await receipt(env,install,packetId,false,['reviewed reusable skill required'],now)});
        }
        let authority;try{authority=await authorize({env,authorization:body.authorization,fleetInstallId:install,proof});}catch{return json(403,{error:'current bound fleet consent required'});}
        const decision=await coordinate(env,install,proof,'contribute',packet,authority,{requestHash:await sha256(canonicalJson(packet)),targetKey:await sha256(String(env.FLEET_PUBLIC_KEY).trim())});
        if(decision.status!==200)return json(decision.status,{error:decision.error});
        return json(200,{receipt:await receipt(env,install,packet.packetId,true,[],now)});
      }
      if(request.method==='POST'&&url.pathname==='/bundle'){
        let body;try{body=await readBoundedJson(request,32768);}catch(e){return json(e.message==='too large'?413:400,{error:'invalid bundle body'});}
        if(Object.keys(body).sort().join(',')!=='authorization,nonce')return json(400,{error:'bad request'});
        const nonce=body.nonce;if(!/^[a-f0-9]{64}$/.test(nonce||''))return json(400,{error:'fresh nonce required'});
        let authority;try{authority=await authorize({env,authorization:body.authorization,fleetInstallId:install,proof});}catch{return json(403,{error:'current bound fleet consent required'});}
        const decision=await coordinate(env,install,proof,'bundle',undefined,authority,{requestHash:await sha256(canonicalJson({nonce})),targetKey:await sha256(String(env.FLEET_PUBLIC_KEY).trim())});if(decision.status!==200)return json(decision.status,{error:decision.error});
        const issuedAt=Date.now(),methods=decision.methods;
        const doc={schema:'kingmaker.fleet-bundle/1',installationId:install,nonce,issuedAt,expiresAt:issuedAt+60000,catalogHash:await sha256(canonicalJson(methods)),methods};
        return json(200,{doc,signature:await signFleet(env.FLEET_SIGNING_KEY,'kingmaker.fleet-bundle/1',doc)});
      }
      if(request.method==='POST'&&url.pathname==='/forget'){
        const decision=await coordinate(env,install,proof,'forget');
        return decision.status===200?json(200,{forgotten:true,packets:decision.packets}):json(decision.status,{error:decision.error});
      }

      return json(404, { error: 'not found' });
    } catch (e) {
      return json(500, { error: 'server error' }); // never echo what was sent
    }
  },
};}
