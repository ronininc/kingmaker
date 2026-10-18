#!/usr/bin/env node
// Build Kingmaker's release payload from the engine build's output: Kingmaker.app as a tar.gz split into parts of
// at most 1.9 GB (GitHub release assets stop at 2 GiB), a manifest pinning the sha256 of every part and of the whole,
// SHA256SUMS, and the pins for what the installer fetches besides (official Ollama, official Homebrew, the models by
// their Ollama registry digests). It never publishes anything: it prints the `gh release` command for the operator.
//
//   node scripts/release-parts.mjs [--app <Kingmaker.app>] [--out <dir>] [--tag v0.2.0]
//                                  [--part-size <bytes>] [--level 1-9] [--dry-run] [--offline] [--pins <file>]
//                                  [--skip-codesign] [--notarize] [--sign-key <private.pem>] --launcher <ronin-launcher-pin.json>
//
//   --app        default: $KINGMAKER_ENGINE_SRC/desktop/dist-ghost/Kingmaker.app (KINGMAKER_ENGINE_SRC: the engine's source
//                checkout; without it, --app is required)
//   --out        default: dist/release/<tag>
//   --dry-run    stream the archive through the hashes without writing a single part (no disk), print the manifest
//   --offline    no network: model digests from this Mac's Ollama, Ollama/Homebrew pins from --pins (else none)
//   --launcher   the Ronin Launcher pin (ronin-launcher: app/scripts/package-for-kingmaker.sh); required. Its zip must sit
//                beside the pin; it's checked against the pin and copied into the release folder
//   --notarize   notarize + staple the app first (needs a Developer ID signature and KINGMAKER_NOTARY_PROFILE, a
//                `xcrun notarytool store-credentials` profile); refuses otherwise rather than pretend
//   --sign-key   the OFFLINE release-signing private key (or env KINGMAKER_RELEASE_SIGNING_KEY). Signs the manifest's
//                bytes → kingmaker-manifest.json.sig, which the installer verifies against the pinned public key
//                (lib/kingmaker-release-public.pem). Without it the release is written unsigned and the output says so.
//
// The manifest it writes is also what scripts/build-installer.sh embeds in Kingmaker Installer.app.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Ronin's signing check needs its private tooling; without it (the public repo) every app counts as unverified.
const { verifyKingmakerSignature } = await import('./kingmaker-mac-signing.mjs').catch(() => ({ verifyKingmakerSignature: () => ({ ok: false, adhoc: false }) }));
import { buildManifest, cleanTempParts, DEFAULT_REPO, MANIFEST_FILE, MAX_PART_BYTES, sha256sums, splitStream, verifyParts } from '../lib/release-manifest.mjs';
import { signManifestBytes, verifyManifestBytes, pubkeyFingerprint } from '../lib/release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from '../lib/release-pubkey.mjs';
import { PACKS } from '../lib/mac-profiles.mjs';
import { ABLITERATED_CODERS, ABLITERATED_LARGE_BRAIN, ABLITERATED_MODELS, BRAIN_ROLES, LARGE_BRAIN_MIN_GB, LARGE_CODER_MIN_GB } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

export const BREW_TOOLS = Object.freeze([
  { formula: 'openclaw/tap/peekaboo', bin: 'peekaboo', label: 'Hands of Horus (Peekaboo)', minMacos: '15.0' },   // upstream needs 15
  { formula: 'sox', bin: 'sox', label: 'microphone capture (sox)' },
  { formula: 'python@3.12', check: 'python3.10+', label: 'Python for SearXNG' },
]);
export const CORPUS_SCRIPT = 'Contents/Resources/solomon-runtime/scripts/solomon-bootstrap-corpus.mjs';
export const SEARXNG_SCRIPT = 'Contents/Resources/solomon-runtime/scripts/solomon-searxng-native-setup.mjs';

function arg(argv, name, fallback = undefined) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
}

/** The models the installer pulls: every abliterated role model, plus the coder sized to the Mac it lands on. Pure. */
export function plannedModels() {
  const roles = {};
  for (const [role, model] of Object.entries(ABLITERATED_MODELS)) (roles[model] ??= []).push(role);
  return [
    ...Object.entries(roles).map(([name, r]) => ({ name, roles: r })),
    { name: ABLITERATED_CODERS.small, roles: ['SOLOMON_LOCAL_CODING_MODEL', 'SOLOMON_SNIPPET_MODEL'], maxMemGb: LARGE_CODER_MIN_GB },
    { name: ABLITERATED_CODERS.large, roles: ['SOLOMON_LOCAL_CODING_MODEL', 'SOLOMON_SNIPPET_MODEL'], minMemGb: LARGE_CODER_MIN_GB },
    { name: ABLITERATED_LARGE_BRAIN, roles: [...BRAIN_ROLES], minMemGb: LARGE_BRAIN_MIN_GB },
  ];
}

/** Every model the installer pulls: the engine's role models (above), then the packs' own. Pure. */
export function installerModels() {
  const base = plannedModels();
  return [...base, ...packModels(PACKS, base.map((m) => m.name))];
}

/** The profile packs' own models (lib/mac-profiles.mjs PACKS), each listing the packs it belongs to as "8,16": the
 *  installer pulls them only for the pack the owner picks. Models the engine's roles already pull are not repeated. Pure. */
export function packModels(packs = PACKS, base = plannedModels().map((m) => m.name)) {
  const out = new Map();
  for (const p of packs) for (const m of p.models) {
    if (base.includes(m.tag)) continue;
    const e = out.get(m.tag) ?? { name: m.tag, roles: [], packs: [] };
    e.roles = [...new Set([...e.roles, ...m.roles.map((r) => `pack:${r}`)])]; e.packs.push(p.id);
    out.set(m.tag, e);
  }
  return [...out.values()].map((e) => ({ ...e, packs: e.packs.join(',') }));
}

/** The packs as the installer's launcher shows them (lib/mac-profiles.mjs PACKS). Pure. */
export const manifestPacks = (packs = PACKS) => packs.map((p) => ({ id: p.id, name: p.name, label: p.label, downloadGb: p.downloadGb, features: p.features, models: p.models.map((m) => ({ name: m.tag, roles: m.roles, gb: m.gb })), basis: p.basis }));

/** "huihui_ai/qwen3-abliterated:1.7b" → its Ollama registry manifest URL; "hf.co/<user>/<repo>:<tag>" → Hugging
 *  Face's own registry, which is where Ollama pulls hf.co models from (registry.ollama.ai answers 404 for them). Pure. */
export function registryManifestUrl(name) {
  const [repo, tag = 'latest'] = String(name).split(':');
  if (/^hf\.co\//i.test(repo)) return `https://hf.co/v2/${repo.slice('hf.co/'.length)}/manifests/${tag}`;
  const path = repo.includes('/') ? repo : `library/${repo}`;
  return `https://registry.ollama.ai/v2/${path}/manifests/${tag}`;
}
/** Pure: the registry a model is pinned from, as the release log names it. */
export const registryHost = (name) => new URL(registryManifestUrl(name)).host;

async function fetchOk(url, { headers = {}, timeoutMs = 20_000 } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'kingmaker-release-parts', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

/** A model's pin from the registry: the sha256 of its manifest (what Ollama reports as its digest) and its size. */
export async function registryPin(name, fetcher = fetchOk) {
  const r = await fetcher(registryManifestUrl(name), { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  const body = Buffer.from(await r.arrayBuffer());
  const json = JSON.parse(body.toString('utf8'));
  const size = (json.layers ?? []).reduce((n, l) => n + (Number(l.size) || 0), Number(json.config?.size) || 0);
  return { digest: createHash('sha256').update(body).digest('hex'), size };
}

/** A GitHub release asset's pin, from the release API's own sha256 digest (no download). */
export async function githubAssetPin(repo, match, { version = 'latest', fetcher = fetchOk } = {}) {
  const url = version === 'latest' ? `https://api.github.com/repos/${repo}/releases/latest` : `https://api.github.com/repos/${repo}/releases/tags/${version}`;
  const release = await (await fetcher(url, { headers: { accept: 'application/vnd.github+json' } })).json();
  const asset = (release.assets ?? []).find((a) => match.test(a.name));
  if (!asset) throw new Error(`${repo} ${release.tag_name}: no asset matching ${match}`);
  const sha256 = String(asset.digest ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${repo} ${release.tag_name}: ${asset.name} has no published sha256 digest`);
  return { version: release.tag_name, name: asset.name, url: asset.browser_download_url, sha256, size: asset.size };
}

/** Tailscale's own official Mac package (Kingmaker Phone away from home), pinned the way the installer needs it: the
 *  current stable version from pkgs.tailscale.com, its .pkg downloaded and hashed here, and that hash checked against
 *  the .sha256 Tailscale publishes beside it. The installer fetches it from Tailscale; it is never redistributed. */
export async function tailscalePin({ fetcher = fetchOk, base = 'https://pkgs.tailscale.com/stable' } = {}) {
  const index = await (await fetcher(`${base}/?mode=json`, { headers: { accept: 'application/json' } })).json();
  const version = String(index.MacZipsVersion || index.Version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Tailscale's stable index gave no Mac version (${version || 'none'})`);
  const name = `Tailscale-${version}-macos.pkg`, url = `${base}/${name}`;
  const published = String(await (await fetcher(`${url}.sha256`)).text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(published)) throw new Error(`${name}: Tailscale published no sha256`);
  const bytes = Buffer.from(await (await fetcher(url, { timeoutMs: 180_000 })).arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== published) throw new Error(`${name}: downloaded sha256 ${sha256.slice(0, 12)}… does not match Tailscale's ${published.slice(0, 12)}…`);
  return { version, name, url, sha256, size: bytes.length };
}

async function localOllamaDigests() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(10_000) });
    return Object.fromEntries(((await r.json()).models ?? []).map((m) => [m.name, m.digest]));
  } catch { return {}; }
}

const plistJson = (file) => JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout || '{}');

/** What the app is: bundle id, version, engine build, signing authority, unpacked size. Throws when it is not Kingmaker. */
export const REQUIRED_RUNTIMES = Object.freeze(['solomon-runtime', 'voice-runtime', 'guardrails-runtime', 'guardrails-config', 'agent-runtime', 'knowledge-runtime', 'playwright-browsers', 'chrome-connector', 'sol-ghost', 'app.asar']);

export function inspectApp(app, { skipCodesign = false, allowAdhoc = false } = {}) {
  if (basename(app) !== 'Kingmaker.app') throw new Error(`${app} is not named Kingmaker.app`);
  const info = plistJson(join(app, 'Contents', 'Info.plist'));
  if (info.CFBundleIdentifier !== 'com.ronininc.solghost') throw new Error(`${app}: bundle id ${info.CFBundleIdentifier}, expected com.ronininc.solghost (kept so macOS permissions carry over)`);
  if (!existsSync(join(app, 'Contents', 'MacOS', String(info.CFBundleExecutable ?? '')))) throw new Error(`${app}: its executable ${info.CFBundleExecutable} is missing`);
  // Every runtime a full Kingmaker carries. A build from a checkout without the staged runtimes came out at 1.8 GB
  // instead of 4.0 GB with no agent or knowledge runtime (2026-10-09) and would have shipped a Kingmaker that can't
  // run its agent or knowledge base; a release refuses it.
  const missing = REQUIRED_RUNTIMES.filter((r) => !existsSync(join(app, 'Contents', 'Resources', r)));
  if (missing.length) throw new Error(`${app}: missing ${missing.join(', ')}; stage them (desktop/build/<runtime>) and rebuild`);
  // Kingmaker's own data beside its code, and proof the engine starts. 0.2.6 shipped without sol-ghost/vendor, catalog
  // and core (the engine build packaged only lib/, bin/, package.json) and its engine exited on start on every Mac that took it.
  const engine = join(app, 'Contents', 'Resources', 'sol-ghost');
  const lacking = ['lib', 'bin', 'vendor', 'catalog', 'core', 'assets', 'package.json'].filter((p) => !existsSync(join(engine, p)));
  if (lacking.length) throw new Error(`${app}: its engine (Contents/Resources/sol-ghost) has no ${lacking.join(', ')}; Kingmaker cannot start without them`);
  // The one payload file's list: without it an installed Kingmaker refuses to start (lib/payload.mjs), so a build that
  // copied Kingmaker's parts instead of unpacking kingmaker-payload.tar is refused here, not on the owner's Macs.
  if (!existsSync(join(engine, 'payload.json'))) throw new Error(`${app}: its engine has no payload.json; build it from the one payload file (node scripts/build-payload.mjs, then unpack kingmaker-payload.tar into Contents/Resources)`);
  if (process.platform === 'darwin') {
    const started = spawnSync(join(engine, 'bin', 'kingmaker'), ['version'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    if (started.status !== 0) throw new Error(`${app}: its engine does not start (kingmaker version exited ${started.status}): ${String(started.stderr || started.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  }
  let signing = 'unchecked';
  if (!skipCodesign) {
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
    if (verify.status !== 0) throw new Error(`${app}: codesign --verify --deep --strict failed: ${String(verify.stderr).trim().split('\n').slice(-2).join(' | ')}`);
    const details = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr;
    const authority = /^Authority=(.+)$/m.exec(details)?.[1];
    signing = authority ?? (/Signature=adhoc/.test(details) ? 'ad-hoc' : 'unknown');
    const stable = verifyKingmakerSignature(app);
    // A release is signed by the pinned Kingmaker Release certificate (lib/release-identity.mjs), so every owner's
    // macOS permissions carry over from one update to the next.
    if (!allowAdhoc && !stable.pinned) throw new Error('no Kingmaker Release certificate is pinned: make it once with node scripts/kingmaker-release-identity.mjs create, then sign with it (node scripts/kingmaker-mac-signing.mjs --sign <app>)');
    if (!allowAdhoc && !stable.pinMatches) throw new Error(`${app} is signed by ${stable.leaf ?? 'no certificate'}, not the pinned Kingmaker Release certificate ${stable.pinned}: sign it with node scripts/kingmaker-mac-signing.mjs --sign <app>`);
    if (!allowAdhoc && !stable.ok) {
      throw new Error(`${app}: its macOS privacy identity is not stable (${stable.adhoc ? 'ad-hoc cdhash' : 'no certificate-based designated requirement'}). Rebuild with the owner's existing local signing certificate; an ad-hoc release makes macOS ask for permissions again after every update.`);
    }
  }
  const du = spawnSync('du', ['-sk', app], { encoding: 'utf8' });
  return { bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString ?? PKG.version, solomonBuild: info.SolomonRuntimeBuild ?? null, signing, unpackedBytes: Number(String(du.stdout).split('\t')[0]) * 1024 || null };
}

/** The confirmed corpora the installer fetches, read from the app's own copy of the bootstrap script. */
export async function knowledgePlan(app) {
  const script = join(app, CORPUS_SCRIPT);
  if (!existsSync(script)) return null;
  const { TIER1 } = await import(pathToFileURL(script).href);
  const corpora = (TIER1 ?? []).filter((e) => e.confirmed && e.license).map((e) => ({ id: e.id, field: e.field, sizeMB: e.sizeMB }));
  return { script: CORPUS_SCRIPT, corpora, totalMB: corpora.reduce((n, c) => n + (Number(c.sizeMB) || 0), 0) };
}

export function searxngPlan(app) {
  const script = join(app, SEARXNG_SCRIPT);
  if (!existsSync(script)) return null;
  const pin = /SEARXNG_PIN = '([0-9a-f]{40})'/.exec(readFileSync(script, 'utf8'))?.[1] ?? null;
  return { script: SEARXNG_SCRIPT, pin };
}

/** Notarize + staple, only when it can be real. → { ok, line }. */
export function notarizeApp(app, { env = process.env, run = spawnSync } = {}) {
  const profile = String(env.KINGMAKER_NOTARY_PROFILE ?? '').trim();
  if (!profile) return { ok: false, line: 'Not notarized: set KINGMAKER_NOTARY_PROFILE to a `xcrun notarytool store-credentials` profile (an Apple Developer account is needed).' };
  const details = run('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' }).stderr ?? '';
  if (!/^Authority=Developer ID Application:/m.test(details)) return { ok: false, line: `Not notarized: ${basename(app)} is not signed with a Developer ID Application identity (${/^Authority=(.+)$/m.exec(details)?.[1] ?? 'ad-hoc'}). Re-sign it (the engine build's signer, with SOLOMON_SIGNING_IDENTITY) first.` };
  const zip = `${app}.notarize.zip`;
  for (const [cmd, args] of [['ditto', ['-c', '-k', '--keepParent', app, zip]], ['xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait']], ['xcrun', ['stapler', 'staple', app]]]) {
    const r = run(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) return { ok: false, line: `Notarization failed at: ${cmd} ${args.slice(0, 2).join(' ')}` };
  }
  return { ok: true, line: `Notarized and stapled ${basename(app)}.` };
}

export async function main({ argv = process.argv.slice(2), env = process.env, out: print = console.log, offlineDigests = localOllamaDigests, fetcher = fetchOk } = {}) {
  const dryRun = argv.includes('--dry-run');
  const offline = argv.includes('--offline');
  const engineSrc = env.KINGMAKER_ENGINE_SRC ? resolve(env.KINGMAKER_ENGINE_SRC) : null; // the engine's source checkout
  if (!engineSrc && !arg(argv, '--app', null)) { print('✗ Give --app <Kingmaker.app>, or set KINGMAKER_ENGINE_SRC to the engine source checkout that builds it.'); return 1; }
  const app = resolve(arg(argv, '--app', engineSrc && join(engineSrc, 'desktop', 'dist-ghost', 'Kingmaker.app')));
  const partSize = Number(arg(argv, '--part-size', MAX_PART_BYTES));
  const level = Math.min(9, Math.max(1, Number(arg(argv, '--level', 6)) || 6));
  if (!existsSync(app)) { print(`✗ No Kingmaker.app at ${app}. Build it first with the engine build: cd ${engineSrc ?? '<engine source>'} && SOL_GHOST_SOURCE=${ROOT} npm run package:ghost`); return 1; }
  let facts;
  try { facts = inspectApp(app, { skipCodesign: argv.includes('--skip-codesign'), allowAdhoc: env.KINGMAKER_ALLOW_ADHOC === '1' }); } catch (error) { print(`✗ ${error.message}`); return 1; }
  const tag = arg(argv, '--tag', `v${facts.version}`);
  const outDir = resolve(arg(argv, '--out', join(ROOT, 'dist', 'release', tag)));
  if (argv.includes('--notarize')) {
    const n = notarizeApp(app, { env });
    print(n.ok ? `✓ ${n.line}` : `✗ ${n.line}`);
    if (!n.ok) return 1;
  }
  print(`Kingmaker ${facts.version} (engine build ${facts.solomonBuild ?? '?'}, signed: ${facts.signing}, ${(facts.unpackedBytes / 1e9).toFixed(2)} GB unpacked)`);
  print(dryRun ? '· dry run: hashing the archive as it streams; no part is written' : `· writing parts of at most ${(partSize / 1e9).toFixed(2)} GB into ${outDir}`);

  // Pins for what the installer fetches besides the app.
  const models = installerModels();
  const local = await offlineDigests();
  let ollama = null;
  let homebrew = null;
  let tailscale = null;
  if (offline) {
    const pins = arg(argv, '--pins') ? JSON.parse(readFileSync(arg(argv, '--pins'), 'utf8')) : {};
    ollama = pins.ollama ?? null;
    homebrew = pins.homebrew ?? null;
    tailscale = pins.tailscale ?? null;
    for (const m of models) { m.digest = local[m.name] ?? null; m.size = null; m.pinnedFrom = m.digest ? 'this Mac\'s Ollama' : 'none (offline)'; }
  } else {
    try {
      ollama = await githubAssetPin('ollama/ollama', /^Ollama-darwin\.zip$/, { version: arg(argv, '--ollama-version', 'latest'), fetcher });
      homebrew = await githubAssetPin('Homebrew/brew', /^Homebrew.*\.pkg$/, { fetcher });
      tailscale = await tailscalePin({ fetcher });
      for (const m of models) {
        const pin = await registryPin(m.name, fetcher);
        Object.assign(m, pin, { pinnedFrom: registryHost(m.name) });
        if (local[m.name]) m.thisMacMatches = local[m.name] === pin.digest;
      }
    } catch (error) { print(`✗ Could not pin the installer's downloads: ${error.message} (use --offline with --pins to build without network)`); return 1; }
  }
  for (const m of models) print(`· model ${m.name}: ${m.digest ? `${m.digest.slice(0, 12)}…` : 'NOT pinned'}${m.size ? ` (${(m.size / 1e9).toFixed(2)} GB)` : ''}${m.thisMacMatches === false ? ' (this Mac has a different revision)' : ''}`);
  print(`· Ollama: ${ollama ? `${ollama.version} ${ollama.name} sha256 ${ollama.sha256.slice(0, 12)}…` : 'not pinned (an installer can only use an Ollama that is already there)'}`);
  print(`· Homebrew: ${homebrew ? `${homebrew.version} ${homebrew.name} sha256 ${homebrew.sha256.slice(0, 12)}…` : 'not pinned'}`);
  print(`· Tailscale: ${tailscale ? `${tailscale.version} ${tailscale.name} sha256 ${tailscale.sha256.slice(0, 12)}…` : 'not pinned (Kingmaker Phone stays home-Wi-Fi only)'}`);
  const knowledge = await knowledgePlan(app);
  const searxng = searxngPlan(app);
  print(`· knowledge library: ${knowledge ? `${knowledge.corpora.length} confirmed corpora, ${(knowledge.totalMB / 1024).toFixed(1)} GB` : 'no bootstrap script in this app'}`);

  // THE RONIN LAUNCHER (required): its pin, and its zip checked against it and carried in the same release.
  const pinFile = arg(argv, '--launcher');
  if (!pinFile) { print('✗ --launcher <ronin-launcher-pin.json> is required: the Ronin Launcher installs with Kingmaker.'); return 1; }
  let launcher;
  try {
    launcher = JSON.parse(readFileSync(pinFile, 'utf8'));
    const zip = join(dirname(resolve(pinFile)), String(launcher.archive));
    const bytes = readFileSync(zip), got = createHash('sha256').update(bytes).digest('hex');
    if (got !== launcher.sha256 || bytes.length !== launcher.size) throw new Error(`${launcher.archive} is ${bytes.length} bytes, sha256 ${got.slice(0, 12)}…, not the pin's`);
    if (!dryRun) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, launcher.archive), bytes); }
    print(`· Ronin Launcher ${launcher.version}: ${launcher.archive} ${(launcher.size / 1e6).toFixed(1)} MB, sha256 ${launcher.sha256.slice(0, 12)}…`);
  } catch (error) { print(`✗ The Ronin Launcher pin doesn't check out: ${error.message}`); return 1; }

  // The archive, streamed straight into the parts.
  const archive = `Kingmaker-${facts.version}.tar.gz`;
  if (!dryRun) { mkdirSync(outDir, { recursive: true }); cleanTempParts(outDir); }
  const tar = spawn('tar', ['-c', '-z', '--xattrs', '--options', `gzip:compression-level=${level}`, '-f', '-', '-C', dirname(app), basename(app)], { env: { ...env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tarErr = '';
  tar.stderr.on('data', (d) => { tarErr += d; });
  const tarExit = new Promise((r) => tar.once('exit', (code) => r(code)));
  let split;
  try { split = await splitStream(tar.stdout, { partSize, outDir: dryRun ? null : outDir, archive }); } catch (error) {
    tar.kill('SIGTERM');
    if (!dryRun) cleanTempParts(outDir);
    print(`✗ Splitting the archive failed: ${error.message}`);
    return 1;
  }
  if ((await tarExit) !== 0) { print(`✗ tar failed: ${tarErr.trim().slice(-300)}`); return 1; }
  // Pin the install/update engine's sha256 in the (signed) manifest, so the installed app can authenticate the engine
  // it downloads before running it. This is the SAME engine.sh publish-update.sh ships; it verifies the match.
  const engineSha256 = createHash('sha256').update(readFileSync(join(ROOT, 'installer', 'engine.sh'))).digest('hex');
  const manifest = buildManifest({
    version: facts.version, tag, repo: arg(argv, '--repo', DEFAULT_REPO),
    app: facts, archive: { name: archive, size: split.size, sha256: split.sha256 }, parts: split.parts, partSize,
    ollama, homebrew, tailscale, models, brew: BREW_TOOLS, knowledge, searxng, packs: manifestPacks(), launcher, engineSha256,
  });
  for (const p of split.parts) print(`· ${p.name}  ${(p.size / 1e9).toFixed(3)} GB  sha256 ${p.sha256}`);
  print(`· whole archive ${archive}: ${(split.size / 1e9).toFixed(3)} GB, sha256 ${split.sha256}`);
  if (dryRun) {
    print('--- kingmaker-manifest.json (dry run, not written) ---');
    print(JSON.stringify(manifest, null, 2));
    return 0;
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(outDir, MANIFEST_FILE), manifestText);

  // Sign the manifest's exact bytes with the OFFLINE release key, so the installer and the running app can prove this
  // release is the operator's and not a swapped one from a compromised host. Mirrors the notarize posture: nothing is
  // faked — with no key, the release is written unsigned and the line says so plainly.
  const sigName = `${MANIFEST_FILE}.sig`;
  const sigPath = join(outDir, sigName);
  // Never leave a stale signature from an earlier run beside a freshly written manifest: build-installer.sh embeds
  // any .sig it finds, so a leftover would make a supposedly-unsigned (or re-signed) installer carry an invalid
  // signature and refuse to install. Clear it first; a successful sign below writes a fresh one.
  if (existsSync(sigPath)) rmSync(sigPath);
  const keyPath = arg(argv, '--sign-key', env.KINGMAKER_RELEASE_SIGNING_KEY);
  if (keyPath) {
    let keyPem;
    try { keyPem = readFileSync(keyPath, 'utf8'); } catch (error) { print(`✗ Could not read the release-signing key at ${keyPath}: ${error.message}`); return 1; }
    const sig = signManifestBytes(Buffer.from(manifestText), keyPem);
    if (!verifyManifestBytes(Buffer.from(manifestText), sig, RELEASE_PUBLIC_KEY_PEM)) {
      print('✗ The signature this key produced does not verify against the pinned public key (lib/kingmaker-release-public.pem). Wrong key, or the pinned key was rotated without re-pinning. Not written.');
      return 1;
    }
    writeFileSync(join(outDir, sigName), sig);
    print(`✓ Manifest signed → ${sigName} (verifies against pinned key, fingerprint ${pubkeyFingerprint(RELEASE_PUBLIC_KEY_PEM)})`);
  } else {
    print('! NOT signed: set KINGMAKER_RELEASE_SIGNING_KEY (or pass --sign-key) to the OFFLINE private key so the installer can verify this release. Unsigned releases still install, but the installer cannot prove they are yours.');
  }

  writeFileSync(join(outDir, 'SHA256SUMS'), sha256sums([...split.parts, { name: launcher.archive, sha256: launcher.sha256 }, { name: MANIFEST_FILE, sha256: createHash('sha256').update(manifestText).digest('hex') }]));
  const check = await verifyParts(manifest, outDir);
  if (!check.ok) { print(`✗ The parts just written do not verify: ${check.problems.join('; ')}`); return 1; }
  print(`✓ ${split.parts.length} part(s) + ${MANIFEST_FILE} + SHA256SUMS in ${outDir}, re-read and verified.`);
  print('Not published. To publish (the operator\'s call):');
  const sigAsset = keyPath ? ` ${JSON.stringify(join(outDir, sigName))}` : '';
  print(`  gh release create ${tag} --repo ${manifest.repo} --draft --title "Kingmaker ${facts.version}" ${split.parts.map((p) => JSON.stringify(join(outDir, p.name))).join(' ')} ${JSON.stringify(join(outDir, launcher.archive))} ${JSON.stringify(join(outDir, MANIFEST_FILE))}${sigAsset} ${JSON.stringify(join(outDir, 'SHA256SUMS'))} "<Kingmaker Installer DMG>"`);
  print(`Then build the installer around this manifest: scripts/build-installer.sh --manifest ${join(outDir, MANIFEST_FILE)}`);
  return 0;
}

function invokedDirectly() {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
}
if (invokedDirectly()) main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
