// lib/fleet-transport.mjs — how a Kingmaker talks to the collective's front door (fleet-host/worker.js).
// Off until a server is configured (state/fleet/fleet.json {url, publicKeyPem} or KINGMAKER_FLEET_URL/_KEY): with none,
// lib/sharing.mjs logs packets as "not sent". A receipt counts only when it is signed by the PINNED public key, in the
// receipt domain, for this install and this packet; anything else is treated as not received.
//
// ARMOR-NATIVE MODE (Scripture Armor as native behavior, Addendum D): when the fleet config also
// carries an enrolled armor peer (fleet.json "armorPeer": the front door's public identity block, or
// KINGMAKER_FLEET_ARMOR_PEER) AND this install has an armor identity, the exchange is WRAPPED: the
// packet — and the install proof, which legacy mode exposed as a cleartext header — travels INSIDE
// a Scripture Armor v3 package, and the host's signed receipt comes back inside one, return-matched
// by canary before the receipt is even looked at. The receipt discipline below is unchanged; the
// armor is the transport skin around it. Without an enrolled armor peer the legacy path runs
// exactly as before.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';
import {
  ensureIdentity, wrapEgress, openInbound, noteSent, matchReturn, recordBeacon, recordProvenance, signerPinsOfBlock,
} from './armor-native.mjs';

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
  const armorPeer = String(env.KINGMAKER_FLEET_ARMOR_PEER || c.armorPeer || '');
  if (!/^https:\/\//.test(url) || !/BEGIN PUBLIC KEY/.test(publicKeyPem)) return null;
  return { url, publicKeyPem, armorPeer: armorPeer || null };
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

  // ---- legacy path (unchanged): plain HTTPS, signed-receipt discipline ----
  const legacy = {
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

  if (!cfg.armorPeer) return legacy;

  // ---- armor-native path: the whole exchange rides inside the wrap ----
  ensureIdentity(state);
  async function wrappedCall(path, doc, purpose) {
    const { text, frame } = await wrapEgress(state, Buffer.from(JSON.stringify(doc), 'utf8'), cfg.armorPeer, { purpose });
    noteSent(state, { canary: frame.canary, purpose, peer: frame.recipient_seal_fp });
    const r = await fetchImpl(`${cfg.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.scripture-armor; v=4' }, // 4.4 PHASE-0 MERGE RP-5 (completed here; flagged as unapplied sibling in Lane A FOLD-REPORT §3): was v=3 — converged armor emits SCRIPTURE-ARMOR v4 packages
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const respText = await r.text();
    if (!respText.startsWith('SCRIPTURE-ARMOR')) {
      recordBeacon(state, { event: 'fleet-response-unarmored', purpose, detail: 'front door answered in cleartext — not trusted' });
      return { ok: false, status: r.status, error: 'fleet-response-unarmored' };
    }
    let opened;
    try {
      // Responder pinning (airlock rule): the front door's answer must
      // be signed by the enrolled armor peer from the fleet config —
      // never by a key the arriving frame asserts about itself.
      opened = openInbound(state, respText, signerPinsOfBlock(cfg.armorPeer));
    } catch (e) {
      recordBeacon(state, { event: 'fleet-response-open-failed', purpose, detail: String(e?.message || e) });
      return { ok: false, status: r.status, error: String(e?.message || e) };
    }
    let respDoc;
    try { respDoc = JSON.parse(opened.plaintext.toString('utf8')); } catch {
      recordBeacon(state, { event: 'fleet-response-unparsable', purpose, detail: 'armored response was not the expected document' });
      return { ok: false, status: r.status, error: 'fleet-response-unparsable' };
    }
    const match = matchReturn(state, respDoc.in_reply_to, { purpose });
    if (!match.ok) return { ok: false, status: r.status, error: `fleet-return-match-failed: ${match.error}` };
    recordProvenance(state, {
      kind: 'egress', purpose, target: `${cfg.url}${path}`, mode: 'package',
      canary: frame.canary, answered_by_sign_fp: opened.frame.sender_sign_fp, return_match: true,
    });
    return { ok: true, status: r.status, doc: respDoc };
  }

  return {
    async send(packet) {
      const res = await wrappedCall('/contribute', { packet, installProof: installSecret(state) }, 'fleet-contribute');
      if (!res.ok) return { ok: false, receipt: null, status: res.status, error: res.error };
      const rc = res.doc.receipt;
      const ok = rc?.accepted === true && receiptValid(rc, { publicKeyPem: cfg.publicKeyPem, installationId: packet.installationId, packetId: packet.packetId });
      return { ok, receipt: ok ? rc : null, refused: rc?.accepted === false ? rc.reasons : undefined, status: res.status, armored: true };
    },
    async forgetRemote(installationId) {
      const res = await wrappedCall('/forget', { forget: installationId, installProof: installSecret(state) }, 'fleet-forget');
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: res.doc.forgotten === true, packets: res.doc.packets, armored: true };
    },
  };
}
