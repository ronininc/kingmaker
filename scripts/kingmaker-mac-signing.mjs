#!/usr/bin/env node
// Kingmaker release signing gate (private operator tooling; lives only on the release Mac).
//
// The release identity is the pinned self-signed certificate in lib/release-identity.json
// ("Kingmaker Release"). The installer installs ONLY an app whose designated requirement
// names that certificate's leaf, so a release signed by anything else is a broken release.
// scripts/release-parts.mjs imports verifyKingmakerSignature from this file and refuses to
// package an app that fails it (unless KINGMAKER_ALLOW_ADHOC=1, a disposable-build escape
// that must never ship).
//
//   node scripts/kingmaker-mac-signing.mjs --identity          print the pinned leaf SHA-1
//   node scripts/kingmaker-mac-signing.mjs --verify <app>      JSON verdict against the pin
//   node scripts/kingmaker-mac-signing.mjs --sign <app>        re-sign the app inside-out with
//                                                              the pinned identity (delegates to
//                                                              the TSS inside-out signer), then verify
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPin, leafFromRequirement, KINGMAKER_BUNDLE_ID } from '../lib/release-identity.mjs';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

export function verifyKingmakerSignature(appPath) {
  if (process.platform !== 'darwin') return { ok: false, adhoc: false, pinned: null, pinMatches: false, leaf: null, reason: 'codesign is macOS-only' };
  const pin = readPin();
  const pinned = pin?.sha1 ?? null;
  if (!existsSync(appPath)) return { ok: false, adhoc: false, pinned, pinMatches: false, leaf: null, reason: `app not found: ${appPath}` };
  const strict = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = run('codesign', ['-dvvv', appPath]);
  const requirement = run('codesign', ['-d', '-r-', appPath]);
  const adhoc = /Signature=adhoc/.test(details.out);
  const hardened = /flags=0x[0-9a-f]*\(.*runtime.*\)/i.test(details.out);
  const identifier = /^Identifier=(.+)$/m.exec(details.out)?.[1] ?? null;
  const authority = /^Authority=(.+)$/m.exec(details.out)?.[1] ?? null;
  const leaf = leafFromRequirement(requirement.out);
  const pinMatches = Boolean(leaf && pinned && leaf === pinned);
  const ok = strict.code === 0 && !adhoc && hardened && identifier === KINGMAKER_BUNDLE_ID && pinMatches;
  return { ok, strict: strict.code === 0, adhoc, hardened, identifier, authority, leaf, pinned, pinMatches, designatedRequirement: requirement.out.trim() };
}

const INSIDEOUT_SIGNER_CANDIDATES = [
  process.env.KINGMAKER_INSIDEOUT_SIGNER || '',
  '/Users/robbiebrown/Projects/TSS/solomon files./scripts/solomon-mac-selfsigned-sign.mjs',
].filter(Boolean);

function signInsideOut(appPath, pin) {
  const signer = INSIDEOUT_SIGNER_CANDIDATES.find((p) => existsSync(p));
  if (!signer) throw new Error('inside-out signer not found (looked in KINGMAKER_INSIDEOUT_SIGNER and the TSS tree); refusing to improvise a signature');
  // The app's own build entitlements sit two levels up from a dist-ghost app
  // (<worktree>/desktop/entitlements.mac.plist); fall back to the signer's tree default.
  const appEntitlements = join(dirname(dirname(resolve(appPath))), 'entitlements.mac.plist');
  const env = { ...process.env, SOLOMON_MAC_APP: resolve(appPath), SOLOMON_SIGNING_IDENTITY: pin.sha1 };
  if (existsSync(appEntitlements)) env.SOLOMON_MAC_ENTITLEMENTS = appEntitlements;
  console.log(`Signing inside-out with pinned identity "${pin.name}" ${pin.sha1}`);
  console.log(`  signer:       ${signer}`);
  console.log(`  app:          ${env.SOLOMON_MAC_APP}`);
  console.log(`  entitlements: ${env.SOLOMON_MAC_ENTITLEMENTS || '(signer default)'}`);
  const r = spawnSync('node', [signer], { stdio: 'inherit', env });
  if ((r.status ?? 1) !== 0) throw new Error(`inside-out signer exited ${r.status ?? 1}`);
}

function main(argv = process.argv.slice(2)) {
  const pin = readPin();
  if (argv.includes('--identity')) {
    if (!pin) { console.error('no Kingmaker Release certificate is pinned in lib/release-identity.json'); return 1; }
    console.log(pin.sha1);
    return 0;
  }
  const at = argv.findIndex((a) => a === '--verify' || a === '--sign');
  if (at >= 0 && argv[at + 1]) {
    const appPath = resolve(argv[at + 1]);
    if (argv[at] === '--sign') {
      if (!pin) { console.error('no pinned Kingmaker Release certificate; create or restore it first (scripts/kingmaker-release-identity.mjs)'); return 1; }
      try { signInsideOut(appPath, pin); } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    const verdict = verifyKingmakerSignature(appPath);
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.pinMatches) console.error(`✗ signed by ${verdict.leaf ?? 'no certificate'}, not the pinned Kingmaker Release certificate ${verdict.pinned ?? '(none pinned)'}`);
    return verdict.ok ? 0 : 1;
  }
  console.error('usage: kingmaker-mac-signing.mjs --identity | --verify <Kingmaker.app> | --sign <Kingmaker.app>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
