// lib/fleet-transport.mjs — how a Kingmaker talks to the collective's front door (fleet-host/worker.js).
// Off until a server is configured (state/fleet/fleet.json {url, publicKeyPem} or KINGMAKER_FLEET_URL/_KEY): with none,
// lib/sharing.mjs logs packets as "not sent". A receipt counts only when it is signed by the PINNED public key, in the
// receipt domain, for this install and this packet; anything else is treated as not received.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';

export const RECEIPT_DOMAIN = 'solomon.fleet-receipt.v1';

/** This install's proof secret (made once, 0600). Only its SHA-256 is ever stored by the server. */
export function installSecret(state) {
  const file = join(state, 'fleet', 'install-secret');
  try { const v = readFileSync(file, 'utf8').trim(); if (/^[a-f0-9]{64}$/.test(v)) return v; } catch { /* first time */ }
  const s = randomBytes(32).toString('hex');
  mkdirSync(join(state, 'fleet'), { recursive: true, mode: 0o700 }); writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

/** The configured server, or null (sharing then logs locally and sends nothing). */
export function fleetConfig(state, env = process.env) {
  let c = {};
  try { c = JSON.parse(readFileSync(join(state, 'fleet', 'fleet.json'), 'utf8')); } catch { /* none */ }
  const url = String(env.KINGMAKER_FLEET_URL || c.url || '').replace(/\/$/, '');
  const publicKeyPem = String(env.KINGMAKER_FLEET_KEY || c.publicKeyPem || '');
  return /^https:\/\//.test(url) && /BEGIN PUBLIC KEY/.test(publicKeyPem) ? { url, publicKeyPem } : null;
}

/** Pure-ish: is this receipt really the collective's, for this install and packet? */
export function receiptValid(receipt, { publicKeyPem, installationId, packetId }) {
  if (!receipt || receipt.installationId !== installationId || (packetId && receipt.packetId !== packetId)) return false;
  const { signature, ...unsigned } = receipt;
  if (typeof signature !== 'string') return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(`${RECEIPT_DOMAIN}:${canonicalJson(unsigned)}`, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

/** → { send(packet), forgetRemote() } for lib/sharing.mjs, or nulls when no server is configured. */
export function fleetTransport({ state, env = process.env, fetchImpl = fetch, timeoutMs = 20_000 }) {
  const cfg = fleetConfig(state, env);
  if (!cfg) return { send: null, forgetRemote: null };
  const headers = (install) => ({ 'content-type': 'application/json', 'x-fleet-install': install, 'x-fleet-proof': installSecret(state) });
  return {
    async send(packet) {
      const r = await fetchImpl(`${cfg.url}/contribute`, { method: 'POST', headers: headers(packet.installationId), body: JSON.stringify({ packet }), signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      const rc = j?.receipt;
      const ok = r.ok && rc?.accepted === true && receiptValid(rc, { publicKeyPem: cfg.publicKeyPem, installationId: packet.installationId, packetId: packet.packetId });
      return { ok, receipt: ok ? rc : null, refused: rc?.accepted === false ? rc.reasons : undefined, status: r.status };
    },
    async forgetRemote(installationId) {
      const r = await fetchImpl(`${cfg.url}/forget`, { method: 'POST', headers: headers(installationId), body: '{}', signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      return { ok: r.ok && j?.forgotten === true, packets: j?.packets };
    },
  };
}
