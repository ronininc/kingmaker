// fleet-host/worker.js — the collective's front door (Cloudflare Worker "kingmaker-fleet"; design: docs/community-learning.md).
// Receives only exact release-reviewed generic method packets and signs receipts.
// It never executes content; legacy telemetry and unreviewed redistribution are refused.
//   POST /contribute  {packet}         → a signed receipt (accepted or refused, with reasons; never the content)
//   GET  /bundle                       → 501 until governed redistribution exists
//   POST /forget                       → erases this install's packets, bundle and proof
//   GET  /key                          → the public key and keyId installs pin
// An install proves itself with X-Fleet-Install (its random fi_ id) and X-Fleet-Proof (a random secret it made; only its
// SHA-256 is stored, on first contribution). Bindings: PACKETS (R2), FLEET (KV), FLEET_SIGNING_KEY (secret, PKCS#8 PEM,
// Ed25519), FLEET_PUBLIC_KEY (var, SPKI PEM). Aggregation (the engine's stand-in: quorum, trimmed FedAvg, validation) runs
// on Ronin's side over the stored packets and writes bundles to PACKETS under bundles/<install>.json.
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

/** The install's proof: on first sight its hash is stored; afterwards it must match. → 'ok' | 'new' | 'bad' */
async function checkProof(env, install, proof, { create, allowWithdrawn = false }) {
  if (!INSTALL_RE.test(install || '') || !PROOF_RE.test(proof || '')) return 'bad';
  if(!allowWithdrawn&&await env.FLEET.get(`withdrawn:${install}`))return 'bad';
  const want = await env.FLEET.get(`proof:${install}`);
  const got = await sha256(proof);
  if (!want) { if (!create) return 'bad'; await env.FLEET.put(`proof:${install}`, got); return 'new'; }
  return want === got ? 'ok' : 'bad';
}

export default {
  async fetch(request, env, ctx, now = new Date()) {
    const url = new URL(request.url);
    const install = request.headers.get('x-fleet-install') || '', proof = request.headers.get('x-fleet-proof') || '';
    try {
      if (request.method === 'GET' && url.pathname === '/key') return json(200, { keyId: await keyIdOf(env.FLEET_PUBLIC_KEY), publicKeyPem: env.FLEET_PUBLIC_KEY });

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
        if(Object.keys(body||{}).length!==1||!verdict.ok){
          if(!INSTALL_RE.test(install)||!PROOF_RE.test(proof))return json(403,{error:'bad proof'});
          const packetId=/^fp_[a-f0-9]{32}$/.test(packet?.packetId||'')?packet.packetId:'invalid';
          return json(200,{receipt:await receipt(env,install,packetId,false,['reviewed reusable skill required'],now)});
        }
        const p = await checkProof(env, install, proof, { create: true });
        if (p === 'bad') return json(403, { error: 'bad proof' });
        const day = now.toISOString().slice(0, 10);
        const rlKey = `rl:${install}:${day}`;
        const used = Number(await env.FLEET.get(rlKey) || 0);
        if (used >= MAX_PACKETS_PER_DAY) return json(429, { error: 'enough for today' });
        if(await env.FLEET.get(`seen:${install}:${packet.packetId}`))return json(409,{error:'packet already received'});
        await env.FLEET.put(rlKey, String(used + 1), { expirationTtl: 2 * 86400 });
        await env.PACKETS.put(`packets/${install}/${day}/${packet.packetId}.json`, canonicalJson(packet), { httpMetadata: { contentType: 'application/json' } });
        await env.FLEET.put(`seen:${install}:${packet.packetId}`,'1');
        return json(200, { receipt: await receipt(env, install, packet.packetId, true, [], now) });
      }

      if (request.method === 'GET' && url.pathname === '/bundle') {
        if (await checkProof(env, install, proof, { create: false }) !== 'ok') return json(403, { error: 'bad proof' });
        // No reviewed redistribution issuer exists yet. Never serve arbitrary old bundles.
        return json(501,{error:'reviewed skill redistribution not configured'});
      }

      if (request.method === 'POST' && url.pathname === '/forget') {
        if (await checkProof(env, install, proof, { create: false, allowWithdrawn: true }) !== 'ok') return json(403, { error: 'bad proof' });
        // Tombstone first: old credentials cannot silently re-enroll after erasure.
        await env.FLEET.put(`withdrawn:${install}`,'1');
        let cursor, deleted = 0;
        do {
          const page = await env.PACKETS.list({ prefix: `packets/${install}/`, cursor });
          if (page.objects.length) { await env.PACKETS.delete(page.objects.map((o) => o.key)); deleted += page.objects.length; }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        await env.PACKETS.delete(`bundles/${install}.json`);
        await env.FLEET.delete(`proof:${install}`);
        return json(200, { forgotten: true, packets: deleted });
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      return json(500, { error: 'server error' }); // never echo what was sent
    }
  },
};
