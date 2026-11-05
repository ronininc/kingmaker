#!/usr/bin/env node
// refit-estate.mjs — Addendum M estate mechanisms: M.16 (control
// plane demoted to plumbing), M.17 (chains of introduction), M.20
// (estate time), M.22 (threshold-signed monotonic updates), M.25
// (phone tier: value removal + brokering).
//
// Shared discipline: everything trust-bearing is a signed artifact in
// the armor.mjs mesh-doc form. A server (the control plane) may CARRY
// these artifacts; it cannot mint one. Verification needs only the
// artifact + the estate descriptor — never the server's say-so.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  signPayload, verifyPayload, fingerprintOfRaw, sha256Hex,
} from './armor.mjs';
import { readChain, verifyChain } from './refit-store.mjs';

const b64 = (buf) => Buffer.from(buf).toString('base64');

// ---------------------------------------------------------------------------
// M.17 — chains of introduction.
//
// The estate descriptor is a signature chain. Genesis: the first two
// devices cross-sign each other in person (both directions present in
// the descriptor). Every later member carries an introduction: its
// entry is countersigned by an EXISTING member (its introducer), and
// the entry binds the member's label + seal/sign fingerprints.
// descriptor = {v:1, members: [entry...]}
// entry = {label, seal_fp, sign_fp, introducer_sign_fp|null,
//          genesis: bool, sig} — sig is a mesh doc whose body is the
// entry core; for genesis members the signer is the OTHER genesis
// member (cross-sign), for introduced members the introducer.
// A descriptor with no valid chain to a genesis pair is Tier-0:
// nothing it says enrolls anyone.
// ---------------------------------------------------------------------------

export function entryCore(e) {
  return {
    label: e.label, seal_fp: e.seal_fp, sign_fp: e.sign_fp,
    introducer_sign_fp: e.introducer_sign_fp ?? null, genesis: !!e.genesis,
  };
}

function signEntry(signerId, core) {
  // Entries carry the whole signed doc: signatures over canonical
  // mesh docs cannot be re-derived from parts, so the doc rides along.
  const doc = signPayload(signerId, { type: 'estate-entry', to_seal_fp: null, body: core });
  return { ...core, signer_sign_fp: doc.from_sign_fp, signer_sign_pub: doc.from_sign_pub, doc };
}

export function genesisDescriptor(idA, idB) {
  const coreA = { label: idA.label, seal_fp: idA.sealFp, sign_fp: idA.signFp, introducer_sign_fp: null, genesis: true };
  const coreB = { label: idB.label, seal_fp: idB.sealFp, sign_fp: idB.signFp, introducer_sign_fp: null, genesis: true };
  return { v: 1, members: [signEntry(idB, coreA), signEntry(idA, coreB)] };
}

export function introduceMember(descriptor, introducerId, newId) {
  const core = {
    label: newId.label, seal_fp: newId.sealFp, sign_fp: newId.signFp,
    introducer_sign_fp: introducerId.signFp, genesis: false,
  };
  return { v: 1, members: [...descriptor.members, signEntry(introducerId, core)] };
}

// Verify the whole chain. Returns {ok, tier0: bool, members} — ok when
// every entry's signature verifies under its signer's stated key, the
// signer is the introducer (or, for genesis, the other genesis
// member), every non-genesis introducer is itself a verified member,
// and exactly the genesis pair roots the chain.
export function verifyDescriptor(descriptor) {
  if (!descriptor || !Array.isArray(descriptor.members) || descriptor.members.length < 2) {
    return { ok: false, tier0: true, error: 'descriptor-too-small' };
  }
  const byFp = new Map(descriptor.members.map((m) => [m.sign_fp, m]));
  const genesis = descriptor.members.filter((m) => m.genesis);
  if (genesis.length !== 2) return { ok: false, tier0: true, error: 'genesis-pair-required' };
  for (const e of descriptor.members) {
    if (!e.doc || !verifyPayload(e.doc)) {
      return { ok: false, tier0: true, error: `bad-entry-signature: ${e.label}` };
    }
    if (e.doc.from_sign_fp !== e.signer_sign_fp) return { ok: false, tier0: true, error: 'signer-mismatch' };
    const body = e.doc.body || {};
    if (body.label !== e.label || body.sign_fp !== e.sign_fp || body.seal_fp !== e.seal_fp) {
      return { ok: false, tier0: true, error: `entry-body-mismatch: ${e.label}` };
    }
    if (e.genesis) {
      const other = genesis.find((g) => g.sign_fp !== e.sign_fp);
      if (e.signer_sign_fp !== other.sign_fp) return { ok: false, tier0: true, error: 'genesis-not-cross-signed' };
    } else {
      if (e.signer_sign_fp !== e.introducer_sign_fp) return { ok: false, tier0: true, error: 'introducer-not-signer' };
      if (!byFp.has(e.introducer_sign_fp)) return { ok: false, tier0: true, error: 'introducer-not-a-member' };
    }
  }
  return { ok: true, tier0: false, members: descriptor.members };
}

// Pairing codes stop being bearer secrets: a code is single-use,
// minutes-lived, and BOUND to the new device's public-key fingerprint.
// The new device proves possession by signing the code with its fresh
// key; an intercepted code without that key is worthless, and the
// code dies on first use or first failure (the store enforces both).
export function makePairingCode(newSignFp, ttlMs = 5 * 60 * 1000, nowMs = Date.now()) {
  return {
    code: crypto.randomBytes(9).toString('hex'),
    bound_sign_fp: newSignFp,
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    used: false, failed: false,
  };
}

export function redeemPairingCode(record, { code, signFp, signatureOk, nowMs = Date.now() }) {
  if (!record || record.used) return { ok: false, error: 'pairing-code-dead (already used)' };
  if (record.failed) return { ok: false, error: 'pairing-code-dead (failed attempt burned it)' };
  if (Date.parse(record.expires_at) < nowMs) { record.failed = true; return { ok: false, error: 'pairing-code-expired' }; }
  if (code !== record.code) { record.failed = true; return { ok: false, error: 'pairing-code-mismatch (burned)' }; }
  if (signFp !== record.bound_sign_fp) { record.failed = true; return { ok: false, error: 'pairing-fingerprint-mismatch: code is bound to another device key (burned)' }; }
  if (!signatureOk) { record.failed = true; return { ok: false, error: 'pairing-proof-invalid (burned)' }; }
  record.used = true;
  return { ok: true };
}

// The pairing proof: the new device signs the code string with its
// fresh sign key; the redeemer verifies against the bound public key.
export function pairingProof(newId, code) {
  return b64(crypto.sign(null, Buffer.from(`pair:${code}`, 'utf8'), newId.signPriv));
}
export function verifyPairingProof(newSignPubX, code, sigB64) {
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: newSignPubX }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(`pair:${code}`, 'utf8'), pub, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// M.16 — policy as a custodian-signed, monotonically anchored artifact.
//
// A policy state = {seq, policy} carried in a mesh doc signed by ONE
// custodian and countersigned by a second (threshold 2: the doc
// carries sig + countersig). Nodes hold the last accepted {seq,
// digest}; acceptance requires: both signatures verify against
// descriptor members, seq strictly greater than held, and the digest
// matches the policy body. The control plane can carry this doc; it
// cannot mint one, and a replayed old doc fails the sequence.
// ---------------------------------------------------------------------------

export const policyDigestOf = (policy) => sha256Hex(Buffer.from(JSON.stringify(policy), 'utf8'));

export function signPolicy(custodianId, seq, policy) {
  return signPayload(custodianId, {
    type: 'estate-policy', to_seal_fp: null,
    body: { seq, digest: policyDigestOf(policy), policy },
  });
}

export function countersignPolicy(secondCustodianId, doc) {
  const core = { seq: doc.body.seq, digest: doc.body.digest };
  const sig = b64(crypto.sign(null, Buffer.from(`policy:${core.seq}:${core.digest}`, 'utf8'), secondCustodianId.signPriv));
  return { ...doc, countersig: { by_sign_fp: secondCustodianId.signFp, by_sign_pub: secondCustodianId.sign_pub, sig } };
}

export function verifyPolicyDoc(doc, memberSignPubs /* Map fp -> pubX */) {
  if (!doc || doc.type !== 'estate-policy' || !verifyPayload(doc)) return { ok: false, error: 'policy-signature-invalid' };
  if (!memberSignPubs.has(doc.from_sign_fp)) return { ok: false, error: 'policy-signer-not-a-member' };
  if (policyDigestOf(doc.body.policy) !== doc.body.digest) return { ok: false, error: 'policy-digest-mismatch' };
  const cs = doc.countersig;
  if (!cs || !memberSignPubs.has(cs.by_sign_fp)) return { ok: false, error: 'policy-countersignature-missing' };
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: cs.by_sign_pub }, format: 'jwk' });
    const okSig = crypto.verify(null, Buffer.from(`policy:${doc.body.seq}:${doc.body.digest}`, 'utf8'), pub, Buffer.from(cs.sig, 'base64'));
    if (!okSig) return { ok: false, error: 'policy-countersignature-invalid' };
  } catch { return { ok: false, error: 'policy-countersignature-invalid' }; }
  if (cs.by_sign_fp === doc.from_sign_fp) return { ok: false, error: 'policy-needs-two-custodians' };
  return { ok: true, seq: doc.body.seq, digest: doc.body.digest };
}

export function acceptPolicy(held /* {seq, digest} */, doc, memberSignPubs) {
  const v = verifyPolicyDoc(doc, memberSignPubs);
  if (!v.ok) return v;
  if (held && doc.body.seq <= held.seq) return { ok: false, error: 'policy-replay: sequence not advancing (divergent or replayed policy refused; node freezes at last-agreed digest)' };
  return { ok: true, held: { seq: doc.body.seq, digest: doc.body.digest } };
}

// ---------------------------------------------------------------------------
// M.20 — estate time. Custodians sign time attestations; a daemon's
// security clock is the MEDIAN of custodian-signed timestamps. A node
// whose local clock disagrees beyond the skew window goes
// estate-stale: its freshness decisions refuse until it re-agrees.
// Ordering never depends on any clock: chains and sequences are
// monotonic by construction (M.1/M.16/M.22).
// ---------------------------------------------------------------------------

export function timeAttestation(custodianId, nowMs = Date.now()) {
  return signPayload(custodianId, {
    type: 'time-attest', to_seal_fp: null,
    body: { t: new Date(nowMs).toISOString() },
  });
}

export function estateTime(attestations, memberSignFps, nowMs = Date.now(), skewS = 120) {
  const ts = [];
  for (const a of attestations || []) {
    if (!a || a.type !== 'time-attest' || !verifyPayload(a)) continue;
    if (!memberSignFps.has(a.from_sign_fp)) continue;
    const t = Date.parse(a.body?.t);
    if (Number.isFinite(t)) ts.push(t);
  }
  if (!ts.length) return { ok: false, error: 'no-valid-time-attestations' };
  ts.sort((x, y) => x - y);
  const median = ts[Math.floor(ts.length / 2)];
  const drift = Math.abs(nowMs - median);
  return {
    ok: true, estate_now: median, drift_ms: drift,
    stale: drift > skewS * 1000,
    sources: ts.length,
  };
}

// Freshness decision under estate time: refuses when this node is
// estate-stale, whatever its local clock claims.
export function freshnessDecision(attestations, memberSignFps, { nowMs = Date.now(), skewS = 120 } = {}) {
  const et = estateTime(attestations, memberSignFps, nowMs, skewS);
  if (!et.ok) return { ok: false, error: et.error };
  // NOTE: et carries ok:true — the stale refusal must override it
  // AFTER the spread, or the refusal reports itself as success.
  if (et.stale) return { ...et, ok: false, error: 'estate-stale: local clock disagrees with estate time beyond the skew window — freshness decisions refuse' };
  return { ok: true, estate_now: et.estate_now };
}

// ---------------------------------------------------------------------------
// M.22 — updates as ordinary packages with three extra laws:
//   (1) issued under the THRESHOLD release identity (M.2): the
//       artifact's frame signature is by the release identity, which
//       no single custodian can produce;
//   (2) monotonic: seq strictly greater than installed AND the
//       artifact names the digest of its installed predecessor — a
//       rollback artifact cannot chain forward;
//   (3) canaried: the update activates first on ONE designated node,
//       whose signed smoke verdict must sync before any other node
//       accepts the sequence.
// An update record: {seq, artifact_digest, predecessor_digest,
// frame_canary}. The smoke verdict is a mesh doc 'update-smoke'
// signed by the canary node naming the artifact digest + pass/fail.
// ---------------------------------------------------------------------------

export function updateRecord({ seq, artifactDigest, predecessorDigest, frameCanary }) {
  return { seq, artifact_digest: artifactDigest, predecessor_digest: predecessorDigest, frame_canary: frameCanary };
}

export function smokeVerdict(canaryId, artifactDigest, pass) {
  return signPayload(canaryId, {
    type: 'update-smoke', to_seal_fp: null,
    body: { artifact_digest: artifactDigest, pass: !!pass, at: new Date().toISOString() },
  });
}

// installed = {seq, digest} of the currently installed artifact.
export function acceptUpdate(installed, rec, { isCanary = false, smoke = null, canarySignFp = null } = {}) {
  if (rec.seq <= installed.seq) return { ok: false, error: 'update-refused: sequence not advancing (rollback or replay)' };
  if (rec.predecessor_digest !== installed.digest) {
    return { ok: false, error: 'update-refused: predecessor digest mismatch — artifact does not chain from the installed artifact' };
  }
  if (!isCanary) {
    if (!smoke || smoke.type !== 'update-smoke' || !verifyPayload(smoke)) {
      return { ok: false, error: 'update-refused: no valid canary smoke verdict synced' };
    }
    if (canarySignFp && smoke.from_sign_fp !== canarySignFp) {
      return { ok: false, error: 'update-refused: smoke verdict not from the designated canary' };
    }
    if (smoke.body.artifact_digest !== rec.artifact_digest) {
      return { ok: false, error: 'update-refused: smoke verdict names a different artifact' };
    }
    if (!smoke.body.pass) return { ok: false, error: 'update-refused: canary smoke battery failed — update strands on the canary' };
  }
  return { ok: true, install: { seq: rec.seq, digest: rec.artifact_digest } };
}

// ---------------------------------------------------------------------------
// M.25 — the phone tier, completed: the phone HOLDS nothing and
// BROKERS everything. A broker request is a mesh doc from the Tier-3
// device ('broker-request'); a Tier-1 endpoint executes and returns a
// 'broker-result'. The phone-side profile check is a pure audit: any
// key material, registry, package, or recovery file in the phone's
// store fails it. The C2 leg is exercised at the flow layer (M.8): an
// implant's beacon is a flow to an unenrolled endpoint, which cannot
// form — the mesh record of the attempt is the fixture's output.
// ---------------------------------------------------------------------------

export function auditPhoneStore(dir) {
  const banned = ['identity.json', 'registry.json', 'registry-chain.jsonl', 'recovery-leg.scripture', 'custody.json'];
  const found = [];
  const walk = (d, depth) => {
    if (depth > 3 || !fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (banned.includes(name) || name.endsWith('.scripture')) found.push(p);
    }
  };
  walk(dir, 0);
  return { ok: found.length === 0, found };
}

export function brokerRequest(phoneId, action, params = {}) {
  return signPayload(phoneId, { type: 'broker-request', to_seal_fp: null, body: { action, params } });
}
export function brokerResult(endpointId, requestDoc, result) {
  return signPayload(endpointId, {
    type: 'broker-result', to_seal_fp: null,
    body: { request_nonce: requestDoc.nonce, result },
  });
}
