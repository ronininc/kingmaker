#!/usr/bin/env node
// scripts/owner-install-ronin-addon.mjs — OWNER-ONLY, one command: put the paid Ronin office add-on (addons/ronin, sku
// addon.ronin-office) onto THIS Mac's installed Kingmaker. Since the free app carries no add-on code, a Kingmaker that
// updates to 0.2.8 loses Ronin pairing, desks, approvals, the DM bridge and owner calls until this has run.
//
//   node scripts/owner-install-ronin-addon.mjs --sign-key <offline-release-private.pem> [options]
//
//   --sign-key <pem>       the OFFLINE release-signing key (or env KINGMAKER_RELEASE_SIGNING_KEY): signs the add-on's manifest
//                          (RSA-PSS SHA-256), the same convention as release-parts.mjs
//   --cert-key <pem>       Ronin's install-certificate private key (default ~/.solomon-secure/ronin-install-cert/cert-private-pkcs8.pem)
//   --app <Kingmaker.app>  the installed app (default /Applications/Kingmaker.app); its own engine does the install
//   --install <id> [--device <sha256>]   bind to this install by hand; the default is this Mac's own (its Keychain certificate)
//   --days N | --no-expiry the entitlement's life (default: never expires; revoke it at the update host)
//   --order <ref>          an opaque order ref for the entitlement (default none: revoked by install id)
//   --dry-run              build, sign and mint, check them, and stop before touching the installed Kingmaker
//   --keep                 keep the working folder (the staged add-on and entitlement) instead of deleting it
//   --allow-version-mismatch  build even when this checkout's version is not the installed Kingmaker's (the add-on binds the
//                          engine's own modules, so use the checkout of the installed version)
//
// Re-runnable: it rebuilds, re-signs, re-mints and re-installs; an installed copy of the same version is swapped atomically
// and the previous one kept until the new one is in place. It prints what it did and never a key.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddon } from '../addons/build-addon.mjs';
import { checkFiles, manifestProblems, verifyManifestSig } from '../lib/addons.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from '../lib/release-pubkey.mjs';
import { pubkeyFingerprint, signManifestBytes } from '../lib/release-signing.mjs';
import { compareVersions } from '../lib/update.mjs';
import { DEFAULT_KEY_PATH, run as mint } from './mint-entitlement.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_APP = '/Applications/Kingmaker.app';
export const ADDON_FOLDER = 'ronin';
export const ADDON_ID = 'ronin-office';

export function parseArgs(argv, env = process.env) {
  const o = { signKey: env.KINGMAKER_RELEASE_SIGNING_KEY || null, certKey: DEFAULT_KEY_PATH, app: DEFAULT_APP, install: null, device: null, days: null, noExpiry: false, order: null, dryRun: false, keep: false, allowVersionMismatch: false, help: false };
  const val = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sign-key') o.signKey = val(i++, a);
    else if (a === '--cert-key') o.certKey = val(i++, a);
    else if (a === '--app') o.app = val(i++, a);
    else if (a === '--install') o.install = val(i++, a);
    else if (a === '--device') o.device = val(i++, a);
    else if (a === '--days') { o.days = Number(val(i++, a)); if (!(o.days > 0)) throw new Error('--days must be a positive number'); }
    else if (a === '--no-expiry') o.noExpiry = true;
    else if (a === '--order') o.order = val(i++, a);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--allow-version-mismatch') o.allowVersionMismatch = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const USAGE = (() => {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('//   node scripts/'));
  const to = lines.findIndex((l, i) => i > from && !l.startsWith('//'));
  return lines.slice(from, to).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
})();

const readVersion = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')).version || null; } catch { return null; } };

/** The installed Kingmaker's own pieces: its version, its CLI and whether its engine has the add-on hook. */
export function inspectApp(app) {
  const engine = join(app, 'Contents', 'Resources', 'sol-ghost');
  return { engine, cli: join(engine, 'bin', 'kingmaker'), version: readVersion(join(engine, 'package.json')), hasHook: existsSync(join(engine, 'lib', 'addons.mjs')) };
}

/**
 * Do the whole thing. `io`: { say, err, thisMac (override of the Keychain read), releasePub (PEM text the manifest signature
 * must verify against; default the pinned one), certPub (path of the public key the entitlement must verify against;
 * default the pinned one), now, workDir }. Returns the exit code.
 */
export async function ownerInstall(o, io = {}) {
  const say = io.say ?? ((s) => console.log(s)), err = io.err ?? ((s) => console.error(s));
  const releasePub = io.releasePub ?? RELEASE_PUBLIC_KEY_PEM;
  const work = io.workDir ?? mkdtempSync(join(tmpdir(), 'km-ronin-addon-'));
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    // 0. The installed Kingmaker, and a checkout that matches it.
    const app = inspectApp(o.app);
    if (!app.version || !existsSync(app.cli)) throw new Error(`no Kingmaker found at ${o.app} (pass --app <path to Kingmaker.app>).`);
    if (!app.hasHook) throw new Error(`the Kingmaker at ${o.app} is ${app.version}, which has no add-on support yet. Update it to 0.2.8 first, then run this again.`);
    const mine = readVersion(join(ROOT, 'package.json'));
    if (mine !== app.version && !o.allowVersionMismatch) {
      const older = compareVersions(app.version, mine) < 0;
      throw new Error(`this checkout is Kingmaker ${mine} but the installed one is ${app.version}. ${older ? `Update the installed Kingmaker to ${mine} first, then run this again.` : `The add-on binds the engine's own modules, so check out v${app.version} (git checkout v${app.version}) and run this again.`} (Or pass --allow-version-mismatch.)`);
    }
    say(`Installed Kingmaker ${app.version} at ${o.app}; checkout ${mine}.`);
    if (!o.signKey) throw new Error('--sign-key <offline release private key> is required (or set KINGMAKER_RELEASE_SIGNING_KEY).');

    // 1. Build the add-on package.
    const dist = join(work, 'dist');
    const built = buildAddon(ADDON_FOLDER, { out: dist });
    const m = built.manifest;
    if (m.id !== ADDON_ID || !m.paid || !m.sku) throw new Error(`addons/${ADDON_FOLDER} did not build a paid ${ADDON_ID}.`);
    say(`1/5 Built ${m.id} ${m.version}: ${m.files.length} files, sku ${m.sku}.`);

    // 2. Sign the manifest's exact bytes with the offline release key; it must verify against the pinned public key.
    const manifestPath = join(built.dir, 'manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    let sig;
    try { sig = signManifestBytes(manifestBytes, readFileSync(o.signKey)); } catch { throw new Error(`could not sign with the release key at ${o.signKey} (unreadable, or not an RSA private key).`); }
    if (!verifyManifestSig(manifestBytes, sig, releasePub)) throw new Error('the signature this key produced does not verify against the pinned release public key (lib/kingmaker-release-public.pem): wrong key. Nothing was installed.');
    say(`2/5 Signed the manifest; it verifies against the pinned release key ${pubkeyFingerprint(releasePub)}.`);

    // 3. Stage what `kingmaker addons install` takes: the archive's files, the manifest and its signature.
    const staged = join(work, 'staged');
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { recursive: true });
    const unzip = spawnSync('/usr/bin/unzip', ['-q', built.archivePath, '-d', staged], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error(`could not unpack the add-on archive: ${(unzip.stderr || '').trim()}`);
    copyFileSync(manifestPath, join(staged, 'manifest.json')); // the exact signed bytes
    writeFileSync(join(staged, 'manifest.json.sig'), sig);
    const bad = manifestProblems(m).join('; ') || checkFiles(staged, m);
    if (bad) throw new Error(`the staged add-on does not check out: ${bad}`);
    say(`3/5 Staged ${m.files.length} files with the signed manifest.`);

    // 4. Mint this Mac's entitlement (shares mint-entitlement.mjs, so it verifies against the pinned install-cert key too).
    const entPath = join(work, 'entitlement.json');
    const mintArgs = ['--sku', m.sku, '--key', o.certKey, '--out', entPath];
    if (o.install) mintArgs.push('--install', o.install, ...(o.device ? ['--device', o.device] : [])); else mintArgs.push('--this-mac');
    if (o.noExpiry) mintArgs.push('--no-expiry'); else if (o.days) mintArgs.push('--days', String(o.days));
    if (o.order) mintArgs.push('--order', o.order);
    if (io.certPub) mintArgs.push('--pub', io.certPub);
    const lines = [];
    const code = mint(mintArgs, { out: (s) => lines.push(s), err, thisMac: io.thisMac, now: io.now });
    if (code !== 0) throw new Error('could not mint the entitlement (see above). Nothing was installed.');
    say('4/5 ' + lines.join('\n    '));

    if (o.dryRun) { say('5/5 --dry-run: stopped before installing. Built, signed and minted fine.'); return 0; }

    // 5. Install with the installed app's own engine. The entitlement goes over stdin, never argv.
    const entitlement = readFileSync(entPath, 'utf8');
    const cli = (args, input) => spawnSync(app.cli, args, { input, encoding: 'utf8', env: process.env, timeout: 120_000 });
    const inst = cli(['addons', 'install', staged], entitlement);
    const said = `${inst.stdout || ''}${inst.stderr || ''}`.trim();
    if (inst.status !== 0) throw new Error(`the installed Kingmaker refused the add-on (exit ${inst.status}): ${said || 'no message'}`);
    say(`5/5 Installed with Kingmaker's own engine: ${said}`);

    // Proof it is in place and loads under the installed engine's real checks (signature, hashes, entitlement, revocation).
    const list = cli(['addons', 'list']);
    const listed = (list.stdout || '').split('\n').some((l) => l.trim() === `${m.id} ${m.version}`);
    if (!listed) throw new Error(`install reported success but \`kingmaker addons list\` shows: ${(list.stdout || '(nothing)').trim()}`);
    const load = cli(['crm-lock', 'status']);
    if (load.status !== 0) throw new Error(`installed, but it does not load: ${`${load.stdout || ''}${load.stderr || ''}`.trim()}`);
    say(`Ronin office ${m.version} is installed and loads (crm-lock status: ${(load.stdout || '').trim()})`);
    say('Quit Kingmaker from the menu bar and open it again so the running one picks it up, then: kingmaker pair, kingmaker office ronin, kingmaker owner-call status.');
    return 0;
  } catch (e) {
    err(`owner-install-ronin-addon: ${e.message}`);
    return 1;
  } finally {
    if (!o.keep && !io.workDir) rmSync(work, { recursive: true, force: true });
    else if (o.keep) say(`Kept the working folder (staged add-on and entitlement): ${work}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`owner-install-ronin-addon: ${e.message}\n\n${USAGE}`); process.exit(2); }
  if (o.help) { console.log(USAGE); process.exit(0); }
  process.exit(await ownerInstall(o));
}
