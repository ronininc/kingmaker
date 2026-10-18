#!/usr/bin/env node
// Operator tool for Kingmaker's offline release-signing key. See lib/release-signing.mjs for why this exists.
//
//   node scripts/kingmaker-release-sign.mjs keygen [--out <dir>] [--force]
//       Generate a fresh RSA-4096 keypair. Writes <dir>/kingmaker-release-private.pem (KEEP OFFLINE, never commit)
//       and <dir>/kingmaker-release-public.pem, and prints the fingerprint to publish. After running it, copy the
//       public PEM over lib/kingmaker-release-public.pem (the pinned key file — never paste PEM into a .mjs) and move
//       the private key to offline storage. Refuses to overwrite an existing keypair unless --force (rotation).
//
//   node scripts/kingmaker-release-sign.mjs sign --manifest <kingmaker-manifest.json> --key <private.pem> [--out <file>]
//       Sign the manifest's exact bytes. Writes <manifest>.sig (base64) beside it unless --out is given.
//
//   node scripts/kingmaker-release-sign.mjs verify --manifest <file> [--sig <file>] [--pub <file>]
//       Verify a manifest signature against the pinned public key (or --pub). Exit 0 if valid, 1 if not.
//
//   node scripts/kingmaker-release-sign.mjs fingerprint [--pub <file>]
//       Print the fingerprint of the pinned public key (or --pub).

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { generateReleaseKeypair, signManifestBytes, verifyManifestBytes, pubkeyFingerprint } from '../lib/release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from '../lib/release-pubkey.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}
function die(msg) { console.error(msg); process.exit(1); }

const cmd = process.argv[2];

if (cmd === 'keygen') {
  const out = arg('--out', process.cwd());
  const force = process.argv.includes('--force');
  mkdirSync(out, { recursive: true });
  const priv = join(out, 'kingmaker-release-private.pem');
  const pub = join(out, 'kingmaker-release-public.pem');
  // Refuse to clobber an existing keypair: an accidental rerun would destroy the only private key matching the public
  // key already pinned in shipped installers, and no future release could be signed for them. Rotation is deliberate.
  if (!force && (existsSync(priv) || existsSync(pub))) {
    die(`A keypair already exists in ${out} (${existsSync(priv) ? 'private' : ''}${existsSync(priv) && existsSync(pub) ? ' + ' : ''}${existsSync(pub) ? 'public' : ''}).\nGenerating would overwrite it and break signing for every installer carrying the current key. To rotate on purpose, pass --force (and re-pin + re-sign + publish the new fingerprint).`);
  }
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  writeFileSync(priv, privateKeyPem, { mode: 0o600 });
  try { chmodSync(priv, 0o600); } catch { /* best effort: fix perms even when overwriting an existing file */ }
  writeFileSync(pub, publicKeyPem);
  console.log(`Private key: ${priv}  ← MOVE THIS OFFLINE. Never commit it. It is the only thing that proves a release is yours.`);
  console.log(`Public key:  ${pub}  ← copy this file over lib/kingmaker-release-public.pem (the pinned key; do NOT paste it into any .mjs)`);
  console.log(`Fingerprint: ${pubkeyFingerprint(publicKeyPem)}  ← publish this on your site so users can verify out of band`);
} else if (cmd === 'sign') {
  const manifest = arg('--manifest') || die('sign needs --manifest <file>');
  const keyPath = arg('--key') || die('sign needs --key <private.pem>');
  const outPath = arg('--out', `${manifest}.sig`);
  const bytes = readFileSync(manifest);
  const sig = signManifestBytes(bytes, readFileSync(keyPath, 'utf8'));
  // Refuse to write a signature the installer would reject: it must verify against the pinned public key, exactly as
  // release-parts.mjs checks. Catches signing with the wrong offline key, or rotating only one half of the pair.
  if (!RELEASE_PUBLIC_KEY_PEM) die('No pinned public key (lib/kingmaker-release-public.pem) to check the signature against. Generate and pin one first.');
  if (!verifyManifestBytes(bytes, sig, RELEASE_PUBLIC_KEY_PEM)) {
    die(`This key's signature does NOT verify against the pinned public key (fingerprint ${pubkeyFingerprint(RELEASE_PUBLIC_KEY_PEM)}). Wrong offline key, or the pinned key was rotated without re-pinning. Nothing written.`);
  }
  writeFileSync(outPath, sig);
  console.log(`Signed ${manifest} → ${outPath} (verified against the pinned key)`);
} else if (cmd === 'verify') {
  const manifest = arg('--manifest') || die('verify needs --manifest <file>');
  const sigPath = arg('--sig', `${manifest}.sig`);
  const pub = arg('--pub') ? readFileSync(arg('--pub'), 'utf8') : RELEASE_PUBLIC_KEY_PEM;
  if (!pub) die('No pinned public key: generate one with `keygen` and paste it into lib/release-pubkey.mjs, or pass --pub.');
  const ok = verifyManifestBytes(readFileSync(manifest), readFileSync(sigPath, 'utf8'), pub);
  console.log(ok ? 'VALID: this manifest was signed by the pinned release key.' : 'INVALID: signature does not match the pinned release key.');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'fingerprint') {
  const pub = arg('--pub') ? readFileSync(arg('--pub'), 'utf8') : RELEASE_PUBLIC_KEY_PEM;
  if (!pub) die('No pinned public key yet.');
  console.log(pubkeyFingerprint(pub));
} else {
  die('Usage: kingmaker-release-sign.mjs <keygen|sign|verify|fingerprint> [...]  (see the header of this file)');
}
