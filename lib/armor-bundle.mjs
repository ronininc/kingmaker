// lib/armor-bundle.mjs — the PUBLIC, frozen Scripture Armor PACKAGE FORMAT, implemented with Node's standard library
// (scripture-armor FORMAT.md: frame + dual signature + glyph skin + hybrid X25519/ML-KEM-768 key unseal +
// ChaCha20-Poly1305 + keyed commitment). Kingmaker's release tooling (lib/release-manifest-seal.mjs,
// lib/release-parts-seal.mjs) seals and opens its own release parts with it.
//
// 2026-11-17 (owner decision: Armor is the single owner of its code): the sealed in-payload copy of Armor that this
// file used to load (armor-bundle.scripture + key escrow + lib/armor-bundle-pin.mjs + lib/armor-bundle-build.mjs) is
// removed. Kingmaker reaches Armor only through lib/armor-connection.mjs, the authenticated connection to the
// separately installed Scripture Armor. Only the format functions remain here; they implement a format, not Armor.
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARMOR_BUNDLE_SCHEMA = 'kingmaker.armor-bundle/1';
export const BUNDLE_FILE = 'armor-bundle.scripture';
export const ESCROW_FILE = 'armor-bundle.key.scripture';
export const DEVICE_BUNDLE_FILE = 'armor-bundle.device.scripture';

export class ArmorBundleError extends Error {
  constructor(code, detail) {
    super(`ARMOR_BUNDLE_${code}: ${detail}`);
    this.name = 'ArmorBundleError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new ArmorBundleError(code, detail); };

// ── The public package format (FORMAT.md) ────────────────────────────────────────────────────

const FRAME_FIELDS_V4 = [
  'v', 'canary', 'created', 'expiry', 'commit', 'sender_sign_fp', 'sender_sign_pub',
  'sender_mldsa_fp', 'sender_mldsa_pub', 'recipient_seal_fp', 'recipient_kem_fp', 'armor_seed',
  'eph_pub', 'kem_alg', 'kem_ct', 'key_nonce', 'key_ct', 'file_nonce', 'scan_verdict',
  'scan_digest', 'scan_report', 'scan_override', 'armor_tier',
];
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const okp = (crv, x, d) => (d
  ? crypto.createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' })
  : crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' }));
const derPub = (b64der) => crypto.createPublicKey({ key: unb64(b64der), format: 'der', type: 'spki' });
const derPriv = (b64der) => crypto.createPrivateKey({ key: unb64(b64der), format: 'der', type: 'pkcs8' });

function parsePackage(text) {
  const lines = String(text).split('\n');
  if (!/^SCRIPTURE-ARMOR v[1-4]$/.test((lines[0] ?? '').trim())) fail('PARSE', 'not a Scripture Armor package (bad header)');
  let frame;
  try { frame = JSON.parse(lines[1]); } catch { fail('PARSE', 'the package frame is not JSON'); }
  return { frame, body: lines.slice(2).join('\n').replace(/\n+$/, '') };
}

function frameSignData(frame, body) {
  const ordered = {};
  for (const f of FRAME_FIELDS_V4) ordered[f] = frame[f] ?? null;
  return Buffer.from(`${JSON.stringify(ordered)}\n${sha256Hex(Buffer.from(body, 'utf8'))}`, 'utf8');
}

const GLYPH_BASE = (() => {
  const out = [];
  for (let cp = 0xE000; cp <= 0xE07F; cp++) out.push(cp);
  for (let cp = 0x10600; cp <= 0x1063F; cp++) out.push(cp);
  for (let cp = 0x12000; cp <= 0x1203F; cp++) out.push(cp);
  return out;
})();

function permutedAlphabet(armorSeed) {
  const stream = Buffer.from(crypto.hkdfSync('sha256', armorSeed, Buffer.from('scripture-armor'), Buffer.from('glyph-perm/v1'), 4096));
  let cursor = 0;
  const randBelow = (n) => {
    const limit = 65536 - (65536 % n);
    for (;;) {
      if (cursor + 2 > stream.length) fail('OPEN', 'glyph permutation stream exhausted');
      const v = stream.readUInt16BE(cursor); cursor += 2;
      if (v < limit) return v % n;
    }
  };
  const idx = GLYPH_BASE.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = randBelow(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.map((baseIdx) => String.fromCodePoint(GLYPH_BASE[baseIdx]));
}

function glyphDecode(body, armorSeed) {
  const alphabet = permutedAlphabet(armorSeed);
  const inverse = new Map(alphabet.map((ch, byteVal) => [ch, byteVal]));
  const bytes = [];
  for (const ch of String(body)) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
    const v = inverse.get(ch);
    if (v === undefined) fail('OPEN', 'the glyph body does not decode');
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

function glyphEncode(payload, armorSeed) {
  const alphabet = permutedAlphabet(armorSeed);
  const chars = new Array(payload.length);
  for (let i = 0; i < payload.length; i++) chars[i] = alphabet[payload[i]];
  const lines = [];
  for (let i = 0; i < chars.length; i += 48) lines.push(chars.slice(i, i + 48).join(''));
  return lines.join('\n');
}

function aeadSeal(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ct, tag: cipher.getAuthTag() };
}
function aeadOpen(key, nonce, blob) {
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(ct), decipher.final()]); }
  catch { fail('OPEN', 'AEAD open failed — the package is tampered with or the key is wrong'); }
}

// ── Identities (armor's identity.json document shape, incl. its store-integrity tag) ────────

function storeIntegrityKey(sealPrivB64url) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sealPrivB64url, 'base64url'),
    Buffer.from('scripture-armor/store'), Buffer.from('scripture-armor/store/v1'), 32));
}
function identityTag(doc) {
  const copy = { ...doc };
  delete copy.integrity;
  return crypto.createHmac('sha256', storeIntegrityKey(doc.seal_priv)).update(JSON.stringify(copy), 'utf8').digest('hex');
}

function identityFromDoc(doc) {
  if (!doc || !doc.seal_pub || !doc.seal_priv || !doc.sign_pub || !doc.kem_priv || !doc.mldsa_priv) {
    fail('IDENTITY', 'the bundle identity document is incomplete');
  }
  return {
    doc,
    sealPriv: okp('X25519', doc.seal_pub, doc.seal_priv),
    signPriv: okp('Ed25519', doc.sign_pub, doc.sign_priv),
    kemPriv: derPriv(doc.kem_priv),
    mldsaPriv: derPriv(doc.mldsa_priv),
    sealFp: sha256Hex(Buffer.from(doc.seal_pub, 'base64url')),
    signFp: sha256Hex(Buffer.from(doc.sign_pub, 'base64url')),
    kemFp: sha256Hex(unb64(doc.kem_pub)),
    mldsaFp: sha256Hex(unb64(doc.mldsa_pub)),
    publicPeer: { seal_pub: doc.seal_pub, kem_pub: doc.kem_pub },
  };
}

function writeSecret(file, data) {
  writeFileSync(file, data, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** Create a fresh armor-format identity in `dir` (0700 dir, 0600 file, integrity-tagged). */
export function createBundleIdentity(dir, label = 'kingmaker-armor-bundle') {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  if (typeof crypto.encapsulate !== 'function' || typeof crypto.decapsulate !== 'function') {
    fail('IDENTITY', 'this runtime has no ML-KEM-768 (Node >= 24 required) — refusing a classical-only bundle identity');
  }
  const seal = crypto.generateKeyPairSync('x25519');
  const sign = crypto.generateKeyPairSync('ed25519');
  const kem = crypto.generateKeyPairSync('ml-kem-768');
  const mldsa = crypto.generateKeyPairSync('ml-dsa-65');
  const doc = {
    v: 1,
    label,
    created: new Date().toISOString(),
    seal_pub: seal.publicKey.export({ format: 'jwk' }).x,
    seal_priv: seal.privateKey.export({ format: 'jwk' }).d,
    sign_pub: sign.publicKey.export({ format: 'jwk' }).x,
    sign_priv: sign.privateKey.export({ format: 'jwk' }).d,
    kem_pub: kem.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    kem_priv: kem.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    mldsa_pub: mldsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    mldsa_priv: mldsa.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
  doc.integrity = identityTag(doc);
  writeSecret(join(dir, 'identity.json'), JSON.stringify(doc, null, 2));
  return identityFromDoc(doc);
}

/** Load the identity in `dir`, verifying its store-integrity tag first. Null when absent. */
export function loadBundleIdentity(dir) {
  const file = join(dir, 'identity.json');
  if (!existsSync(file)) return null;
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('IDENTITY', 'the bundle identity store does not parse'); }
  if (doc.integrity !== undefined && doc.integrity !== identityTag(doc)) {
    fail('IDENTITY_TAMPERED', 'the bundle identity store failed its integrity check — it was altered outside the loader; refusing to use it');
  }
  if (doc.integrity === undefined) { // pre-tag store: tag it in place, as the armor does
    doc.integrity = identityTag(doc);
    writeSecret(file, JSON.stringify(doc, null, 2));
  }
  return identityFromDoc(doc);
}

// ── Package open / seal (v4, the current format version) ─────────────────────────────────────

/**
 * Verify + open one sealed package for `identity`. Order matters and every step fails closed:
 * sender pin → dual signature (Ed25519 AND ML-DSA-65) → recipient match → hybrid key unseal →
 * AEAD open → keyed commitment. Returns the plaintext Buffer.
 */
export function openBundlePackage(text, identity, { expectSenderSignFp = null } = {}) {
  const { frame, body } = parsePackage(text);
  if (frame.v !== 4) fail('PARSE', `expected a v4 package, found v${frame.v}`);
  if (expectSenderSignFp && frame.sender_sign_fp !== expectSenderSignFp) {
    fail('PIN', `the package signer ${String(frame.sender_sign_fp).slice(0, 16)}… is not the pinned bundle signer ${String(expectSenderSignFp).slice(0, 16)}…`);
  }
  const signData = frameSignData(frame, body);
  let edOk = false;
  try { edOk = crypto.verify(null, signData, okp('Ed25519', frame.sender_sign_pub), unb64(frame.sig)); } catch { edOk = false; }
  if (!edOk) fail('SIGNATURE', 'the package Ed25519 signature does not verify — tampered or not sealed by its claimed signer');
  if (!frame.sig_pq || !frame.sender_mldsa_pub) fail('SIGNATURE', 'the v4 package is missing its ML-DSA-65 signature — downgrade refused');
  let pqOk = false;
  try { pqOk = crypto.verify(null, signData, derPub(frame.sender_mldsa_pub), unb64(frame.sig_pq)); } catch { pqOk = false; }
  if (!pqOk) fail('SIGNATURE', 'the package ML-DSA-65 signature does not verify — tampered or not sealed by its claimed signer');
  if (frame.recipient_seal_fp !== identity.sealFp || frame.recipient_kem_fp !== identity.kemFp) {
    fail('RECIPIENT', 'this package was not sealed to the bundle identity held on this device');
  }
  const ephPubRaw = Buffer.from(frame.eph_pub, 'base64url');
  const xShared = crypto.diffieHellman({ privateKey: identity.sealPriv, publicKey: okp('X25519', frame.eph_pub) });
  const kemShared = crypto.decapsulate(identity.kemPriv, unb64(frame.kem_ct));
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([xShared, kemShared]),
    Buffer.concat([ephPubRaw, unb64(frame.kem_ct)]), Buffer.from('scripture-wrap/file-key/v2'), 32));
  const fileKey = aeadOpen(wrapKey, unb64(frame.key_nonce), unb64(frame.key_ct));
  const payload = glyphDecode(body, unb64(frame.armor_seed));
  const plaintext = aeadOpen(fileKey, unb64(frame.file_nonce), payload);
  const commitKey = Buffer.from(crypto.hkdfSync('sha256', fileKey, Buffer.alloc(0), Buffer.from('scripture-armor/commit/v1'), 32));
  const commit = crypto.createHmac('sha256', commitKey).update(plaintext).digest('hex');
  if (commit !== frame.commit) fail('COMMIT', 'the package commitment does not match its contents — what was opened is not what was sealed');
  return plaintext;
}

/** Seal a buffer from `me` to `peer` ({ seal_pub, kem_pub }) as a v4 package. Mirror of the format's seal. */
export function sealBundlePackage(plaintext, me, peer) {
  if (!peer?.kem_pub) fail('SEAL', 'the recipient has no ML-KEM-768 key — v4 never seals classical-only');
  const fileKey = crypto.randomBytes(32);
  const sealedFile = aeadSeal(fileKey, Buffer.from(plaintext));
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPubRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const xShared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: okp('X25519', peer.seal_pub) });
  const { sharedKey: kemShared, ciphertext: kemCt } = crypto.encapsulate(derPub(peer.kem_pub));
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([xShared, kemShared]),
    Buffer.concat([ephPubRaw, kemCt]), Buffer.from('scripture-wrap/file-key/v2'), 32));
  const sealedKey = aeadSeal(wrapKey, fileKey);
  const commitKey = Buffer.from(crypto.hkdfSync('sha256', fileKey, Buffer.alloc(0), Buffer.from('scripture-armor/commit/v1'), 32));
  const armorSeed = crypto.randomBytes(16);
  const frame = {
    v: 4,
    canary: crypto.randomUUID(),
    created: new Date().toISOString(),
    expiry: null,
    commit: crypto.createHmac('sha256', commitKey).update(Buffer.from(plaintext)).digest('hex'),
    sender_sign_fp: me.signFp,
    sender_sign_pub: me.doc.sign_pub,
    sender_mldsa_fp: me.mldsaFp,
    sender_mldsa_pub: me.doc.mldsa_pub,
    recipient_seal_fp: sha256Hex(Buffer.from(peer.seal_pub, 'base64url')),
    recipient_kem_fp: sha256Hex(unb64(peer.kem_pub)),
    armor_seed: b64(armorSeed),
    eph_pub: ephPubRaw.toString('base64url'),
    kem_alg: 'ML-KEM-768',
    kem_ct: b64(kemCt),
    key_nonce: b64(sealedKey.nonce),
    key_ct: b64(Buffer.concat([sealedKey.ct, sealedKey.tag])),
    file_nonce: b64(sealedFile.nonce),
    scan_verdict: null, scan_digest: null, scan_report: null, scan_override: null, armor_tier: null,
  };
  const body = glyphEncode(Buffer.concat([sealedFile.ct, sealedFile.tag]), armorSeed);
  const signData = frameSignData(frame, body);
  frame.sig = b64(crypto.sign(null, signData, me.signPriv));
  frame.sig_pq = b64(crypto.sign(null, signData, me.mldsaPriv));
  return `SCRIPTURE-ARMOR v4\n${JSON.stringify(frame)}\n${body}\n`;
}
