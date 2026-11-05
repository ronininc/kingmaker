// Scripture Armor v4 — post-quantum closure battery.
// Proves: hybrid X25519+ML-KEM-768 seal, dual Ed25519+ML-DSA-65 frame
// signature, identity auto-migration, downgrade refusal, and that legacy
// v3 packages (classical seal, single signature) still open — sealed
// honestly under their own format, readable forever, never upgraded by
// stealth and never confused with v4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createIdentity, loadIdentity, publicBlock, parsePublicBlock,
  sealPlaintext, parseScriptureFile, verifyFrameSignature, unsealFileKey,
  openSealedFile, commitFor, armorEncode, armorDecode, frameSignData,
} from '../armor.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v4pq-'));
const dirA = path.join(tmp, 'A'), dirB = path.join(tmp, 'B');

// --- identities carry PQ material -------------------------------------------
const A = createIdentity(dirA, 'A');
const B = createIdentity(dirB, 'B');
check('identity carries ML-KEM-768 + ML-DSA-65 keypairs', !!(A.kemPub && A.mldsaPub && A.kemPriv && A.mldsaPriv));
check('PQ fingerprints are 64-hex sha256', /^[0-9a-f]{64}$/.test(A.kemFp) && /^[0-9a-f]{64}$/.test(A.mldsaFp));

// --- public block round-trip -------------------------------------------------
const peerB = parsePublicBlock(publicBlock(B));
check('public block carries kem_pub + mldsa_pub', !!peerB.kem_pub && !!peerB.mldsa_pub);
check('garbage PQ material in a public block is refused', throws(() =>
  parsePublicBlock(Buffer.from(JSON.stringify({ v: 1, seal_pub: B.seal_pub, sign_pub: B.sign_pub, kem_pub: Buffer.alloc(10).toString('base64') })).toString('base64'))));

// --- v4 round-trip -------------------------------------------------------------
const plain = Buffer.from('post-quantum sealed bytes — the door no one can find\n', 'utf8');
const { frame, text } = sealPlaintext(plain, A, peerB);
check('package header is SCRIPTURE-ARMOR v4', text.startsWith('SCRIPTURE-ARMOR v4\n'));
check('frame v=4 with kem block + mldsa identity inside the signed fields',
  frame.v === 4 && frame.kem_alg === 'ML-KEM-768' && !!frame.kem_ct && !!frame.sender_mldsa_pub && !!frame.sig_pq);
check('kem_ct is a real ML-KEM-768 ciphertext (1088 bytes)', Buffer.from(frame.kem_ct, 'base64').length === 1088);
const parsed = parseScriptureFile(text);
check('dual signature verifies (Ed25519 + ML-DSA-65)', verifyFrameSignature(parsed.frame, parsed.body));
const fk = unsealFileKey(B, parsed.frame);
check('hybrid unseal recovers the file key; plaintext round-trips byte-for-byte',
  openSealedFile(fk, parsed.frame, armorDecode(parsed.body, Buffer.from(parsed.frame.armor_seed, 'base64'))).equals(plain));
check('commitment verifies against the recovered key', commitFor(fk, plain) === parsed.frame.commit);

// --- attacks -------------------------------------------------------------------
const tamperKem = JSON.parse(JSON.stringify(parsed.frame));
{ const b = Buffer.from(tamperKem.kem_ct, 'base64'); b[100] ^= 1; tamperKem.kem_ct = b.toString('base64'); }
check('tampered ML-KEM ciphertext: signature refuses it', !verifyFrameSignature(tamperKem, parsed.body));
check('tampered ML-KEM ciphertext: unseal fails even ignoring the signature', throws(() => unsealFileKey(B, tamperKem)));

const stripped = JSON.parse(JSON.stringify(parsed.frame));
delete stripped.kem_ct; delete stripped.kem_alg;
check('stripped KEM block: unseal refuses as a downgrade', throws(() => unsealFileKey(B, stripped)),
  (() => { try { unsealFileKey(B, stripped); return ''; } catch (e) { return e.message; } })());

const stripSig = JSON.parse(JSON.stringify(parsed.frame));
delete stripSig.sig_pq;
check('stripped ML-DSA signature: frame does not verify', !verifyFrameSignature(stripSig, parsed.body));

const wrong = createIdentity(path.join(tmp, 'C'), 'C');
check('wrong identity cannot unseal (hybrid key does not reconstruct)', throws(() => unsealFileKey(wrong, parsed.frame)));
check('bare X25519 key cannot open a v4 package', throws(() => unsealFileKey(B.sealPriv, parsed.frame)));

// --- classical-only peer is refused at seal time --------------------------------
const legacyPeer = { seal_pub: B.seal_pub, sign_pub: B.sign_pub };
check('sealing to a pre-v4 (classical-only) peer is refused, never silently downgraded',
  throws(() => sealPlaintext(plain, A, legacyPeer)));

// --- legacy v3 package still opens ----------------------------------------------
{
  // Build a genuine v3-format package by hand (classical seal, commit,
  // single Ed25519 signature) exactly as the v3 code produced it.
  const fileKey = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', fileKey, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const payload = Buffer.concat([ct, cipher.getAuthTag()]);
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPubRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: B.sealPub });
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', shared, ephPubRaw, Buffer.from('scripture-wrap/file-key/v1'), 32));
  const kn = crypto.randomBytes(12);
  const kc = crypto.createCipheriv('chacha20-poly1305', wrapKey, kn, { authTagLength: 16 });
  const keyCt = Buffer.concat([kc.update(fileKey), kc.final(), kc.getAuthTag()]);
  const seed = crypto.randomBytes(16);
  const f3 = {
    v: 3, canary: crypto.randomUUID(), created: new Date().toISOString(), expiry: null,
    commit: commitFor(fileKey, plain),
    sender_sign_fp: A.signFp, sender_sign_pub: A.sign_pub, recipient_seal_fp: B.sealFp,
    armor_seed: seed.toString('base64'), eph_pub: ephPubRaw.toString('base64url'),
    key_nonce: kn.toString('base64'), key_ct: keyCt.toString('base64'),
    file_nonce: nonce.toString('base64'),
    scan_verdict: null, scan_digest: null, scan_report: null, scan_override: null, armor_tier: null,
  };
  const body3 = armorEncode(payload, seed);
  f3.sig = crypto.sign(null, frameSignData(f3, body3), A.signPriv).toString('base64');
  const text3 = `SCRIPTURE-ARMOR v3\n${JSON.stringify(f3)}\n${body3}\n`;
  const p3 = parseScriptureFile(text3);
  check('legacy v3 frame signature verifies', verifyFrameSignature(p3.frame, p3.body));
  const fk3 = unsealFileKey(B.sealPriv, p3.frame); // bare-key legacy path
  const opened = openSealedFile(fk3, p3.frame, armorDecode(p3.body, seed));
  check('legacy v3 package still opens byte-for-byte', opened.equals(plain));
}

// --- identity migration -----------------------------------------------------------
{
  const dirL = path.join(tmp, 'L');
  fs.mkdirSync(dirL, { recursive: true });
  const seal = crypto.generateKeyPairSync('x25519');
  const sign = crypto.generateKeyPairSync('ed25519');
  const legacy = {
    v: 1, label: 'legacy', created: new Date().toISOString(),
    seal_pub: seal.publicKey.export({ format: 'jwk' }).x,
    seal_priv: seal.privateKey.export({ format: 'jwk' }).d,
    sign_pub: sign.publicKey.export({ format: 'jwk' }).x,
    sign_priv: sign.privateKey.export({ format: 'jwk' }).d,
  };
  fs.writeFileSync(path.join(dirL, 'identity.json'), JSON.stringify(legacy, null, 2), { mode: 0o600 });
  const migrated = loadIdentity(dirL);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dirL, 'identity.json'), 'utf8'));
  check('pre-v4 identity auto-migrates: PQ keys added in place', !!onDisk.kem_pub && !!onDisk.mldsa_pub);
  check('migration preserves the seal fingerprint (trust + registry untouched)', migrated.sealFp ===
    crypto.createHash('sha256').update(Buffer.from(legacy.seal_pub, 'base64url')).digest('hex'));
  const peerM = parsePublicBlock(publicBlock(migrated));
  const pkg = sealPlaintext(plain, A, peerM);
  const pp = parseScriptureFile(pkg.text);
  check('migrated identity opens v4 packages', openSealedFile(unsealFileKey(migrated, pp.frame), pp.frame,
    armorDecode(pp.body, Buffer.from(pp.frame.armor_seed, 'base64'))).equals(plain));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('ALL V4 PQ TESTS PASSED');
