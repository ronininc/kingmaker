// fleet-host/worker.js — the collective's front door (Cloudflare Worker "kingmaker-fleet"; design: docs/community-learning.md).
// It receives the closed packets Kingmakers share, stores them, and hands each install back its signed bundle. It never
// executes anything it receives, and the packet schema it enforces is the engine's own (vendor/fleet/fleet-packet.mjs).
//   POST /contribute  {packet}         → a signed receipt (accepted or refused, with reasons; never the content)
//   GET  /bundle                       → this install's latest signed bundle (204 when there is none yet)
//   POST /forget                       → erases this install's packets, bundle and proof
//   GET  /key                          → the public key and keyId installs pin
// An install proves itself with X-Fleet-Install (its random fi_ id) and X-Fleet-Proof (a random secret it made; only its
// SHA-256 is stored, on first contribution). Bindings: PACKETS (R2), FLEET (KV), FLEET_SIGNING_KEY (secret, PKCS#8 PEM,
// Ed25519), FLEET_PUBLIC_KEY (var, SPKI PEM). Aggregation (the engine's stand-in: quorum, trimmed FedAvg, validation) runs
// on Ronin's side over the stored packets and writes bundles to PACKETS under bundles/<install>.json.
import { canonicalJson, validatePacket } from '../vendor/fleet/fleet-packet.mjs';

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
async function checkProof(env, install, proof, { create }) {
  if (!INSTALL_RE.test(install || '') || !PROOF_RE.test(proof || '')) return 'bad';
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
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json(413, { error: 'too large' });
        let body; try { body = JSON.parse(raw); } catch { return json(400, { error: 'not json' }); }
        const packet = body?.packet;
        // The proof binds the install: a stranger can't contribute under (or erase) someone else's id.
        if (packet?.installationId !== install) return json(400, { error: 'install mismatch' });
        const p = await checkProof(env, install, proof, { create: true });
        if (p === 'bad') return json(403, { error: 'bad proof' });
        const day = now.toISOString().slice(0, 10);
        const rlKey = `rl:${install}:${day}`;
        const used = Number(await env.FLEET.get(rlKey) || 0);
        if (used >= MAX_PACKETS_PER_DAY) return json(429, { error: 'enough for today' });
        const verdict = validatePacket(packet);
        // Refused packets are never stored: the reasons name the rule and path, never the value.
        if (!verdict.ok) return json(200, { receipt: await receipt(env, install, String(packet?.packetId || 'unknown').slice(0, 40), false, verdict.errors.slice(0, 10), now) });
        await env.FLEET.put(rlKey, String(used + 1), { expirationTtl: 2 * 86400 });
        await env.PACKETS.put(`packets/${install}/${packet.day}/${packet.packetId}.json`, canonicalJson(packet), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { receipt: await receipt(env, install, packet.packetId, true, [], now) });
      }

      if (request.method === 'GET' && url.pathname === '/bundle') {
        if (await checkProof(env, install, proof, { create: false }) !== 'ok') return json(403, { error: 'bad proof' });
        const obj = await env.PACKETS.get(`bundles/${install}.json`);
        return obj ? new Response(obj.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : new Response(null, { status: 204 });
      }

      if (request.method === 'POST' && url.pathname === '/forget') {
        if (await checkProof(env, install, proof, { create: false }) !== 'ok') return json(403, { error: 'bad proof' });
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
