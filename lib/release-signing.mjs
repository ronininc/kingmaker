// Offline release signing for Kingmaker's manifest.
//
// Why this exists: the installer verifies every download against the sha256 values in kingmaker-manifest.json, but
// those values come from the same place the download does. Anyone who controls the update host (or rebuilds the
// installer) can swap the files AND the hashes together, and the check still passes. A sha256 proves a download
// wasn't corrupted in transit; it does NOT prove the operator authorized that release.
//
// A detached signature closes that gap. The operator signs the exact bytes of kingmaker-manifest.json with a private
// key that never touches the server, producing kingmaker-manifest.json.sig. The installer (and the running app, for
// updates) verify that signature against a PUBLIC key pinned in the code. A stolen Cloudflare/R2 account can still
// serve bytes, but it cannot forge the signature, so a tampered manifest is rejected. This substitutes for Apple
// notarization until a Developer ID is available, and complements it afterwards.
//
// Primitive: RSA-PSS over sha256(manifest bytes). RSA (not ed25519) because the installer verifies in pure shell with
// macOS's stock `openssl` (LibreSSL), whose `dgst -verify` handles RSA reliably while its raw-ed25519 support is
// patchy across OS versions. The matching shell command the installer runs is documented in VERIFY_OPENSSL below.
//
// The private key is generated once with `node scripts/kingmaker-release-sign.mjs keygen` and kept OFFLINE. Only the
// public key (PEM) is committed, in lib/release-pubkey.mjs, and shipped inside the installer.

import { createSign, createVerify, generateKeyPairSync, createHash } from 'node:crypto';

/** RSA-PSS with sha256, salt length = digest length (32). Pinned so signer and verifier never disagree. */
export const SIGN_ALGORITHM = 'RSA-SHA256';
export const RSA_MODULUS_BITS = 4096;
const PSS_PADDING = 6; // crypto.constants.RSA_PKCS1_PSS_PADDING
const PSS_SALTLEN_DIGEST = -1; // crypto.constants.RSA_PSS_SALTLEN_DIGEST

/** The exact `openssl` invocation installer/engine.sh uses to verify, for reference and to keep the two in lock-step:
 *    openssl dgst -sha256 -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:-1 \
 *      -verify <pubkey.pem> -signature <manifest.sig> <manifest.json>
 * (saltlen -1 means "equal to the digest length", matching PSS_SALTLEN_DIGEST here.) */
export const VERIFY_OPENSSL = 'openssl dgst -sha256 -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:-1 -verify PUB -signature SIG MSG';

/** Generate an offline release-signing keypair. Returns PEM strings; the caller writes the private one somewhere safe
 *  and OFFLINE, and commits only the public one. */
export function generateReleaseKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Sign raw manifest bytes (a Buffer or Uint8Array) with the offline private key (PEM). Returns a base64 signature. */
export function signManifestBytes(bytes, privateKeyPem) {
  const signer = createSign(SIGN_ALGORITHM);
  signer.update(Buffer.from(bytes));
  signer.end();
  return signer.sign({ key: privateKeyPem, padding: PSS_PADDING, saltLength: PSS_SALTLEN_DIGEST }).toString('base64');
}

/** Verify a base64 signature over raw manifest bytes against the pinned public key (PEM). Returns a boolean; never
 *  throws on a bad signature (only on a malformed key, which is a build-time error, not attacker-controlled). */
export function verifyManifestBytes(bytes, signatureB64, publicKeyPem) {
  if (!signatureB64 || typeof signatureB64 !== 'string') return false;
  let sig;
  try { sig = Buffer.from(signatureB64, 'base64'); } catch { return false; }
  if (!sig.length) return false;
  const verifier = createVerify(SIGN_ALGORITHM);
  verifier.update(Buffer.from(bytes));
  verifier.end();
  try {
    return verifier.verify({ key: publicKeyPem, padding: PSS_PADDING, saltLength: PSS_SALTLEN_DIGEST }, sig);
  } catch {
    return false;
  }
}

/** A short, human-checkable fingerprint of a public key PEM: sha256 of its DER, hex, grouped. Publish this on the
 *  site so a careful user can confirm the key their installer carries is the operator's, out of band. */
export function pubkeyFingerprint(publicKeyPem) {
  const der = Buffer.from(
    String(publicKeyPem).replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''),
    'base64',
  );
  const hex = createHash('sha256').update(der).digest('hex');
  return hex.replace(/(.{4})/g, '$1 ').trim().toUpperCase();
}
