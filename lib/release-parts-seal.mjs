// lib/release-parts-seal.mjs — THE ARMOR WRAP FOR THE RELEASE PAYLOAD PARTS
// (Kingmaker code; the download-path ruling, Robbie, 2026-10-29 14:22 MST:
// "the crm serves the repos contents without exposing it — scripture armor
// extends across the download path. nothing i do should exist without
// script armor.").
//
// lib/release-manifest-seal.mjs wrapped the release MANIFEST — the trust
// root. This module extends the same wrap to the payload PARTS themselves,
// so a sealed bake's hand-out set carries NO plaintext payload and NO
// plaintext manifest: only Scripture Armor packages, the pin, the Launcher
// zip (the codesigned key-carrier), and SHA256SUMS over the SEALED bytes.
//
// NAMING (deterministic): a part's sealed asset is the part's own name plus
// the suffix ".scripture" — kingmaker-payload.tar.part-aa travels as
// kingmaker-payload.tar.part-aa.scripture. Anyone (the CRM route, the npm
// shim, the Launcher) derives a sealed name from the manifest's part list
// without a second registry.
//
// CUSTODY: ONE seal session per bake — one per-bake recipient identity and
// one per-bake escrow identity, minted in scratch and destroyed with it,
// exactly the F-03 / manifest-seal pattern (lib/release-manifest-seal.mjs).
// The manifest and every part are sealed by the operator's signer to that
// ONE recipient; the recipient's identity document is sealed by the signer
// to the escrow identity, whose document rides in the pin. The pin
// (kingmaker-manifest-pin.json, schema kingmaker.release-manifest-pin/1 —
// unchanged) gains an additive `parts` block:
//
//   parts: { keyFile, items: [{ name, sealedName, plainSha256, plainSize,
//                               sealedSha256, sealedSize }] }
//
// keyFile names the release asset carrying the escrow package: when the
// manifest is sealed in the same bake it is the manifest trio's key file
// (kingmaker-manifest.key.scripture — the same escrow package bytes, one
// representation); in a parts-only bake it is kingmaker-release.key.scripture.
// The pin's top-level fields are untouched, so the shipped consumers that
// read { schema, signerSignFp, escrowIdentity } (Launcher 0.3.5's
// armor_package.rs) resolve a session pin exactly like a manifest-only pin,
// and a manifest sealed in a session opens through the ORIGINAL
// openSealedReleaseManifest bootstrap.
//
// The seal/open below call lib/armor-bundle.mjs's package functions — the
// public, frozen Scripture Armor package format. No cryptography is
// implemented here; this module is custody and file layout only.
//
// FAIL CLOSED, like the manifest seal: the session proves its escrow
// bootstrap before sealing anything, the manifest seal round-trips
// byte-identically before it is returned, and every sealed part is opened
// back and hash-compared with the part that went in. A set that does not
// round-trip is never handed to a release. And the bake never mints a
// signer: without the operator's identity store the seal is refused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBundleIdentity,
  loadBundleIdentity,
  openBundlePackage,
  sealBundlePackage,
} from './armor-bundle.mjs';
import {
  MANIFEST_ESCROW_FILE,
  MANIFEST_PIN_FILE,
  MANIFEST_PIN_SCHEMA,
  SEALED_MANIFEST_FILE,
} from './release-manifest-seal.mjs';

export { MANIFEST_PIN_FILE, MANIFEST_PIN_SCHEMA };

/** The suffix that turns a part's asset name into its sealed asset name. */
export const SEALED_PART_SUFFIX = '.scripture';
/** The escrow package's asset name in a parts-only bake (no manifest seal). */
export const PARTS_KEY_FILE = 'kingmaker-release.key.scripture';

/** Pure: the sealed asset name for a release part. */
export const sealedPartName = (partName) => `${partName}${SEALED_PART_SUFFIX}`;

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Rebuild a loaded identity from its document using only the loader's public
 * surface — the document is staged as a store in scratch and
 * loadBundleIdentity verifies its store-integrity tag before use. (Same
 * helper as lib/release-manifest-seal.mjs; armor-bundle.mjs's internal
 * identityFromDoc is not exported.)
 */
function identityFromStoredDoc(doc, scratchRoot) {
  const dir = mkdtempSync(join(scratchRoot, 'km-seal-id-'));
  try {
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(doc), { mode: 0o600 });
    const identity = loadBundleIdentity(dir);
    if (!identity) throw new Error('release-parts-seal: an identity document did not load');
    return identity;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The consumer bootstrap, generic over any package a seal session produced:
 * the pin's escrow identity opens the escrow package (signer-pinned) to
 * recover the bake recipient identity, which opens the sealed package
 * (signer-pinned again). Returns { plaintext: Buffer, canary, signerSignFp }.
 * Every failure of the underlying package open propagates as its coded
 * ArmorBundleError.
 */
export function openSealedReleasePackage({ sealedText, escrowText, pin } = {}, scratchRoot = tmpdir()) {
  if (!pin || pin.schema !== MANIFEST_PIN_SCHEMA || !pin.signerSignFp || !pin.escrowIdentity) {
    throw new Error(`release-parts-seal: the pin is not a ${MANIFEST_PIN_SCHEMA} document`);
  }
  const escrowIdentity = identityFromStoredDoc(pin.escrowIdentity, scratchRoot);
  const recipientDocText = openBundlePackage(escrowText, escrowIdentity, { expectSenderSignFp: pin.signerSignFp }).toString('utf8');
  let recipientDoc;
  try { recipientDoc = JSON.parse(recipientDocText); } catch { throw new Error('release-parts-seal: the key escrow did not contain an identity document'); }
  const recipient = identityFromStoredDoc(recipientDoc, scratchRoot);
  const plaintext = openBundlePackage(sealedText, recipient, { expectSenderSignFp: pin.signerSignFp });
  let frame = null;
  try { frame = JSON.parse(String(sealedText).split('\n')[1]); } catch { /* the open above already proved the frame parses */ }
  return { plaintext, canary: frame?.canary ?? null, signerSignFp: pin.signerSignFp };
}

/**
 * One bake's seal session: a per-bake recipient + escrow pair under the
 * operator's signer. `signerIdentity` is a loaded bundle identity (see
 * loadBundleIdentity) — for a release, the operator's own. The session
 * proves its own escrow bootstrap (seal a probe, open it back through the
 * pin path, byte-compare) before it is handed out: a session that cannot
 * be opened by its own pin never seals a release.
 */
export function createReleaseSealSession({ signerIdentity, scratchRoot = tmpdir() } = {}) {
  if (!signerIdentity?.signFp || !signerIdentity?.doc) {
    throw new Error('release-parts-seal: a signer identity is required — the bake never mints a release signer; point it at the operator’s armor identity store');
  }
  const scratch = mkdtempSync(join(scratchRoot, 'km-release-seal-'));
  let recipient;
  let escrow;
  try {
    recipient = createBundleIdentity(join(scratch, 'recipient'), 'kingmaker-release');
    escrow = createBundleIdentity(join(scratch, 'escrow'), 'kingmaker-release-escrow');
  } finally {
    // The identities live on as in-memory key objects + documents; the
    // scratch store that minted them never leaves the bake.
    rmSync(scratch, { recursive: true, force: true });
  }
  const escrowText = sealBundlePackage(Buffer.from(JSON.stringify(recipient.doc), 'utf8'), signerIdentity, escrow.publicPeer);
  const session = {
    signerSignFp: signerIdentity.signFp,
    escrowIdentityDoc: escrow.doc,
    escrowText,
    seal(buf) { return sealBundlePackage(Buffer.from(buf), signerIdentity, recipient.publicPeer); },
    pin(partsBlock = null) {
      const pin = { schema: MANIFEST_PIN_SCHEMA, signerSignFp: signerIdentity.signFp, escrowIdentity: escrow.doc };
      if (partsBlock) pin.parts = partsBlock;
      return pin;
    },
  };
  const probe = Buffer.from('kingmaker release seal session probe', 'utf8');
  const opened = openSealedReleasePackage({ sealedText: session.seal(probe), escrowText, pin: session.pin() }, scratchRoot);
  if (!opened.plaintext.equals(probe)) {
    throw new Error('release-parts-seal: the seal session did not round-trip its own probe — refusing to seal a release with it');
  }
  return session;
}

/**
 * Load the operator's signer store and open a session with it. Refuses —
 * never defaults, never mints — when the store is absent.
 */
export function loadReleaseSealSession({ signerDir, scratchRoot = tmpdir() } = {}) {
  if (!signerDir || !existsSync(join(signerDir, 'identity.json'))) {
    throw new Error('release-parts-seal: sealing needs --seal-signer <identity-dir> (an armor identity store holding identity.json) — there is no default signer');
  }
  const signerIdentity = loadBundleIdentity(signerDir);
  if (!signerIdentity) throw new Error(`release-parts-seal: no signer identity in ${signerDir}`);
  return createReleaseSealSession({ signerIdentity, scratchRoot });
}

/**
 * Seal the manifest text inside the session (the same asset names the
 * manifest-only writer emits) and prove the round-trip byte-identically
 * before returning. The caller writes the files and, once the parts are
 * known, the one pin via writeReleaseSealPin.
 */
export function sealManifestInSession(session, manifestText, scratchRoot = tmpdir()) {
  const sealedText = session.seal(Buffer.from(manifestText, 'utf8'));
  const opened = openSealedReleasePackage({ sealedText, escrowText: session.escrowText, pin: session.pin() }, scratchRoot);
  if (opened.plaintext.toString('utf8') !== manifestText) {
    throw new Error('release-parts-seal: the sealed manifest did not round-trip byte-identically — refusing to emit it');
  }
  return { sealedText, escrowText: session.escrowText, canary: opened.canary };
}

/**
 * Seal every named part file in `outDir` inside the session, writing each
 * `<part>.scripture` beside it, and prove each one: opened back through
 * the escrow bootstrap, its sha256 must equal the part's own sha256 (the
 * same value the manifest pins). Returns { assets, items } — items are the
 * pin's parts rows, in the order the parts were given.
 */
export function writeSealedPartsAssets(outDir, partNames, { session, scratchRoot = tmpdir() } = {}) {
  if (!session) throw new Error('release-parts-seal: writeSealedPartsAssets needs a seal session');
  mkdirSync(outDir, { recursive: true });
  const assets = [];
  const items = [];
  for (const name of partNames) {
    const bytes = readFileSync(join(outDir, name));
    const plainSha256 = sha256Hex(bytes);
    const sealedText = session.seal(bytes);
    const sealedName = sealedPartName(name);
    writeFileSync(join(outDir, sealedName), sealedText);
    const opened = openSealedReleasePackage({ sealedText, escrowText: session.escrowText, pin: session.pin() }, scratchRoot);
    if (sha256Hex(opened.plaintext) !== plainSha256) {
      throw new Error(`release-parts-seal: sealed part ${sealedName} did not round-trip to ${name}'s sha256 — refusing to hand it to a release`);
    }
    assets.push(sealedName);
    items.push({
      name,
      sealedName,
      plainSha256,
      plainSize: bytes.length,
      sealedSha256: sha256Hex(Buffer.from(sealedText, 'utf8')),
      sealedSize: Buffer.byteLength(sealedText, 'utf8'),
    });
  }
  return { assets, items };
}

/**
 * Write the session's manifest assets (sealed manifest + the escrow
 * package under the manifest trio's key name). The pin is written
 * separately, once, by writeReleaseSealPin — one pin covers the bake.
 */
export function writeSessionManifestAssets(outDir, manifestText, { session, scratchRoot = tmpdir() } = {}) {
  if (!session) throw new Error('release-parts-seal: writeSessionManifestAssets needs a seal session');
  const { sealedText, canary } = sealManifestInSession(session, manifestText, scratchRoot);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, SEALED_MANIFEST_FILE), sealedText);
  writeFileSync(join(outDir, MANIFEST_ESCROW_FILE), session.escrowText);
  return { assets: [SEALED_MANIFEST_FILE, MANIFEST_ESCROW_FILE], canary };
}

/**
 * Write the bake's one pin file. With `partsItems`, the pin gains the
 * additive parts block; `partsKeyFile` names the asset carrying the
 * session's escrow package for the parts consumer (the manifest key file
 * when the manifest was sealed in the same bake, else PARTS_KEY_FILE —
 * whose bytes the caller writes from session.escrowText).
 */
export function writeReleaseSealPin(outDir, session, { partsItems = null, partsKeyFile = null } = {}) {
  const partsBlock = partsItems
    ? { keyFile: partsKeyFile ?? MANIFEST_ESCROW_FILE, items: partsItems }
    : null;
  const pin = session.pin(partsBlock);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, MANIFEST_PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}
