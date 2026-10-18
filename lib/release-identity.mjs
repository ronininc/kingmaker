// lib/release-identity.mjs — the Kingmaker Release signing identity: ONE self-signed certificate that signs every
// Kingmaker that leaves the owner's Mac (the owner, 2026-10-15: no paid Apple account yet; "this has to survive use in
// the wild"). macOS keeps an owner's Microphone, Accessibility and Screen Recording grants for the app's designated
// requirement, which names this certificate's leaf hash; signing every release with the same certificate is what keeps
// those grants through every update, on every owner's Mac, with nothing installed or trusted there.
//
// Two halves, never mixed:
//   PUBLIC   the certificate's fingerprint, pinned in lib/release-identity.json (ships in every Kingmaker). The build
//            signs only with it, the installer installs only an app signed by it, the updater runs only an installer
//            script signed by it. A copy signed by anyone else is refused, and macOS gives it none of the grants.
//   PRIVATE  the key: in the owner's login keychain (codesign uses it there) and, encrypted with a passphrase only the
//            owner knows, in the owner's vault (~/.solomon-secure/kingmaker-release/) plus one offline copy. Never in
//            the repo, never in a build, never on an owner's Mac (anyone holding it could sign software macOS treats as
//            Kingmaker). scripts/kingmaker-release-identity.mjs makes, backs up and restores it.
// It is NOT notarization: Gatekeeper still asks each owner once ("Open Anyway") until there is an Apple Developer ID.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RELEASE_IDENTITY_NAME = 'Kingmaker Release';
export const KINGMAKER_BUNDLE_ID = 'com.ronininc.solghost';
export const PIN_FILE = new URL('./release-identity.json', import.meta.url);
/** Thirty years: an expired self-signed certificate is one more thing that can break in the wild. */
export const RELEASE_CERT_DAYS = 10_950;

const SHA1 = /^[0-9A-F]{40}$/;

/** The pinned public identity { name, sha1, sha256, notAfter, createdAt }, or null while none is made yet. */
export function readPin(file = PIN_FILE) {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    const sha1 = String(p?.sha1 ?? '').toUpperCase();
    return SHA1.test(sha1) ? { ...p, sha1 } : null;
  } catch { return null; }
}

/** Pure: the requirement an app (or a detached signature) must meet: this bundle id, signed by exactly this leaf. */
export function appRequirement(sha1, bundleId = KINGMAKER_BUNDLE_ID) {
  if (!SHA1.test(String(sha1 ?? '').toUpperCase())) throw new Error('no pinned Kingmaker Release certificate');
  return `identifier "${bundleId}" and certificate leaf = H"${String(sha1).toUpperCase()}"`;
}
/** Pure: the requirement for a plain file signed with the identity (the installer script on the update host). */
export function fileRequirement(sha1) {
  if (!SHA1.test(String(sha1 ?? '').toUpperCase())) throw new Error('no pinned Kingmaker Release certificate');
  return `certificate leaf = H"${String(sha1).toUpperCase()}"`;
}

/** Pure: the leaf hash in `codesign -d -r- <app>` output (its designated requirement), or null. */
export function leafFromRequirement(text) {
  const m = /certificate leaf = H"([0-9a-fA-F]{40})"/.exec(String(text ?? ''));
  return m ? m[1].toUpperCase() : null;
}

/** Pure: the SHA-1 fingerprint in `openssl x509 -noout -fingerprint -sha1` output ("sha1 Fingerprint=AB:CD:…"). */
export function sha1FromFingerprint(text) {
  const m = /fingerprint\s*=\s*([0-9A-F:]{59})/i.exec(String(text ?? ''));
  return m ? m[1].replace(/:/g, '').toUpperCase() : null;
}

/** Where the encrypted backup of the private key lives on the owner's Mac (the vault, 0700/0600). */
export const backupDir = (env = process.env, home = homedir()) => join(env.HOME || home, '.solomon-secure', 'kingmaker-release');
export const backupFile = (env = process.env, home = homedir()) => join(backupDir(env, home), 'Kingmaker-Release.p12');

/** Pure: the openssl config for the certificate: code signing only, never a CA. */
export function certConfig(name = RELEASE_IDENTITY_NAME) {
  return ['[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no', '[dn]', `CN = ${name}`, 'O = Ronin Inc.',
    '[v3]', 'basicConstraints = critical,CA:false', 'keyUsage = critical,digitalSignature', 'extendedKeyUsage = critical,codeSigning',
    'subjectKeyIdentifier = hash', ''].join('\n');
}

/** Pure: a backup passphrase the owner chose is long enough to protect a key that signs every Kingmaker. */
export function passphraseProblem(p) {
  const s = String(p ?? '');
  if (s.length < 12) return 'Use at least 12 characters.';
  if (new Set(s).size < 6) return 'Use more different characters.';
  return null;
}
