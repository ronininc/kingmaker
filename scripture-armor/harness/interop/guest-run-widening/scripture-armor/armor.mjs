#!/usr/bin/env node
// armor.mjs — Scripture Armor, standalone (Robbie Glover / Ronin Inc)
// Zero-dependency Node >= 22 (node:crypto / node:fs / node:net only).
//
// Closed-loop doctrine: Scripture Armor forms a closed loop within whatever
// system it is applied to. A hash is generated when information LEAVES: every
// wrap registers the package's canary + plaintext SHA-256 + expiry with the
// matching copy's vault daemon (the issued-hash registry). The daemon waits
// for the return hash to match — a returning package is opened only if it is
// exactly what this loop issued, and only after owner approval. A package the
// loop never issued, one whose frame no longer matches its issuance, or one
// already returned is refused as a beacon event. A .scripture file alone,
// anywhere, is inert: unreadable, untranslatable glyphs that were never a
// language, around ciphertext whose key is sealed to a machine that isn't
// there.
//
// This program is format-compatible with the original scripture-wrap v1
// tools: same SCRIPTURE-ARMOR v1 package format, same frame fields, same
// HKDF labels, same glyph alphabet. Packages wrapped by either tool open in
// the other (point --identity-dir at the other store to use its identity).
// The default identity store here is ~/.scripture-armor.
//
// Commands:
//   identity [--label <name>] [--identity-dir <dir>]
//   trust <label> <public-identity-block> [--identity-dir <dir>]
//   wrap <file> --to <label> [--expires <ISO date>] [--identity-dir <dir>]
//             [--register-socket <path>] [--no-scan] [--override-scan <reason>]
//   register <file.scripture>… [--socket <path>] [--identity-dir <dir>]
//   inspect <file.scripture>
//   wrap-repo <dir> --to <label> [--out <dir>] [--chunk-size <bytes>]
//             [--expires <ISO date>] [--identity-dir <dir>] [--override-scan <reason>]
//   unwrap-repo <wrapped-dir> --into <dir> [--socket <path>]
//             [--daemon-out-dir <dir>] [--identity-dir <dir>]
//   verify <wrapped-dir> [--identity-dir <dir>]
//   reseal <file.scripture> [--socket <path>] [--daemon-out-dir <dir>]
//             [--out <new-package>] [--identity-dir <dir>]
//
// v2 (Closure 1): every wrap of code-class content is scanned first
// (scan.mjs); the verdict record is sealed as a first-class report
// package, and its digest + the armor tier ride INSIDE the target's
// signed v2 frame. Critical verdicts refuse the wrap; the owner's
// recorded override is the only way through. Data-class content records
// scan_verdict 'not-applicable'. v1 packages remain readable; v2
// packages fail closed in v1 tools (unknown header).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  loadPolicy, tierParams, classifyBuffer, scanFile, canonicalScanRecord, scanDigestOf,
} from './scan.mjs';

const VERSION = 1;
const PACKAGE_V2 = 2;
const PACKAGE_V3 = 3;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB parts in repo mode

// ---------------------------------------------------------------------------
// Paths / store
// ---------------------------------------------------------------------------

export function defaultIdentityDir() {
  return path.join(os.homedir(), '.scripture-armor');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------------------------------------------------------------------------
// Key helpers (OKP keys carried as JWK x/d strings)
// ---------------------------------------------------------------------------

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function pubRawFromX(xB64url) { return Buffer.from(xB64url, 'base64url'); }
export function fingerprintOfRaw(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function pubKeyFromX(crv, x) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' });
}
function privKeyFromXD(crv, x, d) {
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv, x, d }, format: 'jwk' });
}

export function loadIdentity(dir) {
  const file = path.join(dir, 'identity.json');
  if (!fs.existsSync(file)) return null;
  const id = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...id,
    sealPriv: privKeyFromXD('X25519', id.seal_pub, id.seal_priv),
    sealPub: pubKeyFromX('X25519', id.seal_pub),
    signPriv: privKeyFromXD('Ed25519', id.sign_pub, id.sign_priv),
    signPub: pubKeyFromX('Ed25519', id.sign_pub),
    sealFp: fingerprintOfRaw(pubRawFromX(id.seal_pub)),
    signFp: fingerprintOfRaw(pubRawFromX(id.sign_pub)),
  };
}

export function createIdentity(dir, label) {
  ensureDir(dir);
  const seal = crypto.generateKeyPairSync('x25519');
  const sign = crypto.generateKeyPairSync('ed25519');
  const sealJwkPub = seal.publicKey.export({ format: 'jwk' });
  const sealJwkPriv = seal.privateKey.export({ format: 'jwk' });
  const signJwkPub = sign.publicKey.export({ format: 'jwk' });
  const signJwkPriv = sign.privateKey.export({ format: 'jwk' });
  const id = {
    v: VERSION,
    label: label || os.hostname() || 'copy',
    created: new Date().toISOString(),
    seal_pub: sealJwkPub.x,
    seal_priv: sealJwkPriv.d,
    sign_pub: signJwkPub.x,
    sign_priv: signJwkPriv.d,
  };
  writeSecret(path.join(dir, 'identity.json'), JSON.stringify(id, null, 2));
  return loadIdentity(dir);
}

export function publicBlock(id) {
  const obj = { v: VERSION, seal_pub: id.seal_pub, sign_pub: id.sign_pub, label: id.label };
  return b64(Buffer.from(JSON.stringify(obj), 'utf8'));
}

export function parsePublicBlock(block) {
  const obj = JSON.parse(unb64(block.trim()).toString('utf8'));
  if (obj.v !== VERSION || !obj.seal_pub || !obj.sign_pub) {
    throw new Error('not a scripture public identity block');
  }
  // Garbage key material is refused here, not discovered at first wrap:
  // both public keys must be real 32-byte X25519 / Ed25519 points.
  for (const [field, crv] of [['seal_pub', 'X25519'], ['sign_pub', 'Ed25519']]) {
    const raw = pubRawFromX(obj[field]);
    if (raw.length !== 32) throw new Error(`invalid key material in public identity block (${field})`);
    try { pubKeyFromX(crv, obj[field]); } catch {
      throw new Error(`invalid key material in public identity block (${field})`);
    }
  }
  return obj;
}

export function loadAddressBook(dir) {
  const file = path.join(dir, 'addressbook.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveAddressBook(dir, book) {
  ensureDir(dir);
  writeSecret(path.join(dir, 'addressbook.json'), JSON.stringify(book, null, 2));
}

// ---------------------------------------------------------------------------
// AEAD (ChaCha20-Poly1305) — Layer 1, the actual math
// ---------------------------------------------------------------------------

function aeadSeal(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ct, tag: cipher.getAuthTag() };
}

function aeadOpen(key, nonce, ct, tag) {
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Seal a file key to a recipient's X25519 public key (ECDH + HKDF-SHA256).
function sealKeyToRecipient(fileKey, recipientSealPubX) {
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPubRaw = pubRawFromX(eph.publicKey.export({ format: 'jwk' }).x);
  const shared = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: pubKeyFromX('X25519', recipientSealPubX),
  });
  const wrapKey = Buffer.from(crypto.hkdfSync(
    'sha256', shared, ephPubRaw, Buffer.from('scripture-wrap/file-key/v1'), 32));
  const sealed = aeadSeal(wrapKey, fileKey);
  return {
    eph_pub: ephPubRaw.toString('base64url'),
    key_nonce: b64(sealed.nonce),
    key_ct: b64(Buffer.concat([sealed.ct, sealed.tag])),
  };
}

export function unsealFileKey(sealPriv, frame) {
  const ephPubRaw = Buffer.from(frame.eph_pub, 'base64url');
  const ephPub = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: frame.eph_pub }, format: 'jwk',
  });
  const shared = crypto.diffieHellman({ privateKey: sealPriv, publicKey: ephPub });
  const wrapKey = Buffer.from(crypto.hkdfSync(
    'sha256', shared, ephPubRaw, Buffer.from('scripture-wrap/file-key/v1'), 32));
  const blob = unb64(frame.key_ct);
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  return aeadOpen(wrapKey, unb64(frame.key_nonce), ct, tag);
}

// Open the armored payload (ct||tag) with the recovered file key.
export function openSealedFile(fileKey, frame, payload) {
  const ct = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  return aeadOpen(fileKey, unb64(frame.file_nonce), ct, tag);
}

// ---------------------------------------------------------------------------
// Glyph armor (Layer 2) — a visible skin, keyed per package, never the math.
// Alphabet: Private Use Area U+E000..U+E07F (128) + Linear A U+10600..U+1063F
// (64 decoys) + Cuneiform U+12000..U+1203F (64 decoys) = 256 glyphs, so each
// payload byte is exactly one glyph. The alphabet order is permuted by a
// Fisher-Yates shuffle driven by an HKDF stream seeded from the package's
// armor_seed, so the encoding changes with every package.
// ---------------------------------------------------------------------------

const GLYPH_BASE = (() => {
  const out = [];
  for (let cp = 0xE000; cp <= 0xE07F; cp++) out.push(cp);
  for (let cp = 0x10600; cp <= 0x1063F; cp++) out.push(cp);
  for (let cp = 0x12000; cp <= 0x1203F; cp++) out.push(cp);
  return out;
})();

function hkdfStream(seedBytes, info, length) {
  return Buffer.from(crypto.hkdfSync(
    'sha256', seedBytes, Buffer.from('scripture-armor'), Buffer.from(info), length));
}

export function permutedAlphabet(armorSeed) {
  const stream = hkdfStream(armorSeed, 'glyph-perm/v1', 4096);
  let cursor = 0;
  const randBelow = (n) => {
    const limit = 65536 - (65536 % n);
    for (;;) {
      if (cursor + 2 > stream.length) throw new Error('perm stream exhausted');
      const v = stream.readUInt16BE(cursor); cursor += 2;
      if (v < limit) return v % n;
    }
  };
  const idx = GLYPH_BASE.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  // alphabet[byteValue] = glyph char
  return idx.map((baseIdx) => String.fromCodePoint(GLYPH_BASE[baseIdx]));
}

export function armorEncode(payload, armorSeed) {
  const alphabet = permutedAlphabet(armorSeed);
  const chars = new Array(payload.length);
  for (let i = 0; i < payload.length; i++) chars[i] = alphabet[payload[i]];
  const lines = [];
  for (let i = 0; i < chars.length; i += 48) lines.push(chars.slice(i, i + 48).join(''));
  return lines.join('\n');
}

export function armorDecode(bodyText, armorSeed) {
  const alphabet = permutedAlphabet(armorSeed);
  const inverse = new Map();
  alphabet.forEach((glyph, byteVal) => inverse.set(glyph, byteVal));
  const bytes = [];
  for (const ch of bodyText) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
    const v = inverse.get(ch);
    if (v === undefined) throw new Error('armor body contains a foreign glyph');
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Frame — metadata that surrounds the payload, Ed25519-signed.
// ---------------------------------------------------------------------------

export const FRAME_FIELDS = [
  'v', 'canary', 'created', 'expiry', 'sha256',
  'sender_sign_fp', 'sender_sign_pub', 'recipient_seal_fp',
  'armor_seed', 'eph_pub', 'key_nonce', 'key_ct', 'file_nonce',
];

// v2 frame (SPEC §0.1): the scan block + armor tier ride INSIDE the
// signed canonical field list, after file_nonce. Fields outside the
// canonical list are dropped from the signed data and would be silently
// malleable — that is why the extension is a new field list, not new
// ad-hoc frame keys.
export const FRAME_FIELDS_V2 = [
  ...FRAME_FIELDS,
  'scan_verdict', 'scan_digest', 'scan_report', 'scan_override', 'armor_tier',
];

// v3 frame (Phase 4, FIX 3): the cleartext plaintext SHA-256 is GONE.
// It was an offline oracle — anyone holding the artifact could confirm
// a guessed plaintext (the red team recovered a 4-digit PIN in 40 ms)
// and link two wraps of the same content. In its place, `commit`: an
// HMAC over the plaintext keyed by a commitment key derived from the
// package's own file key (HKDF). Only a party who can unseal the file
// key — the recipient — can compute or verify it; an artifact holder
// learns nothing and cannot link wraps (every wrap has a fresh key).
export const FRAME_FIELDS_V3 = [
  'v', 'canary', 'created', 'expiry', 'commit',
  'sender_sign_fp', 'sender_sign_pub', 'recipient_seal_fp',
  'armor_seed', 'eph_pub', 'key_nonce', 'key_ct', 'file_nonce',
  'scan_verdict', 'scan_digest', 'scan_report', 'scan_override', 'armor_tier',
];

export function canonicalFrame(frame) {
  const fields = frame && frame.v >= 3 ? FRAME_FIELDS_V3
    : frame && frame.v >= 2 ? FRAME_FIELDS_V2 : FRAME_FIELDS;
  const ordered = {};
  for (const f of fields) ordered[f] = frame[f] ?? null;
  return JSON.stringify(ordered);
}

// The keyed content commitment (FIX 3). Derived from the file key, so
// it exists exactly where the file key exists: at seal time and at the
// recipient's open. Nowhere else — that is the whole point.
export function commitFor(fileKey, plaintext) {
  const ck = Buffer.from(crypto.hkdfSync('sha256', fileKey, Buffer.alloc(0),
    Buffer.from('scripture-armor/commit/v1', 'utf8'), 32));
  return crypto.createHmac('sha256', ck).update(plaintext).digest('hex');
}

// The one digest every registry/return-match path uses: the keyed
// commitment on v3 frames, the legacy plaintext SHA-256 on v1/v2
// frames (their exposure is inherent to their format and documented).
export function frameDigest(frame) {
  if (!frame) return null;
  return frame.commit ?? frame.sha256 ?? null;
}
export function frameDigestKind(frame) {
  return frame && frame.commit != null ? 'commit' : 'sha256';
}

export function frameSignData(frame, bodyText) {
  const bodyHash = crypto.createHash('sha256').update(bodyText, 'utf8').digest('hex');
  return Buffer.from(canonicalFrame(frame) + '\n' + bodyHash, 'utf8');
}

export function parseScriptureFile(text) {
  const lines = text.split('\n');
  const header = lines[0].trim();
  if (header !== 'SCRIPTURE-ARMOR v1' && header !== 'SCRIPTURE-ARMOR v2' && header !== 'SCRIPTURE-ARMOR v3') {
    throw new Error('missing SCRIPTURE-ARMOR v1/v2/v3 header');
  }
  const frame = JSON.parse(lines[1]);
  const body = lines.slice(2).join('\n').replace(/\n+$/, '');
  return { frame, body };
}

export function verifyFrameSignature(frame, body) {
  try {
    const pub = pubKeyFromX('Ed25519', frame.sender_sign_pub);
    return crypto.verify(null, frameSignData(frame, body), pub, unb64(frame.sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mesh documents (Closure 4, SPEC §4.2) — the estate's RPC envelope.
//
// Every mesh RPC is an application-signed canonical JSON document: the
// same discipline as frame signing (fixed field order, Ed25519 over the
// canonical bytes), extracted here as signPayload()/verifyPayload() so
// package frames and mesh documents share ONE signing discipline.
// WireGuard (the tailnet) tells a daemon which MACHINE is calling; the
// signature tells it which ARMOR IDENTITY — both are checked at the
// receiving daemon's gate, and either failing refuses the RPC.
//
// An envelope names its sender by fingerprint AND carries the sender's
// public sign key so the signature is verifiable standalone; the
// receiver additionally requires the fingerprint+key pair to match its
// address book exactly, so a self-asserted key gains nothing.
// ---------------------------------------------------------------------------

export const MESH_DOC_FIELDS = [
  'mesh', 'type', 'from_label', 'from_sign_fp', 'from_seal_fp',
  'from_sign_pub', 'to_seal_fp', 'at', 'nonce', 'body',
];

export function canonicalMeshDoc(doc) {
  const ordered = {};
  for (const f of MESH_DOC_FIELDS) ordered[f] = doc[f] ?? null;
  return JSON.stringify(ordered);
}

export function signPayload(me, doc) {
  const full = {
    mesh: 1,
    type: doc.type,
    from_label: me.label,
    from_sign_fp: me.signFp,
    from_seal_fp: me.sealFp,
    from_sign_pub: me.sign_pub,
    to_seal_fp: doc.to_seal_fp ?? null,
    at: doc.at || new Date().toISOString(),
    nonce: doc.nonce || crypto.randomUUID(),
    body: doc.body ?? {},
  };
  full.sig = b64(crypto.sign(null, Buffer.from(canonicalMeshDoc(full), 'utf8'), me.signPriv));
  return full;
}

export function verifyPayload(doc) {
  try {
    if (!doc || doc.mesh !== 1 || !doc.sig || !doc.from_sign_pub) return false;
    const pub = pubKeyFromX('Ed25519', doc.from_sign_pub);
    return crypto.verify(null, Buffer.from(canonicalMeshDoc(doc), 'utf8'), pub, unb64(doc.sig));
  } catch {
    return false;
  }
}

// One-shot mesh RPC client: one NDJSON line out, one line back, over a
// plain TCP connection to the peer daemon's mesh listener (bound to its
// tailnet address in production; loopback in the test harness — the
// same code path either way). Resolves null on any transport failure:
// an unreachable endpoint is an outbox event, never an exception.
export function meshRpc(addr, doc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const i = String(addr).lastIndexOf(':');
    const host = String(addr).slice(0, i);
    const port = Number(String(addr).slice(i + 1));
    if (!host || !Number.isFinite(port)) { resolve(null); return; }
    const conn = net.createConnection(port, host);
    let buf = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { conn.destroy(); } catch {} resolve(v); } };
    conn.setTimeout(timeoutMs, () => done(null));
    conn.on('connect', () => conn.write(JSON.stringify(doc) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) { try { done(JSON.parse(buf.slice(0, idx))); } catch { done(null); } }
    });
    conn.on('error', () => done(null));
    conn.on('close', () => done(null));
  });
}

// ---------------------------------------------------------------------------
// Sealing — one buffer in, one complete package out. This is the exact v1
// wrap operation; `wrap`, `wrap-repo` parts and the repo manifest all use it.
// ---------------------------------------------------------------------------

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sealPlaintext(plaintext, me, peer, { expires = null, scan = null } = {}) {
  const fileKey = crypto.randomBytes(32);
  const sealedFile = aeadSeal(fileKey, plaintext);
  const payload = Buffer.concat([sealedFile.ct, sealedFile.tag]); // armored body
  const sealedKey = sealKeyToRecipient(fileKey, peer.seal_pub);

  const armorSeed = crypto.randomBytes(16);
  const frame = {
    v: PACKAGE_V3,
    canary: crypto.randomUUID(),
    created: new Date().toISOString(),
    expiry: expires ? new Date(expires).toISOString() : null,
    // FIX 3: keyed commitment, never the raw plaintext hash (see
    // FRAME_FIELDS_V3). Computable only with this package's file key.
    commit: commitFor(fileKey, plaintext),
    sender_sign_fp: me.signFp,
    sender_sign_pub: me.sign_pub,
    recipient_seal_fp: fingerprintOfRaw(pubRawFromX(peer.seal_pub)),
    armor_seed: b64(armorSeed),
    eph_pub: sealedKey.eph_pub,
    key_nonce: sealedKey.key_nonce,
    key_ct: sealedKey.key_ct,
    file_nonce: b64(sealedFile.nonce),
    // v2 scan block — inside the signed canonical fields (SPEC §0.1).
    // `scan` = { verdict, digest, reportCanary, override } or null.
    scan_verdict: scan ? scan.verdict : null,
    scan_digest: scan ? scan.digest : null,
    scan_report: scan ? scan.reportCanary : null,
    scan_override: scan ? (scan.override ?? null) : null,
    armor_tier: scan && scan.tier != null ? scan.tier : null,
  };
  const body = armorEncode(payload, armorSeed);
  frame.sig = b64(crypto.sign(null, frameSignData(frame, body), me.signPriv));
  const text = `SCRIPTURE-ARMOR v3\n${JSON.stringify(frame)}\n${body}\n`;
  return { frame, text };
}

// ---------------------------------------------------------------------------
// Egress registration — the hash generated when information leaves.
//
// Every wrap registers the package's issuance (canary, plaintext SHA-256,
// recipient seal fingerprint, sender sign fingerprint, expiry) with the
// vault daemon of the loop it was sealed for. The daemon keeps the
// issued-hash registry; the return-match at unwrap time is checked against
// it. If the daemon cannot be reached at wrap time the issuance is NOT
// silently skipped: it is queued in registry-outbox.jsonl (mode 0600) in
// the wrapping identity's store, and the queue syncs on the next
// successful registration contact (any later wrap or an explicit
// `register` run). Until an issuance syncs, the daemon will refuse that
// package as never-issued — that is the doctrine working as designed.
// ---------------------------------------------------------------------------

function daemonRpc(socketPath, obj, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { conn.destroy(); } catch {} reject(e); } };
    conn.setTimeout(timeoutMs, () => fail(new Error('daemon-rpc-timeout')));
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0 && !settled) {
        settled = true;
        conn.end();
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
      }
    });
    conn.on('error', fail);
  });
}

// ---------------------------------------------------------------------------
// Owner channel (Phase 4, FIX 1) — the daemon serves TWO Unix sockets.
// The requester socket (present/pending-public/status-public/terms and
// SIGNED registration) stays where it always was. Every owner act —
// approve, unsigned register, revoke, revoke-grant, clear-anomaly,
// supersede, accept-terms, mesh-sync, estate view — lives on a second
// socket in a 0700 `owner/` directory beside the requester socket, the
// socket itself mode 0600, and every owner request must additionally
// carry the per-daemon owner token the daemon writes (0600) beside it
// at serve time. The paths derive from the requester socket path by
// ONE rule, shared by the daemon, this CLI, and the test batteries.
// ---------------------------------------------------------------------------

export function ownerDirFor(socketPath) {
  return path.join(path.dirname(socketPath), 'owner');
}
export function ownerSocketFor(socketPath) {
  return path.join(ownerDirFor(socketPath), `${path.basename(socketPath)}.owner`);
}
export function ownerTokenPathFor(socketPath) {
  return path.join(ownerDirFor(socketPath), `${path.basename(socketPath)}.owner.token`);
}
export function ownerConfirmPathFor(socketPath, id) {
  return path.join(ownerDirFor(socketPath), `${path.basename(socketPath)}.confirm-${id}.json`);
}
export function readOwnerConfirm(socketPath, id) {
  try { return JSON.parse(fs.readFileSync(ownerConfirmPathFor(socketPath, id), 'utf8')); }
  catch { return null; }
}

// One owner-channel RPC from a client that holds the identity store
// (this CLI, the batteries): reads the token the daemon left beside
// the owner socket and presents it with the request.
export function ownerRpc(socketPath, obj, timeoutMs = 5000) {
  let token = null;
  try { token = fs.readFileSync(ownerTokenPathFor(socketPath), 'utf8').trim(); } catch {}
  if (!token) {
    return Promise.reject(new Error('owner channel unavailable: no owner token beside the daemon socket (is the daemon running?)'));
  }
  return daemonRpc(ownerSocketFor(socketPath), { ...obj, owner_token: token }, timeoutMs);
}

// Signed local registration (FIX 1): a registration arriving on the
// REQUESTER socket must be signed by the issuing identity — the same
// discipline as mesh documents, over a canonical field list. The
// daemon verifies the signature, requires the signer to be itself or
// an address-book member, and requires every entry to name that same
// signer as its sender. Unsigned registration exists ONLY on the
// owner channel, where the token + socket permissions are the proof.
export const LOCAL_REGISTER_FIELDS = ['cmd', 'from_sign_fp', 'from_sign_pub', 'at', 'nonce', 'entries'];

export function canonicalLocalRegister(doc) {
  const ordered = {};
  for (const f of LOCAL_REGISTER_FIELDS) ordered[f] = doc[f] ?? null;
  return JSON.stringify(ordered);
}

export function signLocalRegister(me, entries) {
  const doc = {
    cmd: 'register',
    from_sign_fp: me.signFp,
    from_sign_pub: me.sign_pub,
    at: new Date().toISOString(),
    nonce: crypto.randomUUID(),
    entries,
  };
  doc.sig = b64(crypto.sign(null, Buffer.from(canonicalLocalRegister(doc), 'utf8'), me.signPriv));
  return doc;
}

export function verifyLocalRegister(doc) {
  try {
    if (!doc || doc.cmd !== 'register' || !doc.sig || !doc.from_sign_pub) return false;
    if (fingerprintOfRaw(pubRawFromX(doc.from_sign_pub)) !== doc.from_sign_fp) return false;
    const pub = pubKeyFromX('Ed25519', doc.from_sign_pub);
    return crypto.verify(null, Buffer.from(canonicalLocalRegister(doc), 'utf8'), pub, unb64(doc.sig));
  } catch {
    return false;
  }
}

function outboxPath(dir) { return path.join(dir, 'registry-outbox.jsonl'); }

function readOutbox(dir) {
  try {
    return fs.readFileSync(outboxPath(dir), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

function writeOutbox(dir, entries) {
  const file = outboxPath(dir);
  if (!entries.length) { try { fs.unlinkSync(file); } catch {} return; }
  ensureDir(dir);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------------------------------------------------------------------------
// Estate records (Closure 4, SPEC §4.3–§4.5) — files in the identity
// store, shared by armor.mjs (enroll / wrap-side checks) and vaultd.mjs
// (enforcement / sync). All mode 0600, rewritten atomically, re-read per
// operation like the registry.
//
//   revocations.json  signed revocation records (the estate's memory of
//                     who was cut off, when, and by whom)
//   estate.json       this endpoint's estate view: members + proof
//                     state, per-peer last-sync, revocation ack table
//   issued-log.jsonl  the issuer-side memory: every issuance this
//                     endpoint's armor sealed and sent, in full — what
//                     makes a forged registry claim DETECTABLE at sync
//                     (SPEC §4.6: a canary the counterparty never
//                     issued surfaces as a conflict; detection only —
//                     the v1 F2–F4 prevention gap stands, §4.6/§5)
//   estate-events.jsonl  armor-side estate acts (untrust) that are not
//                     daemon events (the daemon logs its own to
//                     vaultd.log)
// ---------------------------------------------------------------------------

export const REVOCATION_FIELDS = ['label', 'seal_fp', 'sign_fp', 'at', 'by_sign_fp', 'by_label', 'reason'];

export function canonicalRevocation(rec) {
  const ordered = {};
  for (const f of REVOCATION_FIELDS) ordered[f] = rec[f] ?? null;
  return JSON.stringify(ordered);
}

export function revocationId(rec) {
  return crypto.createHash('sha256').update(canonicalRevocation(rec), 'utf8').digest('hex');
}

export function signRevocation(me, rec) {
  const full = { ...rec };
  full.id = revocationId(full);
  full.sig = b64(crypto.sign(null, Buffer.from(canonicalRevocation(full), 'utf8'), me.signPriv));
  return full;
}

// A revocation record is enforced only when its signature verifies
// against a KNOWN sign key for by_sign_fp (the owner's own identity, or
// an address-book member). `resolveSignPub(signFp)` returns the base64url
// JWK x for that fingerprint, or null. Unverifiable records are kept on
// file (they are claims, and claims are evidence) but never enforced.
export function verifyRevocation(rec, resolveSignPub) {
  try {
    if (!rec || !rec.sig || !rec.by_sign_fp) return false;
    if (revocationId(rec) !== rec.id) return false;
    const x = resolveSignPub(rec.by_sign_fp);
    if (!x) return false;
    const pub = pubKeyFromX('Ed25519', x);
    return crypto.verify(null, Buffer.from(canonicalRevocation(rec), 'utf8'), pub, unb64(rec.sig));
  } catch {
    return false;
  }
}

export function loadRevocations(dir) {
  try {
    const revs = JSON.parse(fs.readFileSync(path.join(dir, 'revocations.json'), 'utf8'));
    if (revs && Array.isArray(revs.records)) return revs;
  } catch {}
  return { v: 1, records: [] };
}

export function saveRevocations(dir, revs) {
  const file = path.join(dir, 'revocations.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(revs, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

// The verified revocation in force for a sign fingerprint (the LATEST
// verified record wins — a re-revocation updates the taint instant), or
// null. Unverified records never taint.
export function revocationFor(revs, signFp, resolveSignPub) {
  let best = null;
  for (const rec of revs.records || []) {
    if (rec.sign_fp !== signFp) continue;
    if (!verifyRevocation(rec, resolveSignPub)) continue;
    if (!best || Date.parse(rec.at) > Date.parse(best.at)) best = rec;
  }
  return best;
}

export function loadEstateState(dir) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'estate.json'), 'utf8'));
    if (st && typeof st === 'object') {
      st.members = st.members || {};
      st.last_sync = st.last_sync || {};
      st.revocation_acks = st.revocation_acks || {};
      st.proofs = st.proofs || [];
      return st;
    }
  } catch {}
  return { v: 1, members: {}, last_sync: {}, last_sync_any: null, revocation_acks: {}, proofs: [] };
}

export function saveEstateState(dir, st) {
  const file = path.join(dir, 'estate.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function appendEstateEvent(dir, rec) {
  try {
    fs.appendFileSync(
      path.join(dir, 'estate-events.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n',
      { mode: 0o600 });
  } catch {}
}

// Issuer-side memory (see the section header). Entries are the full
// issuance objects exactly as registered — sync needs them whole to
// fulfill a counterparty's `want` and to judge held-claim conflicts.
export function appendIssuedLog(dir, entries) {
  if (!entries || !entries.length) return;
  try {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(path.join(dir, 'issued-log.jsonl'), lines, { mode: 0o600 });
  } catch {}
}

export function loadIssuedLog(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'issued-log.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

function frameToIssuance(frame, extra = {}) {
  return {
    canary: frame.canary,
    // FIX 3: the registry carries the frame's digest — the keyed
    // commitment on v3, the legacy hash on v1/v2 — never a second,
    // independently-computable plaintext hash.
    digest: frameDigest(frame),
    digest_kind: frameDigestKind(frame),
    recipient_seal_fp: frame.recipient_seal_fp,
    sender_sign_fp: frame.sender_sign_fp,
    expiry: frame.expiry ?? null,
    issued_at: frame.created || new Date().toISOString(),
    // v2 registry extensions (SPEC §0.2) — optional; inert under v1 readers.
    origin: extra.origin || 'egress',
    scan: frame.scan_verdict != null
      ? { verdict: frame.scan_verdict, digest: frame.scan_digest ?? null, report_canary: frame.scan_report ?? null }
      : (extra.scan ?? null),
    tier: frame.armor_tier != null
      ? { tier: frame.armor_tier, params: extra.tierParams ?? null }
      : (extra.tier ?? null),
    repo: extra.repo ?? null,
    report_for: extra.reportFor ?? null,
    report_only: extra.reportOnly ?? false,
    // Closure 4: enrollment markers ride the issuance like every other
    // registry extension — {kind:'descriptor'|'probe', ...} or null.
    estate: extra.estate ?? null,
  };
}

// Register a batch of issuances (plus any queued outbox entries) with the
// daemon of the loop they were sealed for. Returns {synced, queued,
// refused}. A daemon that answers and refuses an entry (wrong recipient,
// canary conflict) is a configuration fact, not a transient failure:
// refused entries are dropped with a warning rather than queued forever.
// Only an unreachable daemon queues.
//
// `transport` (Closure 4, SPEC §4.2): a string is a local Unix socket
// path (the v1 transport, unchanged). An object {mesh: "<ip>:<port>",
// toSealFp} is the estate transport — the SAME register semantics and
// the SAME outbox queueing, carried as a signed mesh RPC to the
// recipient endpoint's daemon. Queued entries remember their mesh
// destination (`_mesh_to`) and flush only to that destination's daemon;
// entries queued for other destinations stay queued.
export async function registerIssuances(dir, transport, frames, extrasByCanary = {}) {
  const fresh = frames.map((f) => frameToIssuance(f, extrasByCanary[f.canary] || {}));
  // Issuer-side memory first (SPEC §4.6): what this endpoint sealed and
  // sent is remembered in full, whatever the transport outcome — the
  // outbox may clear, the memory does not.
  if (fresh.length) appendIssuedLog(dir, fresh);
  const isMesh = transport && typeof transport === 'object' && transport.mesh;
  const queuedAll = readOutbox(dir);
  const relevant = [];
  const others = [];
  for (const e of queuedAll) {
    if (isMesh) {
      const dest = e._mesh_to ?? e.recipient_seal_fp;
      if (dest === transport.toSealFp) relevant.push(e); else others.push(e);
    } else relevant.push(e);
  }
  const byCanary = new Map();
  for (const e of [...relevant, ...fresh]) if (!byCanary.has(e.canary)) byCanary.set(e.canary, e);
  const all = [...byCanary.values()];
  if (!all.length) return { synced: 0, queued: others.length, refused: [] };
  let resp = null;
  if (isMesh) {
    const me = loadIdentity(dir);
    if (!me) throw new Error('no identity in this copy — mesh registration signs as this endpoint');
    const doc = signPayload(me, {
      type: 'register', to_seal_fp: transport.toSealFp, body: { entries: all },
    });
    resp = await meshRpc(transport.mesh, doc);
    // The response is a mesh document too: verify it came from the
    // daemon we addressed (its signature, its fingerprint), then
    // unwrap the result body — the register result has the same shape
    // on both transports from here on.
    if (resp && (resp.from_seal_fp !== transport.toSealFp || !verifyPayload(resp))) resp = null;
    if (resp) resp = resp.body ?? { ok: false, error: 'mesh register: empty result body' };
  } else {
    // Local transport: the registration is SIGNED by this endpoint's
    // identity (FIX 1) — the daemon's requester socket accepts no
    // unsigned registration from anyone, including this CLI.
    const me = loadIdentity(dir);
    if (!me) throw new Error('no identity in this copy — local registration signs as this endpoint');
    try { resp = await daemonRpc(transport, signLocalRegister(me, all)); } catch { resp = null; }
  }
  if (!resp) {
    const marked = isMesh ? all.map((e) => ({ ...e, _mesh_to: transport.toSealFp })) : all;
    writeOutbox(dir, [...others, ...marked]);
    return { synced: 0, queued: marked.length, refused: [] };
  }
  if (resp.ok !== true) {
    throw new Error(`daemon refused registration: ${resp.error || JSON.stringify(resp)}`);
  }
  writeOutbox(dir, others); // synced (or definitively refused) — this destination's queue clears
  return { synced: resp.registered || 0, queued: others.length, refused: resp.refused || [] };
}

function reportRegistration(what, res) {
  if (res.synced) console.error(`registered: ${res.synced} issuance(s) recorded with the vault daemon (${what})`);
  if (res.queued) {
    console.error(`WARNING: vault daemon unreachable — ${res.queued} issuance(s) queued in registry-outbox.jsonl.`);
    console.error('         Queued packages are refused as never-issued until the queue syncs (next wrap or `register`).');
  }
  for (const r of res.refused || []) {
    console.error(`WARNING: daemon refused issuance ${r.canary || '?'}: ${r.error}`);
  }
}

function registrationSocket(flags, dir) {
  if (flags['register-socket']) return path.resolve(flags['register-socket']);
  if (flags.socket) return path.resolve(flags.socket);
  return path.join(dir, 'vaultd.sock');
}

// Which transport carries registrations for THIS wrap's recipient
// (Closure 4): an explicit --register-socket/--socket wins (v1);
// --register-mesh names a mesh address directly; otherwise the peer's
// address-book entry decides — a `mesh` address (estate transport) or a
// `daemon_socket` path — and the default remains this copy's own daemon
// socket (the v1 single-loop behavior, byte-for-byte).
function registrationTransport(flags, dir, peer) {
  if (flags['register-socket'] || flags.socket) return registrationSocket(flags, dir);
  const peerSealFp = peer ? fingerprintOfRaw(pubRawFromX(peer.seal_pub)) : null;
  if (flags['register-mesh']) return { mesh: String(flags['register-mesh']), toSealFp: peerSealFp };
  if (peer && peer.mesh) return { mesh: peer.mesh, toSealFp: peerSealFp };
  if (peer && peer.daemon_socket) return path.resolve(peer.daemon_socket);
  return registrationSocket(flags, dir);
}

// ---------------------------------------------------------------------------
// Scan gate (Closure 1) — classify + scan BEFORE anything is sealed.
//
// prepareScan() returns one of:
//   { action: 'proceed', cls, record, digest, tier, params, reportSealed }
//   { action: 'refused', cls, record, digest, reportSealed }  (critical, no
//      override — the caller seals+registers the report as testimony,
//      writes the report file, and refuses the wrap)
// Data-class content proceeds with the not-applicable record and NO
// report package (the digest still binds the canonical record into the
// frame). Engine failures (Ghidra absent/timeout) throw — the wrap fails
// closed with the named error and nothing is written (SPEC §1.9 #12/#13).
// ---------------------------------------------------------------------------

function readStdinLine() {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) { process.stdin.off('data', onData); process.stdin.pause(); resolve(buf.slice(0, idx).trim()); }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

// The override is a typed act, not a flag alone (SPEC §1.6): the reason
// rides in --override-scan, and the owner must type OVERRIDE to confirm.
// confirmState lets repo mode confirm once for the whole batch.
async function confirmOverride(reason, confirmState) {
  if (confirmState.done) return confirmState.ok;
  console.error(`SCAN OVERRIDE requested — reason: ${reason}`);
  console.error('Type OVERRIDE to wrap critical-verdict content anyway (the override is signed into the frame):');
  const line = await readStdinLine();
  confirmState.done = true;
  confirmState.ok = line === 'OVERRIDE';
  return confirmState.ok;
}

async function prepareScan(absPath, { dir, policy, me, peer, overrideReason = null, confirmState = null, promptOverride = false }) {
  const { cls, record } = await scanFile(absPath, { policy, storeDir: dir });
  if (cls === 'data') {
    return {
      action: 'proceed', cls, record, digest: scanDigestOf(record),
      tier: 0, params: tierParams(0, policy), reportSealed: null,
    };
  }
  const required = (policy.scan.required_for || []).includes(cls);
  if (!required) {
    return { action: 'proceed', cls, record, digest: null, tier: null, params: null, reportSealed: null, unscanned: true };
  }
  let refused = false;
  if (record.verdict === 'critical') {
    let ok = false;
    let reason = overrideReason;
    if (overrideReason) {
      ok = confirmState ? await confirmOverride(overrideReason, confirmState) : true;
    } else if (promptOverride) {
      // Repo batch mode (SPEC §1.6): the typed OVERRIDE at the batch
      // prompt IS the override mechanism when no --override-scan reason
      // was supplied — once per batch (confirmState), applied per file.
      ok = await confirmOverride('repo batch: critical-verdict file(s) present', confirmState);
      reason = 'operator typed OVERRIDE at the repo batch prompt';
    }
    if (ok) {
      record.override = { by_sign_fp: me.signFp, reason: String(reason), at: new Date().toISOString() };
    } else {
      refused = true;
    }
  }
  // The report is sealed AFTER the override decision so the sealed record
  // (and the digest bound into the target's frame) is the final record.
  const canonical = canonicalScanRecord(record);
  const digest = scanDigestOf(record);
  const reportSealed = sealPlaintext(Buffer.from(canonical, 'utf8'), me, peer, {});
  const tier = record.risk ? record.risk.tier : 0;
  return {
    action: refused ? 'refused' : 'proceed', cls, record, digest,
    tier, params: tierParams(tier, policy), reportSealed,
  };
}

function frameScanBlock(prep) {
  if (!prep || prep.unscanned) {
    return { verdict: 'unscanned', digest: null, reportCanary: null, override: null, tier: null };
  }
  if (prep.cls === 'data') {
    return { verdict: 'not-applicable', digest: prep.digest, reportCanary: null, override: null, tier: 0 };
  }
  return {
    verdict: prep.record.verdict, digest: prep.digest,
    reportCanary: prep.reportSealed ? prep.reportSealed.frame.canary : null,
    override: prep.record.override ?? null, tier: prep.tier,
  };
}

// Tier expiry allocation (SPEC §1.7.2): Tier 1/2 wraps refuse an expiry
// beyond the cap; with no expiry requested, the cap itself is applied —
// a Tier-2 package without a ≤24 h expiry is never issued.
// --expires accepts an ISO date or a relative +<n>d / +<n>h. Anything
// else is a clear boundary error, never a raw Date crash downstream.
function resolveExpires(raw) {
  if (!raw) return null;
  const m = /^\+(\d+)([dh])$/.exec(String(raw).trim());
  if (m) return new Date(Date.now() + Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3)).toISOString();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`invalid --expires value: ${raw} (use an ISO date or +<n>d / +<n>h)`);
  return new Date(t).toISOString();
}

function allocateExpiry(requestedIso, tier, params, label, { clamp = false } = {}) {
  const capH = params && params.expiry_cap_hours;
  if (!capH) return requestedIso || null;
  const capMs = capH * 3600 * 1000;
  if (requestedIso) {
    if (Date.parse(requestedIso) - Date.now() > capMs + 60000) {
      if (clamp) {
        // Repo context (SPEC §1.9 case 19): a repo-wide expiry longer
        // than a part's tier cap SHORTENS that part to its cap, with
        // the shortening printed — it does not kill the repo.
        const clamped = new Date(Date.now() + capMs).toISOString();
        console.error(`tier ${tier}: ${label} — repo expiry exceeds the ${capH}h tier cap; part expiry clamped to ${clamped}`);
        return clamped;
      }
      throw new Error(`tier-expiry-cap: ${label} is Tier ${tier} — expiry beyond ${capH}h is refused (requested ${requestedIso})`);
    }
    return requestedIso;
  }
  const auto = new Date(Date.now() + capMs).toISOString();
  console.error(`tier ${tier}: no expiry requested — applying the ${capH}h cap expiry ${auto}`);
  return auto;
}

function printFindings(record, label) {
  console.error(`scan: ${label} — verdict ${record.verdict}, tier ${record.risk ? record.risk.tier : '?'}, engine ${record.engine.name}`);
  for (const f of record.findings || []) {
    if (f.severity === 'critical' || f.severity === 'high') {
      console.error(`  [${f.severity}] ${f.rule} @ ${f.location} — ${f.detail}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else pos.push(args[i]);
  }
  return { flags, pos };
}

function identityDir(flags) {
  return flags['identity-dir'] ? path.resolve(flags['identity-dir']) : defaultIdentityDir();
}

function loadSenderAndPeer(flags) {
  const to = flags.to;
  if (!to) throw new Error('missing --to <label>');
  const dir = identityDir(flags);
  const me = loadIdentity(dir);
  if (!me) throw new Error('no identity in this copy — run `identity` first');
  const book = loadAddressBook(dir);
  const peer = book[to];
  if (!peer) throw new Error(`no trusted peer "${to}" — run trust first`);
  return { me, peer, dir };
}

function cmdIdentity(flags) {
  const dir = identityDir(flags);
  let id = loadIdentity(dir);
  if (!id) {
    id = createIdentity(dir, flags.label);
    console.error(`identity created in ${dir}`);
  } else {
    console.error(`identity loaded from ${dir}`);
  }
  console.error(`label:      ${id.label}`);
  console.error(`seal fp:    ${id.sealFp}`);
  console.error(`sign fp:    ${id.signFp}`);
  // The portable public block — the ONLY thing on stdout:
  console.log(publicBlock(id));
}

function cmdTrust(flags, pos) {
  const [label, block] = pos;
  if (!label || !block) throw new Error('usage: trust <label> <public-identity-block> [--mesh <ip:port>]');
  const peer = parsePublicBlock(block);
  // Estate reachability (Closure 4): how this copy's registrations and
  // RPCs reach the peer's daemon — a mesh (tailnet) address, or a local
  // daemon socket path. Owner-supplied addressing, recorded verbatim.
  if (flags.mesh) peer.mesh = String(flags.mesh);
  if (flags['daemon-socket']) peer.daemon_socket = String(flags['daemon-socket']);
  const dir = identityDir(flags);
  const book = loadAddressBook(dir);
  book[label] = peer;
  saveAddressBook(dir, book);
  const sealFp = fingerprintOfRaw(pubRawFromX(peer.seal_pub));
  const signFp = fingerprintOfRaw(pubRawFromX(peer.sign_pub));
  console.log(`trusted "${label}"  seal fp ${sealFp.slice(0, 16)}…  sign fp ${signFp.slice(0, 16)}…${peer.mesh ? `  mesh ${peer.mesh}` : ''}`);
}

// untrust (SPEC §4.5) — the LOCAL inverse of trust: this endpoint can
// no longer wrap to, register with, or accept mesh RPCs from that
// peer. The estate-wide act is revocation (vaultd.mjs revoke); untrust
// is one endpoint's own bookkeeping. Logged to the estate event record.
function cmdUntrust(flags, pos) {
  const [label] = pos;
  if (!label) throw new Error('usage: untrust <label>');
  const dir = identityDir(flags);
  const book = loadAddressBook(dir);
  const peer = book[label];
  if (!peer) throw new Error(`no trusted peer "${label}"`);
  delete book[label];
  saveAddressBook(dir, book);
  appendEstateEvent(dir, {
    event: 'untrust', label,
    seal_fp: fingerprintOfRaw(pubRawFromX(peer.seal_pub)),
    sign_fp: fingerprintOfRaw(pubRawFromX(peer.sign_pub)),
  });
  console.log(`untrusted "${label}" — this copy will not wrap to it or accept its mesh RPCs (local act; estate-wide removal is revocation)`);
}

// enroll (SPEC §4.3) — the established endpoint's half of the ceremony.
// Birth + mutual trust have already happened (owner acts, both
// machines). This command seals the ESTATE DESCRIPTOR (member list +
// tiers + policy digest + current revocation list) and a PROBE package
// to the new endpoint as ordinary packages, and registers both with
// the new endpoint's daemon over the mesh. The new owner's approval of
// the descriptor package at their own daemon is the act of joining;
// the proof round-trip (the probe return-matching there) is what moves
// the member from `pending` to `verified` in this endpoint's state —
// an enrollment whose proof never lands is not an enrollment.
async function cmdEnroll(flags, pos) {
  const [label] = pos;
  if (!label) throw new Error('usage: enroll <label> [--tier <1|2>] [--out-dir <dir>]');
  const { me, peer, dir } = loadSenderAndPeer({ ...flags, to: label });
  const peerSealFp = fingerprintOfRaw(pubRawFromX(peer.seal_pub));
  const peerSignFp = fingerprintOfRaw(pubRawFromX(peer.sign_pub));
  const tier = flags.tier ? Number(flags.tier) : 1;
  if (![1, 2].includes(tier)) throw new Error('--tier must be 1 or 2 (Tier 3 is posture — it enrolls by descriptor listing, never by daemon)');
  const policy = loadPolicy(dir);
  const state = loadEstateState(dir);
  const book = loadAddressBook(dir);

  // The roster this endpoint vouches for: itself, every member it
  // already holds, and the new endpoint. Tier rides with each member —
  // the coverage map is part of the descriptor, not an assumption.
  const members = new Map();
  members.set(me.signFp, { label: me.label, seal_fp: me.sealFp, sign_fp: me.signFp, tier: state.self_tier ?? 1 });
  for (const m of Object.values(state.members)) {
    if (m.sign_fp && m.state !== 'revoked') {
      members.set(m.sign_fp, { label: m.label, seal_fp: m.seal_fp, sign_fp: m.sign_fp, tier: m.tier ?? 1 });
    }
  }
  members.set(peerSignFp, { label, seal_fp: peerSealFp, sign_fp: peerSignFp, tier });
  // Mesh host (Addendum B): the endpoint whose device is the mesh
  // server — named in the descriptor so every member knows whose
  // infrastructure governs routing/DNS/exit for the estate.
  let meshHost = { label: me.label, seal_fp: me.sealFp, sign_fp: me.signFp };
  if (policy.estate.mesh_host && book[policy.estate.mesh_host]) {
    const hp = book[policy.estate.mesh_host];
    meshHost = {
      label: policy.estate.mesh_host,
      seal_fp: fingerprintOfRaw(pubRawFromX(hp.seal_pub)),
      sign_fp: fingerprintOfRaw(pubRawFromX(hp.sign_pub)),
    };
  }
  const descriptor = {
    format: 'scripture-armor-estate/1',
    created: new Date().toISOString(),
    by: { label: me.label, seal_fp: me.sealFp, sign_fp: me.signFp },
    mesh_host: meshHost,
    members: [...members.values()],
    // Tier 3 — posture endpoints (locked-down devices): named, tiered,
    // and covered at the network layer by the mesh host + on-device
    // posture (dns-profiles/). NO key material exists for them —
    // they hold no keys, keep no registry, and cannot open packages.
    tier3: (policy.estate.tier3 || []).map((t) => ({
      label: t.label, tier: 3, keys: false, can_open: false,
      coverage: 'mesh-governed (routing/DNS/exit via the mesh host) + on-device posture (dns-profiles/)',
      note: t.note ?? null,
    })),
    policy_digest: sha256Hex(Buffer.from(JSON.stringify(policy), 'utf8')),
    revocations: loadRevocations(dir).records,
  };
  const probe = {
    format: 'scripture-armor-probe/1',
    kind: 'enroll-probe',
    by: { label: me.label, seal_fp: me.sealFp, sign_fp: me.signFp },
    for_sign_fp: peerSignFp,
    at: new Date().toISOString(),
  };
  const outDir = flags['out-dir'] ? path.resolve(flags['out-dir']) : process.cwd();
  fs.mkdirSync(outDir, { recursive: true });
  const descSealed = sealPlaintext(Buffer.from(JSON.stringify(descriptor, null, 2), 'utf8'), me, peer, {});
  const probeSealed = sealPlaintext(Buffer.from(JSON.stringify(probe), 'utf8'), me, peer, {});
  const descPath = path.join(outDir, `estate-descriptor-${label}.scripture`);
  const probePath = path.join(outDir, `estate-probe-${label}.scripture`);
  fs.writeFileSync(descPath, descSealed.text, { mode: 0o644 });
  fs.writeFileSync(probePath, probeSealed.text, { mode: 0o644 });

  // Record the pending membership BEFORE registering: until the probe
  // proof lands (reported back over sync), this endpoint's estate view
  // names the new member as pending — never as joined.
  state.members[peerSignFp] = {
    label, seal_fp: peerSealFp, sign_fp: peerSignFp, tier,
    state: 'pending',
    descriptor_canary: descSealed.frame.canary,
    probe_canary: probeSealed.frame.canary,
    enrolled_at: new Date().toISOString(),
  };
  if (!state.members[me.signFp]) {
    state.members[me.signFp] = {
      label: me.label, seal_fp: me.sealFp, sign_fp: me.signFp,
      tier: state.self_tier ?? 1, state: 'self',
    };
  }
  saveEstateState(dir, state);

  const transport = registrationTransport(flags, dir, peer);
  const res = await registerIssuances(dir, transport, [descSealed.frame, probeSealed.frame], {
    [descSealed.frame.canary]: { estate: { kind: 'descriptor', enroll_label: label } },
    [probeSealed.frame.canary]: { estate: { kind: 'probe', enroll_with: me.signFp } },
  });
  reportRegistration('enroll', res);
  console.log(descPath);
  console.log(probePath);
  console.error(`enrolling "${label}" (tier ${tier}): descriptor canary ${descSealed.frame.canary}, probe canary ${probeSealed.frame.canary}`);
  console.error('the new endpoint presents both packages to its own daemon and its owner approves them —');
  console.error('the descriptor approval is the act of joining; the probe return-match is the proof.');
  console.error('this endpoint lists the member as PENDING until the proof is reported back over sync-registry.');
}

// Wrap-side revocation check (Closure 4, SPEC §4.5): a peer this
// endpoint holds a VERIFIED revocation for is not wrapped to — the
// daemon would refuse the registration anyway (register-revoked), and
// sealing new material to a revoked identity is exactly what the
// revocation exists to stop. Records that do not verify against a known
// key do not block (verifyRevocation's rule, same as enforcement).
function assertPeerNotRevoked(dir, peer, label) {
  const me = loadIdentity(dir);
  const book = loadAddressBook(dir);
  const resolve = (fp) => {
    if (me && fp === me.signFp) return me.sign_pub;
    for (const p of Object.values(book)) {
      if (fingerprintOfRaw(pubRawFromX(p.sign_pub)) === fp) return p.sign_pub;
    }
    return null;
  };
  const peerSignFp = fingerprintOfRaw(pubRawFromX(peer.sign_pub));
  const rec = revocationFor(loadRevocations(dir), peerSignFp, resolve);
  if (rec) {
    throw new Error(`wrap refused: "${label}" was revoked at ${rec.at} by ${rec.by_label || rec.by_sign_fp.slice(0, 16)}${rec.reason ? ` — "${rec.reason}"` : ''}. Nothing is sealed to a revoked identity.`);
  }
}

async function cmdWrap(flags, pos) {
  const [file] = pos;
  if (!file) throw new Error('usage: wrap <file> --to <label>');
  const { me, peer, dir } = loadSenderAndPeer(flags);
  assertPeerNotRevoked(dir, peer, flags.to);
  const transport = registrationTransport(flags, dir, peer);
  const policy = loadPolicy(dir);
  const abs = path.resolve(file);

  // --no-scan is a data-class escape only; code classes always scan.
  let prep = null;
  if (flags['no-scan']) {
    const head = fs.readFileSync(abs).subarray(0, 8192);
    const cls = classifyBuffer(head, abs);
    if (cls !== 'data') {
      throw new Error(`--no-scan refused: ${file} classifies as ${cls} — nothing wraps unscanned (use --override-scan for a recorded critical override)`);
    }
    prep = { action: 'proceed', cls, unscanned: true, record: null, digest: null, tier: null, params: null, reportSealed: null };
  } else {
    prep = await prepareScan(abs, {
      dir, policy, me, peer,
      overrideReason: typeof flags['override-scan'] === 'string' ? flags['override-scan'] : null,
      confirmState: { done: false, ok: false },
    });
  }

  const reportPath = `${file}.scan-report.scripture`;
  if (prep.action === 'refused') {
    // Refused scans are testimony too: the report is sealed + registered
    // (report-only) and written beside the target; NO target package is
    // written and NO target issuance exists.
    fs.writeFileSync(reportPath, prep.reportSealed.text, { mode: 0o644 });
    const res = await registerIssuances(dir, transport, [prep.reportSealed.frame], {
      [prep.reportSealed.frame.canary]: { reportFor: prep.record.target_sha256, reportOnly: true },
    });
    reportRegistration('scan-report', res);
    printFindings(prep.record, file);
    console.error(`wrap REFUSED: scan verdict critical — no package written. Report: ${reportPath} (digest ${prep.digest})`);
    process.exitCode = 1;
    return;
  }

  const expires = allocateExpiry(resolveExpires(flags.expires), prep.tier, prep.params, file);
  const plaintext = fs.readFileSync(abs);
  const scanBlock = frameScanBlock(prep);
  const { frame, text } = sealPlaintext(plaintext, me, peer, { expires, scan: scanBlock });
  const out = `${file}.scripture`;
  fs.writeFileSync(out, text, { mode: 0o644 });
  console.log(out);
  console.error(`canary:  ${frame.canary}`);
  console.error(`to:      ${flags.to} (seal fp ${frame.recipient_seal_fp.slice(0, 16)}…)`);
  console.error(`commit:  ${frame.commit}  (keyed — no offline oracle)`);
  if (prep.record) {
    console.error(`scan:    verdict ${prep.record.verdict} (tier ${prep.tier}, ${prep.cls} lane, digest ${(prep.digest || '').slice(0, 16)}…)`);
    printFindings(prep.record, file);
  }
  // Egress: the hash is generated as the information leaves — register
  // the report first (a daemon never holds a target whose report it
  // cannot match), then the target, with its tier snapshot.
  const frames = [];
  const extras = {};
  if (prep.reportSealed) {
    fs.writeFileSync(reportPath, prep.reportSealed.text, { mode: 0o644 });
    frames.push(prep.reportSealed.frame);
    extras[prep.reportSealed.frame.canary] = { reportFor: prep.record.target_sha256, reportOnly: true };
  }
  frames.push(frame);
  extras[frame.canary] = {
    tierParams: prep.params,
    // --for-activation seals the package INTO the activation store
    // (SPEC §2.3): it may be activated by this copy under Closure 2's
    // gates. Without it the package is egress — and egress packages
    // are refused activation outright.
    ...(flags['for-activation'] ? { origin: 'activation-store' } : {}),
  };
  const res = await registerIssuances(dir, transport, frames, extras);
  reportRegistration('wrap', res);
}

async function cmdRegister(flags, pos) {
  const dir = identityDir(flags);
  // With --to and no files: a pure outbox flush for that recipient —
  // the "endpoint came back" act that drains the offline queue over
  // whichever transport reaches its daemon (SPEC §4.7 case 4).
  if (!pos.length && !flags.to) {
    throw new Error('usage: register <file.scripture>… | register --to <label> (flush the outbox)');
  }
  let transport = registrationSocket(flags, dir);
  if (flags.to) {
    const { peer } = loadSenderAndPeer(flags);
    transport = registrationTransport(flags, dir, peer);
  }
  const frames = pos.map((f) => parseScriptureFile(fs.readFileSync(f, 'utf8')).frame);
  const res = await registerIssuances(dir, transport, frames);
  reportRegistration('register', res);
  if (res.queued) process.exitCode = 1;
  console.log(`registered ${res.synced}, queued ${res.queued}, refused ${(res.refused || []).length}`);
}

function cmdInspect(flags, pos) {
  const [file] = pos;
  if (!file) throw new Error('usage: inspect <file.scripture>');
  const { frame, body } = parseScriptureFile(fs.readFileSync(file, 'utf8'));
  const dir = identityDir(flags);
  const me = loadIdentity(dir);
  const book = loadAddressBook(dir);
  let senderLabel = null;
  for (const [label, peer] of Object.entries(book)) {
    if (fingerprintOfRaw(pubRawFromX(peer.sign_pub)) === frame.sender_sign_fp) senderLabel = label;
  }
  const sigOk = verifyFrameSignature(frame, body);
  if (!sigOk) {
    // inspect is the tool pointed at surfaced data — a package that does not
    // verify is a beacon event here too, same record shape as the daemon's.
    // Sight, not strike: the record is emitted and filed locally; nothing
    // calls out.
    const record = {
      event: 'beacon',
      canary: frame.canary ?? null,
      sha256: frame.sha256 ?? null,
      reason_class: 'signature-invalid',
      presented_path: path.resolve(file),
      surface: { daemon_label: me ? me.label : null, seal_fp: me ? me.sealFp : null, socket: null, via: 'inspect' },
      ts: new Date().toISOString(),
    };
    console.error(`BEACON ${JSON.stringify(record)}`);
    if (fs.existsSync(dir)) {
      try { fs.appendFileSync(path.join(dir, 'beacon.log'), JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
    }
  }
  console.log(`canary:        ${frame.canary}`);
  console.log(`created:       ${frame.created}`);
  console.log(`expiry:        ${frame.expiry ?? '(none)'}`);
  if (frame.commit != null) {
    console.log(`commit:        ${frame.commit}  (keyed commitment over the sealed plaintext — verifiable only with the package key; no offline oracle)`);
  } else {
    console.log(`sha256:        ${frame.sha256}  (of the sealed plaintext — LEGACY frame: a raw hash in the clear is an offline confirmation oracle for low-entropy content)`);
  }
  console.log(`sender:        sign fp ${frame.sender_sign_fp}${senderLabel ? `  (trusted as "${senderLabel}")` : '  (not in address book)'}`);
  console.log(`recipient:     seal fp ${frame.recipient_seal_fp}${me && me.sealFp === frame.recipient_seal_fp ? '  (THIS copy — the vault daemon here can open it, with owner approval)' : ''}`);
  console.log(`signature:     ${sigOk ? 'VALID' : 'INVALID'}`);
  if (!sigOk) console.log('beacon:        EMITTED (signature-invalid) — record on stderr and in beacon.log');
  console.log(`armor:         ${[...body.replace(/\n/g, '')].length} glyphs`);
  if (frame.v >= 2) {
    console.log(`format:        SCRIPTURE-ARMOR v2`);
    console.log(`scan:          verdict ${frame.scan_verdict ?? '(none recorded)'}${frame.scan_digest ? `  digest ${frame.scan_digest}` : ''}${frame.scan_report ? `  report canary ${frame.scan_report}` : ''}`);
    console.log(`armor tier:    ${frame.armor_tier ?? '(untiered)'}`);
    if (frame.scan_override) {
      console.log(`scan override: by ${frame.scan_override.by_sign_fp} — "${frame.scan_override.reason}" at ${frame.scan_override.at} (owner overrode a critical verdict; this rides in the signed frame forever)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Repo mode — wrap / unwrap / verify an entire tree.
//
// A repo wrap produces:
//   <out>/MANIFEST.scripture        the index package (the manifest, sealed)
//   <out>/files/<relpath>.partNNNN.scripture   one v1 package per chunk
//
// Files are read in fixed-size chunks (default 4 MiB). Peak memory is a few
// chunk-sized buffers plus one chunk's glyph text, no matter how large the
// file or the repo is — a 10 GB file wraps exactly like a 10 KB one, it just
// produces more parts. The manifest (path, size, SHA-256, mode per file;
// SHA-256 per part) is hashed whole-file incrementally as chunks stream by,
// then sealed as one ordinary package.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function toPosix(rel) { return rel.split(path.sep).join('/'); }

function scanTree(rootAbs, excludeAbs) {
  const files = [];
  const dirs = [];
  const skipped = [];
  const walk = (rel) => {
    const abs = rel ? path.join(rootAbs, rel) : rootAbs;
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const childAbs = path.join(rootAbs, childRel);
      if (excludeAbs && (childAbs === excludeAbs || childAbs.startsWith(excludeAbs + path.sep))) continue;
      if (ent.isSymbolicLink()) {
        skipped.push({ path: toPosix(childRel), reason: 'symlink (not followed)' });
      } else if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue; // excluded by rule, silently
        dirs.push(toPosix(childRel));
        walk(childRel);
      } else if (ent.isFile()) {
        files.push(toPosix(childRel));
      } else {
        skipped.push({ path: toPosix(childRel), reason: 'not a regular file' });
      }
    }
  };
  walk('');
  files.sort();
  dirs.sort();
  return { files, dirs, skipped };
}

function* readChunks(fd, chunkSize) {
  const buf = Buffer.alloc(chunkSize);
  let n;
  while ((n = fs.readSync(fd, buf, 0, chunkSize, null)) > 0) {
    yield Buffer.from(buf.subarray(0, n)); // copy: buf is reused
  }
}

function partName(index) {
  return `.part${String(index).padStart(4, '0')}.scripture`;
}

async function cmdWrapRepo(flags, pos) {
  const [srcArg] = pos;
  if (!srcArg) throw new Error('usage: wrap-repo <dir> --to <label> [--out <dir>]');
  const srcAbs = path.resolve(srcArg);
  if (!fs.statSync(srcAbs).isDirectory()) throw new Error(`${srcArg} is not a directory`);
  const { me, peer, dir } = loadSenderAndPeer(flags);
  assertPeerNotRevoked(dir, peer, flags.to);
  const transport = registrationTransport(flags, dir, peer);
  const chunkSize = flags['chunk-size'] ? Number(flags['chunk-size']) : DEFAULT_CHUNK_SIZE;
  if (!Number.isFinite(chunkSize) || chunkSize < 1024) throw new Error('bad --chunk-size');
  const expires = resolveExpires(flags.expires);
  const outAbs = flags.out ? path.resolve(flags.out) : `${srcAbs}.scripture-repo`;
  if (outAbs === srcAbs) throw new Error('--out must differ from the source dir');

  const policy = loadPolicy(dir);
  const tree = scanTree(srcAbs, outAbs);
  const { files, dirs } = tree;
  const skipped = [...tree.skipped];
  fs.mkdirSync(path.join(outAbs, 'files'), { recursive: true });

  // ---- SCAN PHASE (Closure 1): every file is classified + scanned
  // BEFORE anything is sealed. Critical verdicts refuse the whole repo
  // (policy scan.repo_critical: refuse-all) or just the file
  // (refuse-file → a named exclusion in the sealed manifest). Reports
  // are sealed here and written under <out>/reports/ in the wrap phase
  // (or, for a refused wrap, written + registered as testimony).
  const confirmState = { done: false, ok: false };
  const overrideReason = typeof flags['override-scan'] === 'string' ? flags['override-scan'] : null;
  const preps = new Map();
  const reportFrames = [];
  const reportExtras = {};
  const criticals = [];
  const noteReport = (prep, targetSha) => {
    if (prep.reportSealed) {
      reportFrames.push(prep.reportSealed.frame);
      reportExtras[prep.reportSealed.frame.canary] = { reportFor: targetSha, reportOnly: true };
    }
  };
  for (const rel of files) {
    const abs = path.join(srcAbs, rel);
    const st = fs.statSync(abs);
    if (st.size === 0) {
      preps.set(rel, { zeroByte: true, tier: 0, params: tierParams(0, policy), cls: 'data', record: null, digest: null, reportSealed: null });
      continue;
    }
    const prep = await prepareScan(abs, { dir, policy, me, peer, overrideReason, confirmState, promptOverride: true });
    noteReport(prep, prep.record.target_sha256);
    if (prep.action === 'refused') { criticals.push({ rel, prep }); continue; }
    preps.set(rel, prep);
  }
  const writeReports = () => {
    const byRel = new Map();
    for (const [rel, prep] of preps) if (prep.reportSealed) byRel.set(rel, prep.reportSealed);
    for (const c of criticals) if (c.prep.reportSealed) byRel.set(c.rel, c.prep.reportSealed);
    for (const [rel, sealed] of byRel) {
      const rp = path.join(outAbs, 'reports', `${rel}.scan-report.scripture`);
      fs.mkdirSync(path.dirname(rp), { recursive: true });
      fs.writeFileSync(rp, sealed.text, { mode: 0o644 });
    }
  };
  if (criticals.length && !overrideReason) {
    if (policy.scan.repo_critical !== 'refuse-file') {
      writeReports();
      const res0 = await registerIssuances(dir, transport, reportFrames, reportExtras);
      reportRegistration('scan-reports', res0);
      for (const c of criticals) printFindings(c.prep.record, c.rel);
      throw new Error(`wrap-repo refused: ${criticals.length} file(s) with critical scan verdicts (${criticals.map((c) => c.rel).join(', ')}) — policy scan.repo_critical=refuse-all; reports sealed + registered as testimony`);
    }
    for (const c of criticals) {
      const rules = [...new Set(c.prep.record.findings.filter((f) => f.severity === 'critical').map((f) => f.rule))].join(', ');
      skipped.push({ path: c.rel, reason: `scan-critical: ${rules}` });
      printFindings(c.prep.record, c.rel);
    }
  }

  const manifest = {
    format: 'scripture-armor-repo/2',
    created: new Date().toISOString(),
    chunkSize,
    sender_sign_fp: me.signFp,
    recipient_seal_fp: fingerprintOfRaw(pubRawFromX(peer.seal_pub)),
    expiry: expires ? new Date(expires).toISOString() : null,
    dirs,
    files: [],
    skipped,
    fileCount: 0,
    totalBytes: 0,
    partCount: 0,
    scan: { counts: { pass: 0, warn: 0, critical: 0, 'not-applicable': 0 }, tiers: { 0: 0, 1: 0, 2: 0 } },
  };

  const issuedFrames = [];
  const extrasByCanary = { ...reportExtras };
  for (const rel of files) {
    const prep = preps.get(rel);
    if (!prep) continue; // scan-critical exclusion (refuse-file) — named in skipped
    const abs = path.join(srcAbs, rel);
    const st = fs.statSync(abs);
    const fileExpires = prep.zeroByte ? expires : allocateExpiry(expires, prep.tier, prep.params, rel, { clamp: true });
    const scanBlock = prep.zeroByte
      ? { verdict: 'not-applicable', digest: null, reportCanary: null, override: null, tier: 0 }
      : frameScanBlock(prep);
    const wholeHash = crypto.createHash('sha256');
    const entry = {
      path: rel, size: st.size, sha256: null, mode: st.mode & 0o7777, parts: [],
      scan: prep.zeroByte ? {
        verdict: 'not-applicable', tier: 0, digest: null, report_canary: null,
        armor: { expiry: null, dual_approval: false, min_cell: 'policy-default', egress: 'any' },
      } : {
        verdict: prep.record.verdict, tier: prep.tier, digest: prep.digest,
        report_canary: prep.reportSealed ? prep.reportSealed.frame.canary : null,
        armor: {
          expiry: fileExpires, dual_approval: !!prep.params.dual_approval,
          min_cell: prep.params.min_cell, egress: prep.params.egress,
        },
      },
    };
    manifest.scan.counts[entry.scan.verdict] = (manifest.scan.counts[entry.scan.verdict] || 0) + 1;
    manifest.scan.tiers[entry.scan.tier] = (manifest.scan.tiers[entry.scan.tier] || 0) + 1;
    const fd = fs.openSync(abs, 'r');
    try {
      let idx = 0;
      for (const chunk of readChunks(fd, chunkSize)) {
        wholeHash.update(chunk);
        const { frame, text } = sealPlaintext(chunk, me, peer, { expires: fileExpires, scan: scanBlock });
        issuedFrames.push(frame);
        extrasByCanary[frame.canary] = { tierParams: prep.params, repo: null /* set after manifest seals */ };
        const pkgRel = `files/${rel}${partName(idx)}`;
        const pkgAbs = path.join(outAbs, pkgRel);
        fs.mkdirSync(path.dirname(pkgAbs), { recursive: true });
        fs.writeFileSync(pkgAbs, text, { mode: 0o644 });
        // The manifest's per-part sha256 is the PLAINTEXT chunk hash
        // (restore verifies opened chunks against it). On v3 frames it
        // can no longer be read off the frame (FIX 3) — compute it.
        entry.parts.push({ package: pkgRel, size: chunk.length, sha256: sha256Hex(chunk), canary: frame.canary });
        idx++;
      }
    } finally {
      fs.closeSync(fd);
    }
    entry.sha256 = wholeHash.digest('hex');
    manifest.files.push(entry);
    manifest.fileCount++;
    manifest.totalBytes += st.size;
    manifest.partCount += entry.parts.length;
  }

  // TOTAL COVERAGE (SPEC §1.7.5): every tree file is wrapped (rides in
  // manifest.files, zero-byte included) or excluded with a named reason
  // (manifest.skipped). No fourth state; divergence = no success.
  {
    const excludedScanCritical = skipped.filter((s) => String(s.reason).startsWith('scan-critical')).length;
    const accounted = manifest.fileCount + excludedScanCritical;
    if (accounted !== files.length) {
      throw new Error(`coverage accounting failed: ${accounted} accounted of ${files.length} tree files — refusing to report success`);
    }
  }
  writeReports();

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const sealedManifest = sealPlaintext(manifestBuf, me, peer, { expires });
  fs.writeFileSync(path.join(outAbs, 'MANIFEST.scripture'), sealedManifest.text, { mode: 0o644 });
  issuedFrames.push(sealedManifest.frame);
  // --for-activation: the MANIFEST carries the activation-store origin;
  // the repo then activates as one subject under Closure 2's gates
  // (every part must still carry its own tier — §1.7.5).
  if (flags['for-activation']) {
    extrasByCanary[sealedManifest.frame.canary] = { origin: 'activation-store' };
  }
  for (const f of issuedFrames) {
    if (extrasByCanary[f.canary] && extrasByCanary[f.canary].repo === null) {
      extrasByCanary[f.canary].repo = sealedManifest.frame.canary;
    }
  }

  // RESTORE-INFO.json — a cleartext, ADVISORY sidecar stating the restore
  // scale (file count, part count, total bytes). It exists so the scale can
  // be shown in the manifest's approval prompt before anything is opened.
  // It is not trusted: unwrap-repo cross-checks it against the sealed
  // manifest after the manifest is opened, and refuses on any divergence.
  const restoreInfo = {
    format: 'scripture-armor-restore-info/1',
    created: new Date().toISOString(),
    fileCount: manifest.fileCount,
    partCount: manifest.partCount,
    totalBytes: manifest.totalBytes,
  };
  fs.writeFileSync(path.join(outAbs, 'RESTORE-INFO.json'), JSON.stringify(restoreInfo, null, 2) + '\n', { mode: 0o644 });

  console.log(outAbs);
  console.error(`files:    ${manifest.fileCount} (${manifest.totalBytes} bytes) in ${manifest.partCount} packages`);
  console.error(`manifest: canary ${sealedManifest.frame.canary}`);
  console.error(`to:       ${flags.to} (seal fp ${manifest.recipient_seal_fp.slice(0, 16)}…)`);
  for (const s of skipped) console.error(`skipped:  ${s.path} — ${s.reason}`);

  // Egress: reports first, then every part and the manifest (a daemon
  // never holds a target whose report it cannot match).
  const res = await registerIssuances(dir, transport,
    [...reportFrames, ...issuedFrames], extrasByCanary);
  reportRegistration('wrap-repo', res);
}

// --- daemon client (unwrap-repo only; approval stays the owner's act) -----

function rpcOnce(socketPath, obj) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(obj) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) { conn.end(); resolve(JSON.parse(buf.slice(0, idx))); }
    });
    conn.on('error', reject);
  });
}

function rpcUnwrap(socketPath, pkgAbs, outName, context = null, purpose = null) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    const msgs = [];
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'unwrap', path: pkgAbs, out: outName, context, purpose }) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        msgs.push(msg);
        if (msg.state === 'pending-approval') {
          console.error(`pending approval: ${msg.canary} — owner runs: node vaultd.mjs approve --id ${msg.id}`);
        }
        if (msg.state === 'unwrapped' || msg.ok === false) { conn.end(); resolve(msgs); return; }
      }
    });
    conn.on('error', reject);
    conn.on('close', () => resolve(msgs));
  });
}

async function cmdUnwrapRepo(flags, pos) {
  const [wrappedArg] = pos;
  if (!wrappedArg || !flags.into) {
    throw new Error('usage: unwrap-repo <wrapped-dir> --into <dir> [--socket <path>] [--daemon-out-dir <dir>]');
  }
  const wrappedAbs = path.resolve(wrappedArg);
  const intoAbs = path.resolve(flags.into);
  const dir = identityDir(flags);
  const socketPath = flags.socket ? path.resolve(flags.socket) : path.join(dir, 'vaultd.sock');
  const daemonOut = flags['daemon-out-dir'] ? path.resolve(flags['daemon-out-dir']) : path.join(dir, 'out');

  // Full status (with fingerprints) is an owner-channel read (FIX 1);
  // unwrap-repo is the owner's own tool, run from the identity store.
  const status = await ownerRpc(socketPath, { cmd: 'status' }).catch((e) => {
    throw new Error(`cannot reach vaultd at ${socketPath} (${e.message}) — start it: node vaultd.mjs serve`);
  });
  if (!status.ok) throw new Error(`vaultd status not ok: ${JSON.stringify(status)}`);
  console.error(`vaultd: ${status.label}  seal fp ${String(status.seal_fp).slice(0, 16)}…`);

  const unwrapOne = async (pkgAbs, outName, context = null) => {
    const msgs = await rpcUnwrap(socketPath, pkgAbs, outName, context);
    const last = msgs[msgs.length - 1];
    if (!last || last.state !== 'unwrapped') {
      throw new Error(`daemon did not unwrap ${path.basename(pkgAbs)}: ${last ? last.error || JSON.stringify(last) : 'no response'}`);
    }
    const staged = path.join(daemonOut, outName);
    const data = fs.readFileSync(staged);
    fs.unlinkSync(staged);
    return data;
  };

  // Restore scale, declared by the wrapped tree's cleartext sidecar
  // (advisory only — the sealed manifest is cross-checked against it below,
  // before anything is written). Trees wrapped before RESTORE-INFO existed
  // declare nothing; their counts are still validated against themselves.
  let restoreInfo = null;
  try {
    const ri = JSON.parse(fs.readFileSync(path.join(wrappedAbs, 'RESTORE-INFO.json'), 'utf8'));
    if (ri && ri.format === 'scripture-armor-restore-info/1') restoreInfo = ri;
  } catch {}
  const manifestContext = restoreInfo
    ? `repo-manifest restore: ${restoreInfo.fileCount} files, ${restoreInfo.totalBytes} bytes, ` +
      `${restoreInfo.partCount} packages (declared by RESTORE-INFO.json; verified against the sealed manifest once opened)`
    : 'repo-manifest restore: scale not declared by this tree (no RESTORE-INFO.json); ' +
      'counts verified against the sealed manifest once opened';

  // 1) the manifest — the index package — through the daemon like everything else
  const manifestPkg = path.join(wrappedAbs, 'MANIFEST.scripture');
  if (!fs.existsSync(manifestPkg)) throw new Error(`no MANIFEST.scripture in ${wrappedArg}`);
  const manifestBuf = await unwrapOne(manifestPkg, 'repo-manifest.json', manifestContext);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (manifest.format !== 'scripture-armor-repo/1' && manifest.format !== 'scripture-armor-repo/2') {
    throw new Error('unrecognized manifest format');
  }
  if (manifest.recipient_seal_fp !== status.seal_fp) {
    throw new Error('manifest was sealed to a different copy than this daemon');
  }
  console.error(`manifest: ${manifest.fileCount} files, ${manifest.partCount} packages, created ${manifest.created}`);

  // 1b) validate the manifest against itself and against the declared
  // scale BEFORE anything is created on disk. A manifest whose declared
  // counts disagree with its own entries — or with the scale the owner
  // saw in the approval prompt — restores nothing.
  const actualParts = manifest.files.reduce((n, f) => n + (f.parts ? f.parts.length : 0), 0);
  const actualBytes = manifest.files.reduce((n, f) => n + (f.size || 0), 0);
  if (manifest.fileCount !== manifest.files.length || manifest.partCount !== actualParts ||
      manifest.totalBytes !== actualBytes) {
    throw new Error(
      `manifest count mismatch: declares ${manifest.fileCount} files / ${manifest.partCount} parts / ` +
      `${manifest.totalBytes} bytes, contains ${manifest.files.length} files / ${actualParts} parts / ${actualBytes} bytes`);
  }
  if (restoreInfo && (restoreInfo.fileCount !== manifest.fileCount ||
      restoreInfo.partCount !== manifest.partCount || restoreInfo.totalBytes !== manifest.totalBytes)) {
    throw new Error(
      `restore scale mismatch: approval prompt declared ${restoreInfo.fileCount} files / ${restoreInfo.totalBytes} bytes, ` +
      `sealed manifest declares ${manifest.fileCount} files / ${manifest.totalBytes} bytes — refusing`);
  }

  // Symlink guard: no component of any path we create or write through may
  // be a symlink. lstat every existing component from the restore root
  // down; a symlinked component means the write would escape the target.
  const assertNoSymlinks = (relPosix) => {
    const segs = relPosix ? relPosix.split('/').filter(Boolean) : [];
    let cur = intoAbs;
    const probe = (p, label) => {
      let st;
      try { st = fs.lstatSync(p); } catch { return false; } // absent — nothing below it can exist yet
      if (st.isSymbolicLink()) throw new Error(`restore path crosses a symlink at ${label} — refusing`);
      return true;
    };
    if (!probe(cur, '(restore root)')) return;
    for (let i = 0; i < segs.length; i++) {
      cur = path.join(cur, segs[i]);
      if (!probe(cur, segs.slice(0, i + 1).join('/'))) break;
    }
  };
  {
    let rootStat = null;
    try { rootStat = fs.lstatSync(intoAbs); } catch {}
    if (rootStat && rootStat.isSymbolicLink()) {
      throw new Error('restore target itself is a symlink — refusing');
    }
  }

  // 2) every file, part by part, hash-checked against the manifest
  fs.mkdirSync(intoAbs, { recursive: true });
  for (const d of manifest.dirs || []) {
    const rel = d.split('/');
    if (rel.includes('..')) throw new Error(`manifest dir escapes target: ${d}`);
    assertNoSymlinks(d);
    fs.mkdirSync(path.join(intoAbs, d), { recursive: true });
  }
  let restored = 0;
  for (const entry of manifest.files) {
    const segs = entry.path.split('/');
    if (segs.includes('..') || path.isAbsolute(entry.path)) {
      throw new Error(`manifest path escapes target: ${entry.path}`);
    }
    assertNoSymlinks(entry.path);
    const dest = path.join(intoAbs, entry.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    assertNoSymlinks(entry.path); // re-check after creating parents
    // Every part must resolve inside the wrapped tree — checked for the
    // whole file before the destination is opened, so a refusal here
    // leaves nothing behind.
    for (const part of entry.parts) {
      const pkgAbs = path.resolve(wrappedAbs, part.package);
      if (!(pkgAbs === wrappedAbs || pkgAbs.startsWith(wrappedAbs + path.sep))) {
        throw new Error(`manifest part escapes the wrapped tree: ${part.package}`);
      }
    }
    const wholeHash = crypto.createHash('sha256');
    const fd = fs.openSync(dest, 'w');
    try {
      let pIdx = 0;
      for (const part of entry.parts) {
        const pkgAbs = path.join(wrappedAbs, part.package);
        if (!fs.existsSync(pkgAbs)) throw new Error(`missing package ${part.package}`);
        const data = await unwrapOne(pkgAbs, `part-${entry.path.replace(/[^A-Za-z0-9._-]/g, '_')}-${pIdx}.bin`);
        if (sha256Hex(data) !== part.sha256) {
          throw new Error(`part hash mismatch: ${entry.path} part ${pIdx} (manifest ${part.sha256}, got ${sha256Hex(data)})`);
        }
        wholeHash.update(data);
        fs.writeSync(fd, data);
        pIdx++;
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = wholeHash.digest('hex');
    if (digest !== entry.sha256) {
      throw new Error(`file hash mismatch: ${entry.path} (manifest ${entry.sha256}, got ${digest})`);
    }
    // Manifest modes are masked to 0o777 on restore: setuid/setgid/sticky
    // bits recorded in a manifest are never applied to restored files.
    if (entry.mode != null) { try { fs.chmodSync(dest, entry.mode & 0o777); } catch {} }
    restored++;
    console.error(`restored: ${entry.path} (${entry.size} bytes, ${entry.parts.length} parts)`);
  }
  console.log(intoAbs);
  console.error(`done: ${restored}/${manifest.fileCount} files restored byte-for-byte under ${intoAbs}`);
}

// --- reseal (SPEC §1.7.3): re-armor a part in place ----------------------
// Opens the current package through the normal governed path (daemon
// unwrap with purpose 'reseal' — the one path allowed past a Tier-2
// re-seal deadline), re-scans the identical plaintext, seals it fresh
// (new canary, new armor seed, new key, new expiry per tier), registers
// the new issuance, and asks the daemon to mark the old entry
// superseded_by the new canary. The old package file stays where it
// lies: presented anywhere in the loop it now beacon-refuses as
// `superseded`, naming both canaries.

async function cmdReseal(flags, pos) {
  const [pkg] = pos;
  if (!pkg) throw new Error('usage: reseal <file.scripture> [--socket <path>] [--daemon-out-dir <dir>] [--out <new-package>]');
  const dir = identityDir(flags);
  const me = loadIdentity(dir);
  if (!me) throw new Error('no identity in this copy — run `identity` first');
  const pkgAbs = path.resolve(pkg);
  const { frame: oldFrame } = parseScriptureFile(fs.readFileSync(pkgAbs, 'utf8'));
  const socketPath = registrationSocket(flags, dir);
  const socketDir = path.dirname(socketPath);
  const daemonOut = flags['daemon-out-dir'] ? path.resolve(flags['daemon-out-dir']) : path.join(socketDir, 'out');

  const status = await ownerRpc(socketPath, { cmd: 'status' }).catch((e) => {
    throw new Error(`cannot reach vaultd at ${socketPath} (${e.message})`);
  });
  if (!status.ok) throw new Error(`vaultd status not ok: ${JSON.stringify(status)}`);
  if (oldFrame.recipient_seal_fp !== status.seal_fp) {
    throw new Error('package is sealed to a different copy than this daemon');
  }
  // Resolve the recipient as a peer of THIS store (or self).
  let peer = null;
  if (oldFrame.recipient_seal_fp === me.sealFp) {
    peer = { seal_pub: me.seal_pub, sign_pub: me.sign_pub };
  } else {
    const book = loadAddressBook(dir);
    for (const p of Object.values(book)) {
      if (fingerprintOfRaw(pubRawFromX(p.seal_pub)) === oldFrame.recipient_seal_fp) { peer = p; break; }
    }
  }
  if (!peer) throw new Error('recipient not in this store\'s address book — cannot re-seal to it from here');

  const outName = `reseal-${oldFrame.canary.slice(0, 8)}.bin`;
  const msgs = await rpcUnwrap(socketPath, pkgAbs, outName, 're-seal (maintenance)', 'reseal');
  const last = msgs[msgs.length - 1];
  if (!last || last.state !== 'unwrapped') {
    throw new Error(`daemon did not release the package for re-seal: ${last ? last.error || JSON.stringify(last) : 'no response'} (owner approval — dual for Tier 2 — happens at the daemon)`);
  }
  const staged = path.join(daemonOut, outName);
  const plaintext = fs.readFileSync(staged);
  // Integrity of the daemon-released bytes against the issued frame:
  // legacy frames carry the plaintext hash, recomputed here directly;
  // v3 frames carry the keyed commitment, whose key only the RECIPIENT
  // side can unseal — the daemon verified it at open (that verification
  // is what released the bytes at all) and attests it on the stream.
  // The resealer asserts the attestation rather than recomputing a key
  // it cannot hold (FIX 3 — the check survives, the oracle does not).
  const integrityOk = oldFrame.commit != null
    ? last.digest_verified === true
    : sha256Hex(plaintext) === oldFrame.sha256;
  if (!integrityOk) {
    try { fs.unlinkSync(staged); } catch {}
    throw new Error('re-seal aborted: opened plaintext does not match the issued digest');
  }
  // Scan the identical bytes afresh (verdicts are hash-bound; the new
  // issuance carries its own fresh report + digest).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripture-reseal-'));
  const tmpFile = path.join(tmpDir, 'payload.bin');
  let prep;
  try {
    fs.writeFileSync(tmpFile, plaintext);
    const policy = loadPolicy(dir);
    // Override continuity: the plaintext is verified byte-identical to
    // the issued hash above, so if the owner already adjudicated THIS
    // content (critical verdict + signed override in the old frame),
    // that adjudication carries into the re-seal and the new frame's
    // override cites it. If the content was never overridden and a
    // fresh scan NOW returns critical (verdict escalation under newer
    // rules), the re-seal refuses — that is new information and needs
    // a fresh owner decision.
    const continuity = (oldFrame.scan_verdict === 'critical' && oldFrame.scan_override)
      ? `re-seal continuity — original override by ${oldFrame.scan_override.by_sign_fp} at ${oldFrame.scan_override.at}: "${oldFrame.scan_override.reason}"`
      : null;
    prep = await prepareScan(tmpFile, {
      dir, policy, me, peer,
      overrideReason: continuity, confirmState: { done: true, ok: !!continuity },
    });
    if (prep.action === 'refused') {
      throw new Error('re-seal refused: a FRESH scan of the identical bytes now returns critical and the original issuance carried no override — the old package stands; the owner must adjudicate (wrap the content anew with --override-scan if they choose)');
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  const expires = allocateExpiry(null, prep.tier, prep.params, 'reseal');
  const scanBlock = frameScanBlock(prep);
  const { frame, text } = sealPlaintext(plaintext, me, peer, { expires, scan: scanBlock });
  const outPath = flags.out ? path.resolve(flags.out) : `${pkgAbs}.resealed.scripture`;
  fs.writeFileSync(outPath, text, { mode: 0o644 });
  if (prep.reportSealed) {
    fs.writeFileSync(`${outPath}.scan-report.scripture`, prep.reportSealed.text, { mode: 0o644 });
  }
  const frames = [];
  const extras = {};
  if (prep.reportSealed) {
    frames.push(prep.reportSealed.frame);
    extras[prep.reportSealed.frame.canary] = { reportFor: prep.record.target_sha256, reportOnly: true };
  }
  frames.push(frame);
  extras[frame.canary] = { tierParams: prep.params };
  const res = await registerIssuances(dir, socketPath, frames, extras);
  reportRegistration('reseal', res);
  const sup = await ownerRpc(socketPath, { cmd: 'supersede', old_canary: oldFrame.canary, new_canary: frame.canary, reseal_token: last.reseal_token || null });
  if (!sup.ok) throw new Error(`daemon refused the supersede marking: ${sup.error || JSON.stringify(sup)}`);
  try { fs.unlinkSync(staged); } catch {} // the staged plaintext has been re-sealed; it does not linger
  console.log(outPath);
  console.error(`resealed: ${oldFrame.canary} → ${frame.canary} (tier ${prep.tier}); the old package now beacon-refuses as superseded`);
}

// --- verify: signatures + structure, no unwrap -----------------------------

function cmdVerify(flags, pos) {
  const [wrappedArg] = pos;
  if (!wrappedArg) throw new Error('usage: verify <wrapped-dir>');
  const wrappedAbs = path.resolve(wrappedArg);
  let failures = 0;
  const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`); };

  const manifestPkg = path.join(wrappedAbs, 'MANIFEST.scripture');
  let manifestFrame = null;
  if (!fs.existsSync(manifestPkg)) {
    fail('MANIFEST.scripture missing');
  } else {
    try {
      const { frame, body } = parseScriptureFile(fs.readFileSync(manifestPkg, 'utf8'));
      manifestFrame = frame;
      if (verifyFrameSignature(frame, body)) {
        console.log(`OK    MANIFEST.scripture  signature VALID  canary ${frame.canary}  manifest digest ${frameDigest(frame)}`);
      } else {
        fail('MANIFEST.scripture  signature INVALID');
      }
    } catch (err) {
      fail(`MANIFEST.scripture  unparseable: ${err.message}`);
    }
  }

  const filesRoot = path.join(wrappedAbs, 'files');
  const groups = new Map(); // relpath -> [{idx, frame, ok, file}]
  if (!fs.existsSync(filesRoot)) {
    fail('files/ directory missing');
  } else {
    const walkPkgs = (rel) => {
      const abs = rel ? path.join(filesRoot, rel) : filesRoot;
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const childRel = rel ? path.join(rel, ent.name) : ent.name;
        if (ent.isDirectory()) walkPkgs(childRel);
        else if (ent.isFile() && ent.name.endsWith('.scripture')) {
          const posixRel = toPosix(childRel);
          const m = posixRel.match(/^(.*)\.part(\d{4})\.scripture$/);
          const base = m ? m[1] : posixRel.replace(/\.scripture$/, '');
          const idx = m ? Number(m[2]) : 0;
          if (!groups.has(base)) groups.set(base, []);
          groups.get(base).push({ idx, rel: posixRel });
        }
      }
    };
    walkPkgs('');
  }

  let okFiles = 0;
  for (const base of [...groups.keys()].sort()) {
    const parts = groups.get(base).sort((a, b) => a.idx - b.idx);
    const problems = [];
    parts.forEach((p, i) => { if (p.idx !== i) problems.push(`part index gap at ${p.idx}`); });
    for (const p of parts) {
      try {
        const { frame, body } = parseScriptureFile(fs.readFileSync(path.join(filesRoot, p.rel), 'utf8'));
        if (!verifyFrameSignature(frame, body)) problems.push(`${p.rel}: signature INVALID`);
        if (manifestFrame) {
          if (frame.sender_sign_fp !== manifestFrame.sender_sign_fp) problems.push(`${p.rel}: sender differs from manifest`);
          if (frame.recipient_seal_fp !== manifestFrame.recipient_seal_fp) problems.push(`${p.rel}: recipient differs from manifest`);
          if (frame.expiry && Date.parse(frame.expiry) < Date.now()) problems.push(`${p.rel}: expired ${frame.expiry}`);
        }
      } catch (err) {
        problems.push(`${p.rel}: unparseable: ${err.message}`);
      }
    }
    if (problems.length) {
      for (const pr of problems) fail(`${base}  ${pr}`);
    } else {
      okFiles++;
      console.log(`OK    ${base}  (${parts.length} part${parts.length === 1 ? '' : 's'}, signatures VALID)`);
    }
  }

  // note: zero-byte files have no packages by design; they exist only in the
  // sealed manifest and are recreated at unwrap. verify cannot see them.

  // TOTAL-COVERAGE mirror check (SPEC §1.7.5): with the recipient's
  // identity (--identity-dir), verify opens the sealed manifest locally
  // and reconciles the on-disk packages against the manifest's own
  // reference list. A package the manifest does not reference is
  // UNACCOUNTED — residue, detectable from the armored side too.
  // Without the identity, verify stays signature-only and says so.
  if (flags['identity-dir']) {
    try {
      const me = loadIdentity(identityDir(flags));
      if (!me) throw new Error('no identity in --identity-dir');
      const mpkg = parseScriptureFile(fs.readFileSync(manifestPkg, 'utf8'));
      if (mpkg.frame.recipient_seal_fp !== me.sealFp) throw new Error('manifest is sealed to a different copy');
      const key = unsealFileKey(me.sealPriv, mpkg.frame);
      const manifest = JSON.parse(openSealedFile(key, mpkg.frame, armorDecode(mpkg.body, Buffer.from(mpkg.frame.armor_seed, 'base64'))).toString('utf8'));
      const referenced = new Set();
      for (const f of manifest.files || []) for (const p of f.parts || []) referenced.add(p.package);
      const onDisk = new Set();
      for (const [base, parts] of groups) for (const p of parts) onDisk.add(`files/${p.rel}`);
      for (const rel of onDisk) {
        if (!referenced.has(rel)) fail(`unaccounted package: ${rel} is present in the wrapped tree but not referenced by the sealed manifest`);
      }
      for (const rel of referenced) {
        if (!onDisk.has(rel)) fail(`missing package: ${rel} is referenced by the sealed manifest but absent from the wrapped tree`);
      }
      if (manifest.format === 'scripture-armor-repo/2' && manifest.scan) {
        console.log(`scan:   verdicts ${JSON.stringify(manifest.scan.counts)}  tiers ${JSON.stringify(manifest.scan.tiers)} (from the sealed manifest)`);
        for (const f of manifest.files || []) {
          if (f.scan && f.scan.tier != null && f.scan.tier >= 2) {
            console.log(`tier-2: ${f.path} (verdict ${f.scan.verdict}, expiry ${f.scan.armor?.expiry || 'none'})`);
          }
        }
      }
    } catch (err) {
      fail(`coverage accounting unavailable: ${err.message}`);
    }
  } else {
    console.log('note:   coverage accounting skipped (pass --identity-dir <recipient store> to reconcile packages against the sealed manifest)');
  }
  console.log(`verify: ${okFiles} file(s) OK, ${failures} failure(s)`);
  if (failures) process.exitCode = 1;
}

// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  const done = (p) => Promise.resolve(p).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
  try {
    if (cmd === 'identity') cmdIdentity(flags);
    else if (cmd === 'trust') cmdTrust(flags, pos);
    else if (cmd === 'untrust') cmdUntrust(flags, pos);
    else if (cmd === 'enroll') done(cmdEnroll(flags, pos));
    else if (cmd === 'wrap') done(cmdWrap(flags, pos));
    else if (cmd === 'register') done(cmdRegister(flags, pos));
    else if (cmd === 'inspect') cmdInspect(flags, pos);
    else if (cmd === 'wrap-repo') done(cmdWrapRepo(flags, pos));
    else if (cmd === 'unwrap-repo') done(cmdUnwrapRepo(flags, pos));
    else if (cmd === 'verify') cmdVerify(flags, pos);
    else if (cmd === 'reseal') done(cmdReseal(flags, pos));
    else {
      console.error('usage: armor.mjs <identity|trust|untrust|enroll|wrap|register|inspect|wrap-repo|unwrap-repo|verify|reseal> …');
      process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
