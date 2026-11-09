// lib/release-manifest-seal.mjs — THE ARMOR WRAP FOR THE RELEASE MANIFEST (Kingmaker code).
//
// The release manifest (kingmaker-manifest.json) is the trust root of the whole install chain:
// it pins the sha256 of every payload part, of the app archive, and of the Ronin Launcher zip
// the installer carries. Until now it travelled as plaintext, guarded by transport TLS, its
// GitHub sha256, and — when the operator signs — an RSA-PSS .sig. Robbie's armor-everything
// ruling (2026-10-28 23:53 MST: "everything i do no matter how small should be under the
// protection of script armor now") closes the gap: when the operator supplies his release
// armor signer, the bake ADDITIONALLY emits the same manifest inside a Scripture Armor v4
// envelope — AEAD-sealed, dual-signed (Ed25519 + ML-DSA-65), commitment-bound, canary-carrying:
//
//   kingmaker-manifest.json.scripture   the manifest, sealed by the signer to a per-bake
//                                       manifest recipient identity
//   kingmaker-manifest.key.scripture    that recipient's identity document, sealed by the
//                                       signer to a per-bake escrow identity (the bootstrap)
//   kingmaker-manifest-pin.json         { schema, signerSignFp, escrowIdentity } — the pin
//
// This is the F-03 sealed armor bundle's custody pattern (lib/armor-bundle.mjs /
// lib/armor-bundle-build.mjs) carried to the manifest: per-bake recipient + escrow identities
// minted in a scratch dir that never leaves the bake, the escrow identity shipped in the pin,
// the recipient recovered from the escrow package at open time, and the plaintext manifest
// existing in memory only. The one difference is the signer: the bundle's signer is per-bake,
// the manifest's signer is the OPERATOR'S release armor identity, loaded from the identity
// store he points the bake at — this module never mints a release signer, and without one it
// refuses to seal at all. (Tests mint fixture signers in scratch; that is the fixture path,
// not a release path.)
//
// The seal/open below call lib/armor-bundle.mjs's package functions — the public, frozen
// Scripture Armor package format implemented with Node's standard library. No cryptography is
// implemented here; this module is custody and file layout only.
//
// FAIL CLOSED: sealReleaseManifest verifies its own work before returning — the sealed set is
// opened back through the escrow bootstrap and byte-compared with the manifest that went in.
// A set that does not round-trip is never handed to a release.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBundleIdentity,
  loadBundleIdentity,
  openBundlePackage,
  sealBundlePackage,
} from './armor-bundle.mjs';

/**
 * Rebuild a loaded identity from its document using only the loader's public surface:
 * the document is staged as a store in scratch and loadBundleIdentity verifies its
 * store-integrity tag before use — the same check a device store gets. (armor-bundle.mjs's
 * internal identityFromDoc is not exported; F-03's loader uses it because it IS that file.)
 */
function identityFromStoredDoc(doc, scratchRoot) {
  const dir = mkdtempSync(join(scratchRoot, 'km-seal-id-'));
  try {
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(doc), { mode: 0o600 });
    const identity = loadBundleIdentity(dir);
    if (!identity) throw new Error('release-manifest-seal: an identity document did not load');
    return identity;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const SEALED_MANIFEST_FILE = 'kingmaker-manifest.json.scripture';
export const MANIFEST_ESCROW_FILE = 'kingmaker-manifest.key.scripture';
export const MANIFEST_PIN_FILE = 'kingmaker-manifest-pin.json';
export const MANIFEST_PIN_SCHEMA = 'kingmaker.release-manifest-pin/1';
export const SEALED_MANIFEST_ASSETS = Object.freeze([SEALED_MANIFEST_FILE, MANIFEST_ESCROW_FILE, MANIFEST_PIN_FILE]);

/**
 * Seal one manifest text. `signerIdentity` is a loaded bundle identity (see
 * loadBundleIdentity) — for a release, the operator's own, loaded from his store; the
 * recipient and escrow identities are minted per bake in scratch and destroyed with it.
 * Returns { sealedText, escrowText, pin, pinText, signerSignFp, canary }.
 */
export function sealReleaseManifest(manifestText, { signerIdentity, scratchRoot = tmpdir() } = {}) {
  if (!signerIdentity?.signFp || !signerIdentity?.doc) {
    throw new Error('release-manifest-seal: a signer identity is required — the bake never mints a release signer; point it at the operator’s armor identity store');
  }
  const scratch = mkdtempSync(join(scratchRoot, 'km-manifest-seal-'));
  try {
    const recipient = createBundleIdentity(join(scratch, 'recipient'), 'kingmaker-release-manifest');
    const escrow = createBundleIdentity(join(scratch, 'escrow'), 'kingmaker-release-manifest-escrow');

    const sealedText = sealBundlePackage(Buffer.from(manifestText, 'utf8'), signerIdentity, recipient.publicPeer);
    const escrowText = sealBundlePackage(Buffer.from(JSON.stringify(recipient.doc), 'utf8'), signerIdentity, escrow.publicPeer);
    const pin = { schema: MANIFEST_PIN_SCHEMA, signerSignFp: signerIdentity.signFp, escrowIdentity: escrow.doc };
    const pinText = `${JSON.stringify(pin, null, 2)}\n`;

    // Prove the set round-trips through the same bootstrap the Launcher runs, byte for byte,
    // before any of it is allowed near a release folder.
    const opened = openSealedReleaseManifest({ sealedText, escrowText, pin });
    if (opened.manifestText !== manifestText) {
      throw new Error('release-manifest-seal: the sealed manifest did not round-trip byte-identically — refusing to emit it');
    }
    return { sealedText, escrowText, pin, pinText, signerSignFp: signerIdentity.signFp, canary: opened.canary };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The bootstrap open, exactly as a consumer runs it: the pin's escrow identity opens the
 * escrow package (signer-pinned) to recover the manifest recipient identity, which opens the
 * sealed manifest (signer-pinned again). Every failure of the underlying package open —
 * wrong signer, bad signature, wrong recipient, tampered bytes — propagates as its coded
 * ArmorBundleError. Returns { manifestText, canary, signerSignFp }.
 */
export function openSealedReleaseManifest({ sealedText, escrowText, pin } = {}, scratchRoot = tmpdir()) {
  if (!pin || pin.schema !== MANIFEST_PIN_SCHEMA || !pin.signerSignFp || !pin.escrowIdentity) {
    throw new Error(`release-manifest-seal: the pin is not a ${MANIFEST_PIN_SCHEMA} document`);
  }
  const escrowIdentity = identityFromStoredDoc(pin.escrowIdentity, scratchRoot);
  const recipientDocText = openBundlePackage(escrowText, escrowIdentity, { expectSenderSignFp: pin.signerSignFp }).toString('utf8');
  let recipientDoc;
  try { recipientDoc = JSON.parse(recipientDocText); } catch { throw new Error('release-manifest-seal: the manifest key escrow did not contain an identity document'); }
  const recipient = identityFromStoredDoc(recipientDoc, scratchRoot);
  const plaintext = openBundlePackage(sealedText, recipient, { expectSenderSignFp: pin.signerSignFp });
  let frame = null;
  try { frame = JSON.parse(String(sealedText).split('\n')[1]); } catch { /* the open above already proved the frame parses */ }
  return { manifestText: plaintext.toString('utf8'), canary: frame?.canary ?? null, signerSignFp: pin.signerSignFp };
}

/**
 * The release-parts hook: seal `manifestText` with the operator's signer store at
 * `signerDir` and write the three assets into `outDir`. Returns the asset rows
 * ({ name }) the caller folds into SHA256SUMS and the publish command.
 */
export function writeSealedManifestAssets(outDir, manifestText, { signerDir } = {}) {
  if (!signerDir || !existsSync(join(signerDir, 'identity.json'))) {
    throw new Error('release-manifest-seal: --seal-manifest needs --seal-signer <identity-dir> (an armor identity store holding identity.json) — there is no default signer');
  }
  const signerIdentity = loadBundleIdentity(signerDir);
  if (!signerIdentity) throw new Error(`release-manifest-seal: no signer identity in ${signerDir}`);
  const { sealedText, escrowText, pinText, signerSignFp, canary } = sealReleaseManifest(manifestText, { signerIdentity });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, SEALED_MANIFEST_FILE), sealedText);
  writeFileSync(join(outDir, MANIFEST_ESCROW_FILE), escrowText);
  writeFileSync(join(outDir, MANIFEST_PIN_FILE), pinText);
  return { assets: [...SEALED_MANIFEST_ASSETS], signerSignFp, canary };
}
