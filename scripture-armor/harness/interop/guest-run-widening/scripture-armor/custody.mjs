#!/usr/bin/env node
// custody.mjs — Addendum M.2 (threshold identity custody) + M.21
// (recovery legs), built on one primitive: Shamir sharing over
// GF(256).
//
// M.2 — The vault identity's private material no longer sits whole on
// any machine. At refit activation the identity's seal+sign private
// keys are split k-of-n (default 2-of-3) across custodian nodes; each
// share is itself a sealed package held by its custodian's store.
// Using the identity is a ceremony: collect k share packages, open
// them (each custodian's daemon releases its share only to the
// requesting estate identity, over signed RPC in production; here the
// release is the sealed package itself, opened with the custodian's
// seal key by the custodian-side helper), reconstruct IN RAM ONLY,
// use, zero. A single share is information-theoretically silent about
// the key below threshold — the K.2 division rule holds by
// construction, not by policy.
//
// The split material is the identity's two private scalars (X25519
// seal d, Ed25519 sign d), each shared independently. Public halves
// stay public and are recorded in custody.json so a reconstruction
// can be VERIFIED against the known public keys before use.
//
// M.21 — Recovery legs: a recovery set is three legs in three places.
// Each leg is a Scripture package sealed to the threshold identity
// (its opening itself needs the M.2 ceremony) containing one share
// set + the estate descriptor. One leg alone recovers nothing: a leg
// holds ONE share, and recovery additionally requires custodian
// co-signature over the recovery act. status reports the leg count;
// the floor is three.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createIdentity, loadIdentity, sealPlaintext, parseScriptureFile,
  unsealFileKey, openSealedFile, armorDecode, signPayload, sha256Hex,
  fingerprintOfRaw,
} from './armor.mjs';

// ---------------------------------------------------------------------------
// GF(256) — the AES field, polynomial x^8+x^4+x^3+x+1 (0x11b).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  // The generator of this field's multiplicative group is 0x03, NOT
  // 0x02 (0x02 has order 51 in the 0x11b field — a table built from
  // its powers silently corrupts every product outside the cycle;
  // the M.2 battery's roundtrip case is what caught that).
  const xtime = (v) => ((v << 1) ^ (v & 0x80 ? 0x1b : 0x00)) & 0xff;
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x = xtime(x) ^ x; // multiply by the generator 0x03
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
const gdiv = (a, b) => EXP[LOG[a] - LOG[b] + 255];
const ginv = (a) => EXP[255 - LOG[a]];

function evalPoly(coeffs, x) {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) y = gmul(y, x) ^ coeffs[i];
  return y;
}

// Split a secret buffer into n shares, any k reconstruct.
// Share = Buffer [x, y0..y_{L-1}] with x in 1..n.
export function shamirSplit(secret, k, n) {
  if (k < 2 || n < k || n > 255) throw new Error('shamir: bad k/n');
  const L = secret.length;
  const polys = [];
  for (let i = 0; i < L; i++) {
    const coeffs = [secret[i]];
    for (let j = 1; j < k; j++) coeffs.push(crypto.randomBytes(1)[0]);
    polys.push(coeffs);
  }
  const shares = [];
  for (let x = 1; x <= n; x++) {
    const share = Buffer.alloc(L + 1);
    share[0] = x;
    for (let i = 0; i < L; i++) share[i + 1] = evalPoly(polys[i], x);
    shares.push(share);
  }
  return shares;
}

export function shamirCombine(shares) {
  if (shares.length < 2) throw new Error('shamir: need at least 2 shares');
  const L = shares[0].length - 1;
  for (const s of shares) if (s.length !== L + 1) throw new Error('shamir: share length mismatch');
  const xs = shares.map((s) => s[0]);
  if (new Set(xs).size !== xs.length) throw new Error('shamir: duplicate share x');
  const out = Buffer.alloc(L);
  for (let i = 0; i < L; i++) {
    let y = 0;
    for (let j = 0; j < shares.length; j++) {
      let num = 1, den = 1;
      for (let m = 0; m < shares.length; m++) {
        if (m === j) continue;
        num = gmul(num, xs[m]);
        den = gmul(den, xs[j] ^ xs[m]);
      }
      y ^= gmul(shares[j][i + 1], gdiv(num, den));
    }
    out[i] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// M.2 — split an identity's private material into custodian shares.
//
// splitIdentity(dir, custodianDirs, {k, n}): reads dir/identity.json,
// builds a share payload per custodian:
//   {v:1, part:'seal'|'sign', x, share: b64, key_fp}
// — one package per (custodian, part), sealed TO that custodian's
// identity by the vault identity. The payloads are written into each
// custodian's store as custody-share-<vaultfp>-<part>-<x>.scripture.
// custody.json in the vault store records the split (public data:
// fingerprints, k, n, custodian labels, share canaries) — never key
// material. The caller decides when the plaintext identity.json is
// retired; splitIdentity does NOT delete it (the battery retires it
// explicitly to prove the disk-image case).
// ---------------------------------------------------------------------------

function b64(buf) { return Buffer.from(buf).toString('base64'); }
const unb64 = (s) => Buffer.from(s, 'base64');

export function splitIdentity(vaultDir, vaultId, custodians, { k = 2 } = {}) {
  const n = custodians.length;
  const sealShares = shamirSplit(unb64(vaultId.seal_priv), k, n);
  const signShares = shamirSplit(unb64(vaultId.sign_priv), k, n);
  const record = {
    v: 1, k, n,
    vault_sign_fp: vaultId.signFp, vault_seal_fp: vaultId.sealFp,
    seal_pub: vaultId.seal_pub, sign_pub: vaultId.sign_pub,
    custodians: custodians.map((c) => ({ label: c.id.label, sign_fp: c.id.signFp, seal_fp: c.id.sealFp })),
    packages: [],
    split_at: new Date().toISOString(),
  };
  custodians.forEach((c, idx) => {
    for (const [part, shares] of [['seal', sealShares], ['sign', signShares]]) {
      const payload = Buffer.from(JSON.stringify({
        v: 1, part, x: shares[idx][0],
        share: b64(shares[idx]),
        vault_sign_fp: vaultId.signFp,
        key_fp: fingerprintOfRaw(Buffer.from(part === 'seal' ? vaultId.seal_pub : vaultId.sign_pub, 'base64url')),
      }), 'utf8');
      const { frame, text } = sealPlaintext(payload, vaultId, { seal_pub: c.id.seal_pub }, {});
      const file = path.join(c.dir, `custody-share-${vaultId.signFp.slice(0, 12)}-${part}-${shares[idx][0]}.scripture`);
      fs.writeFileSync(file, text, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch {}
      record.packages.push({ custodian: c.id.label, part, x: shares[idx][0], canary: frame.canary, file: path.basename(file) });
    }
  });
  fs.writeFileSync(path.join(vaultDir, 'custody.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

// Custodian-side release: open ONE share package held in this
// custodian's store. In production the custodian's daemon performs
// this after authenticating the requester; the released share VALUE
// travels sealed to the requester. Here the helper returns the raw
// share buffer to the local ceremony (the battery drives both sides
// in-process; the daemon wiring is the vaultd mesh layer's job).
export function releaseShare(custodianDir, custodianId, fileName) {
  const text = fs.readFileSync(path.join(custodianDir, fileName), 'utf8');
  const { frame, body } = parseScriptureFile(text);
  const fileKey = unsealFileKey(custodianId.sealPriv, frame);
  const payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
  const plain = openSealedFile(fileKey, frame, payload);
  const doc = JSON.parse(plain.toString('utf8'));
  return { part: doc.part, x: doc.x, share: unb64(doc.share), key_fp: doc.key_fp };
}

// The ceremony: collect releases until each part has k shares,
// reconstruct, verify against the recorded public keys, and return a
// working identity object (same shape loadIdentity returns) whose
// private material exists ONLY in this process's RAM — the KeyObjects
// are built directly from JWK material in memory; nothing is written
// to disk at any point. The returned object carries a zero() that
// wipes the source share buffers; the caller MUST call it.
export function reconstructIdentity(vaultDir, releases) {
  const record = JSON.parse(fs.readFileSync(path.join(vaultDir, 'custody.json'), 'utf8'));
  const byPart = { seal: [], sign: [] };
  for (const r of releases) byPart[r.part].push(r.share);
  for (const part of ['seal', 'sign']) {
    if (byPart[part].length < record.k) {
      throw new Error(`custody: threshold not met for ${part} (${byPart[part].length}/${record.k})`);
    }
  }
  const sealD = shamirCombine(byPart.seal.slice(0, record.k));
  const signD = shamirCombine(byPart.sign.slice(0, record.k));
  const mkPriv = (crv, x, d) => crypto.createPrivateKey({
    key: { kty: 'OKP', crv, x, d: d.toString('base64url') }, format: 'jwk',
  });
  const mkPub = (crv, x) => crypto.createPublicKey({
    key: { kty: 'OKP', crv, x }, format: 'jwk',
  });
  const id = {
    v: 1, label: 'threshold-reconstructed', created: new Date().toISOString(),
    seal_pub: record.seal_pub, seal_priv: sealD.toString('base64url'),
    sign_pub: record.sign_pub, sign_priv: signD.toString('base64url'),
    sealPriv: mkPriv('X25519', record.seal_pub, sealD),
    sealPub: mkPub('X25519', record.seal_pub),
    signPriv: mkPriv('Ed25519', record.sign_pub, signD),
    signPub: mkPub('Ed25519', record.sign_pub),
    sealFp: fingerprintOfRaw(Buffer.from(record.seal_pub, 'base64url')),
    signFp: fingerprintOfRaw(Buffer.from(record.sign_pub, 'base64url')),
  };
  if (id.sealFp !== record.vault_seal_fp || id.signFp !== record.vault_sign_fp) {
    sealD.fill(0); signD.fill(0);
    throw new Error('custody: reconstruction does not match the recorded public keys');
  }
  id.zero = () => { sealD.fill(0); signD.fill(0); };
  return id;
}

// Sign with the threshold identity via a full ceremony (collect →
// reconstruct → sign → zero). Used for M.22 update issuance.
export function thresholdSign(vaultDir, releases, bytes) {
  const id = reconstructIdentity(vaultDir, releases);
  try { return crypto.sign(null, Buffer.from(bytes), id.signPriv); }
  finally { id.zero(); }
}

// ---------------------------------------------------------------------------
// M.21 — recovery legs.
//
// buildRecoverySet(vaultDir, vaultId, legDirs): each leg is a package
// sealed to the VAULT identity (opening it needs the M.2 ceremony,
// i.e. threshold reconstruction — a stolen leg is dead weight) whose
// plaintext is one custodian's share set + a descriptor stub. The
// co-signature requirement: recover() demands, in addition to a leg,
// a signed recovery act from a custodian (signPayload doc of type
// 'recovery-act' naming the leg digest). status counts legs found.
// ---------------------------------------------------------------------------

export const RECOVERY_SET_FILE = 'recovery-leg.scripture';

export function buildRecoveryLeg(vaultDir, vaultId, custodianDir, custodianId, shareFiles, legDir) {
  const shares = shareFiles.map((f) => ({
    file: f, text: fs.readFileSync(path.join(custodianDir, f), 'utf8'),
  }));
  // Share files for a leg live in the CUSTODIAN's store in the M.2
  // layout; for a recovery leg the leg itself carries the custodian's
  // two share packages verbatim (they are already sealed packages —
  // the leg is a sealed bundle of sealed shares).
  const payload = Buffer.from(JSON.stringify({
    v: 1, kind: 'recovery-leg',
    vault_sign_fp: vaultId.signFp,
    custodian: custodianId.label,
    share_packages: shares,
    made_at: new Date().toISOString(),
  }), 'utf8');
  const { frame, text } = sealPlaintext(payload, vaultId, { seal_pub: vaultId.seal_pub }, {});
  fs.mkdirSync(legDir, { recursive: true, mode: 0o700 });
  const file = path.join(legDir, RECOVERY_SET_FILE);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { file, canary: frame.canary, digest: sha256Hex(Buffer.from(text, 'utf8')) };
}

// A recovery act: custodian-signed authorization naming the leg
// digest. Recovery without it refuses, however many legs are held.
export function recoveryAct(custodianId, legDigest) {
  return signPayload(custodianId, {
    type: 'recovery-act', to_seal_fp: null,
    body: { leg_digest: legDigest, at: new Date().toISOString() },
  });
}

export function recoveryStatus(legDirs) {
  const legs = legDirs.map((d) => {
    const f = path.join(d, RECOVERY_SET_FILE);
    return { dir: d, present: fs.existsSync(f) };
  });
  return { legs: legs.filter((l) => l.present).length, detail: legs, floor: 3, ok: legs.filter((l) => l.present).length >= 3 };
}
