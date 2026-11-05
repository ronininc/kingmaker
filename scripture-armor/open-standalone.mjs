#!/usr/bin/env node
// Scripture Armor — STANDALONE OPENER (frozen-format, zero dependencies).
//
// This file exists to kill the orphan-format argument forever. It imports
// NOTHING from the Scripture Armor codebase — only the Node.js standard
// library — and it implements the complete package format (v1–v4) from
// FORMAT.md: frame parsing, signature verification (Ed25519, plus
// ML-DSA-65 on v4), the glyph layer, the key unseal (classical X25519 for
// v1–v3, hybrid X25519+ML-KEM-768 for v4), AEAD open, and the content
// commitment check. If every other line of Scripture Armor vanished
// tomorrow, this file + your identity store would still open every
// package ever sealed to you.
//
// Usage:
//   node open-standalone.mjs <package.scripture> --identity-dir <dir> [--out <file>]
// Without --out, the plaintext is written to stdout as raw bytes.
// Exit code 0 only when the signature verifies AND the package opens AND
// the content commitment (v3/v4) or SHA-256 (v1/v2) matches.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const pkgPath = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (!pkgPath) { console.error('usage: open-standalone.mjs <package.scripture> --identity-dir <dir> [--out <file>]'); process.exit(2); }
// A frozen independent opener cannot infer which product issued the package.
// Require the owner to choose a store; never silently adopt either install.
const idDir = opt('--identity-dir');
if (!idDir || !path.isAbsolute(idDir)) { console.error('an explicit absolute --identity-dir is required; no identity was read'); process.exit(2); }
const outPath = opt('--out');

const id = JSON.parse(fs.readFileSync(path.join(idDir, 'identity.json'), 'utf8'));
const okp = (crv, x, d) => d
  ? crypto.createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' })
  : crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
const sealPriv = okp('X25519', id.seal_pub, id.seal_priv);
const kemPriv = id.kem_priv
  ? crypto.createPrivateKey({ key: Buffer.from(id.kem_priv, 'base64'), format: 'der', type: 'pkcs8' })
  : null;

const text = fs.readFileSync(pkgPath, 'utf8');
const lines = text.split('\n');
const header = lines[0].trim();
if (!/^SCRIPTURE-ARMOR v[1-4]$/.test(header)) { console.error('not a scripture package'); process.exit(1); }
const frame = JSON.parse(lines[1]);
const body = lines.slice(2).join('\n').replace(/\n+$/, '');

// --- canonical frame (field lists per FORMAT.md) ---
const F1 = ['v', 'canary', 'created', 'expiry', 'sha256', 'sender_sign_fp', 'sender_sign_pub', 'recipient_seal_fp', 'armor_seed', 'eph_pub', 'key_nonce', 'key_ct', 'file_nonce'];
const FIELDS_V2 = ['v', 'canary', 'created', 'expiry', 'sha256', 'sender_sign_fp', 'sender_sign_pub', 'recipient_seal_fp', 'armor_seed', 'eph_pub', 'key_nonce', 'key_ct', 'file_nonce', 'scan_verdict', 'scan_digest', 'scan_report', 'scan_override', 'armor_tier'];
const FIELDS_V3 = ['v', 'canary', 'created', 'expiry', 'commit', 'sender_sign_fp', 'sender_sign_pub', 'recipient_seal_fp', 'armor_seed', 'eph_pub', 'key_nonce', 'key_ct', 'file_nonce', 'scan_verdict', 'scan_digest', 'scan_report', 'scan_override', 'armor_tier'];
const FIELDS_V4 = ['v', 'canary', 'created', 'expiry', 'commit', 'sender_sign_fp', 'sender_sign_pub', 'sender_mldsa_fp', 'sender_mldsa_pub', 'recipient_seal_fp', 'recipient_kem_fp', 'armor_seed', 'eph_pub', 'kem_alg', 'kem_ct', 'key_nonce', 'key_ct', 'file_nonce', 'scan_verdict', 'scan_digest', 'scan_report', 'scan_override', 'armor_tier'];
const fields = frame.v >= 4 ? FIELDS_V4 : frame.v >= 3 ? FIELDS_V3 : frame.v >= 2 ? FIELDS_V2 : F1;
const ordered = {};
for (const f of fields) ordered[f] = frame[f] ?? null;
const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
const signData = Buffer.from(JSON.stringify(ordered) + '\n' + bodyHash, 'utf8');

// --- signature verification ---
const edPub = okp('Ed25519', frame.sender_sign_pub);
if (!crypto.verify(null, signData, edPub, Buffer.from(frame.sig, 'base64'))) {
  console.error('SIGNATURE INVALID (Ed25519) — refusing'); process.exit(1);
}
if (frame.v >= 4) {
  if (!frame.sig_pq || !frame.sender_mldsa_pub) { console.error('v4 frame missing ML-DSA signature — refusing (downgrade)'); process.exit(1); }
  const pqPub = crypto.createPublicKey({ key: Buffer.from(frame.sender_mldsa_pub, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, signData, pqPub, Buffer.from(frame.sig_pq, 'base64'))) {
    console.error('SIGNATURE INVALID (ML-DSA-65) — refusing'); process.exit(1);
  }
}

// --- glyph layer ---
const BASE = [];
for (let cp = 0xE000; cp <= 0xE07F; cp++) BASE.push(cp);
for (let cp = 0x10600; cp <= 0x1063F; cp++) BASE.push(cp);
for (let cp = 0x12000; cp <= 0x1203F; cp++) BASE.push(cp);
const seed = Buffer.from(frame.armor_seed, 'base64');
const stream = Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.from('scripture-armor'), Buffer.from('glyph-perm/v1'), 4096));
let cursor = 0;
const randBelow = (n) => {
  const limit = 65536 - (65536 % n);
  for (;;) {
    const v = stream.readUInt16BE(cursor); cursor += 2;
    if (v < limit) return v % n;
  }
};
const idx = BASE.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) { const j = randBelow(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
const inverse = new Map();
idx.forEach((baseIdx, byteVal) => inverse.set(String.fromCodePoint(BASE[baseIdx]), byteVal));
const bytes = [];
for (const ch of body) {
  if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
  const v = inverse.get(ch);
  if (v === undefined) { console.error('glyph body does not decode'); process.exit(1); }
  bytes.push(v);
}
const payload = Buffer.from(bytes);

// --- key unseal ---
const ephPubRaw = Buffer.from(frame.eph_pub, 'base64url');
const ephPub = okp('X25519', frame.eph_pub);
const xShared = crypto.diffieHellman({ privateKey: sealPriv, publicKey: ephPub });
let wrapKey;
if (frame.v >= 4) {
  if (!frame.kem_ct || !kemPriv) { console.error('v4 package needs the identity ML-KEM key — refusing'); process.exit(1); }
  const kemShared = crypto.decapsulate(kemPriv, Buffer.from(frame.kem_ct, 'base64'));
  wrapKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([xShared, kemShared]),
    Buffer.concat([ephPubRaw, Buffer.from(frame.kem_ct, 'base64')]), Buffer.from('scripture-wrap/file-key/v2'), 32));
} else {
  wrapKey = Buffer.from(crypto.hkdfSync('sha256', xShared, ephPubRaw, Buffer.from('scripture-wrap/file-key/v1'), 32));
}
function aeadOpen(key, nonce, ct, tag) {
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
const keyBlob = Buffer.from(frame.key_ct, 'base64');
const fileKey = aeadOpen(wrapKey, Buffer.from(frame.key_nonce, 'base64'),
  keyBlob.subarray(0, keyBlob.length - 16), keyBlob.subarray(keyBlob.length - 16));

// --- content open + integrity ---
const ct = payload.subarray(0, payload.length - 16);
const tag = payload.subarray(payload.length - 16);
const plaintext = aeadOpen(fileKey, Buffer.from(frame.file_nonce, 'base64'), ct, tag);
if (frame.v >= 3) {
  const ck = Buffer.from(crypto.hkdfSync('sha256', fileKey, Buffer.alloc(0), Buffer.from('scripture-armor/commit/v1'), 32));
  const commit = crypto.createHmac('sha256', ck).update(plaintext).digest('hex');
  if (commit !== frame.commit) { console.error('COMMITMENT MISMATCH — content is not what was sealed'); process.exit(1); }
} else if (frame.sha256) {
  const h = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (h !== frame.sha256) { console.error('SHA-256 MISMATCH'); process.exit(1); }
}

if (outPath) { fs.writeFileSync(outPath, plaintext); console.error(`opened ${plaintext.length} bytes -> ${outPath} (signatures verified, integrity verified)`); }
else process.stdout.write(plaintext);
