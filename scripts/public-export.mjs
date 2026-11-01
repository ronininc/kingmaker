#!/usr/bin/env node
// The public, source-available Kingmaker: this checkout's tree (working copy, tracked and new files, never ignored
// ones) without Solomon's source or the operator's own material, checked for leaks, as ONE commit in a NEW repository.
// No history comes along, so nothing ever committed here (old imports, authors, branches, PRs) goes public with it.
//
//   node scripts/public-export.mjs --out <empty dir> [--test]     build it (and run its tests there)
//   node scripts/public-export.mjs --check                        only the leak gate, over what would be exported
//
// The owner's rule (2026-10-16): no TSS source in the public repo. Nothing here creates a GitHub repo or pushes:
// publishing is the operator's own step, after reading what this wrote.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What never goes public, with why. A path ending in / is a folder. */
export const EXCLUDE = Object.freeze({
  'solomon/': "Solomon's (TSS) source: private, by the owner's rule",
  'addons/': 'paid Ronin Launcher add-ons (the Ronin CRM, its desks and offices, CRM AI features): never in the free release',
  'solomon-strip.json': 'the TSS import manifest',
  'scripts/import-solomon.mjs': 'imports TSS source',
  'scripts/public-export.mjs': 'this exporter (operator tooling)',
  'docs/OPERATOR.md': 'operator-only: release builds from TSS, the TSS import, the owner\'s own offices',
  'docs/OWNER-CALL.md': "written to the owner, about the owner's own phone setup",
  'docs/iphone-bridge.md': "written to the owner, about the owner's own iPhone",
  'docs/RONIN-OS.md': 'an unannounced product design (the owner decides when it is public)',
  'scripts/mint-entitlement.mjs': "the owner's tool: mints Ronin add-on entitlements with Ronin's private install-certificate key",
  'scripts/owner-install-ronin-addon.mjs': "the owner's one-command install of the paid Ronin add-on",
  'test/owner-addon-tools.test.mjs': 'tests the owner add-on tooling',
  'scripts/kingmaker-mac-signing.mjs': "the owner's local signing identity; it needs TSS's signing scripts",
  'test/mac-signing.test.mjs': 'tests that signing tooling',
  'test/import.test.mjs': 'tests the TSS import',
  'test/public-export.test.mjs': 'tests this exporter',
  '.github/workflows/deploy-update-host.yml': "deploys the owner's own update host with the owner's Cloudflare secrets",
  'scripts/import-skills.mjs': "reads the owner's own skill folders (operator tooling)",
  'scripts/import-ronin-skills.sh': "copies skills out of the owner's own Claude account and names a client",
  'scripts/build-fleet-vendor.sh': 'builds vendor/fleet from a TSS checkout',
  'scripts/publish-update.sh': "publishes to the owner's private update bucket",
  'docs/BUILD-ORDER-local-media-gen.md': 'an internal build proposal, nothing in it is built',
});
export const excluded = (path) => Object.keys(EXCLUDE).some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

/**
 * The leak gate: text no public file may carry. Each rule has the files it is allowed in (with why), so a hit is
 * either fixed or allowed on purpose, never waved through.
 */
export const RULES = Object.freeze([
  { id: 'personal-email', re: /robbiebrown2026|yordan@|yordanrivera@/i },
  { id: 'home-path', re: /\/Users\/(?!o\/|o\b|me\/|you\/|owner\/|someone\/|x\/|test\/|runner\/|alice\/|bob\/|user\/|username\/|nobody\/|<)[a-z][a-z0-9._-]{1,}\/|C:[\\/]+Users[\\/]+(?!you\b|work\b|user\b|alice\b)[a-z]/i , allow: { 'core/skills/deepcamera/skills/analysis/home-security-benchmark/scripts/run-benchmark.cjs': "an upstream developer's example path in SharpAI's MIT code" } },
  { id: 'hostname', re: /\b(?:Robbies?-MacBook[-\w]*|yordans?-MacBook[-\w]*|yordanrivera@MacBook[-\w.]*)\b/i },
  { id: 'client-name', re: /Cultura Mía|Cultura Mia|La Barquita|Long Wong|Sushi-To|Twoo Sweet|\bSLIK\b|Valley Titans|La Tiendita|Don José|Don Jose Birrier|Midnight Taco|Solitude (?:Boutique )?Salon|lacarretadelily|la-carreta/ },
  { id: 'phone', re: /\(?602\)?[ .-]?396[ .-]?2995/ },
  { id: 'private-repo-line', re: /repo is private|while the repo is private|private until the operator makes it public/i },
  { id: 'old-name', re: /Sol Ghost/, allow: {
    'lib/keychain-seal.mjs': 'the Keychain service name an enrolled voiceprint is sealed under; renaming it orphans every enrolled print',
    'README.md': 'names that Keychain item, so an owner can find it',
    'lib/ring.mjs': 'finds an older "Sol Ghost.app" menu bar agent to replace it',
    'install.sh': 'finds and replaces an older "Sol Ghost.app"',
    'installer/engine.sh': 'finds, quits and trashes an older "Sol Ghost.app" when installing over it',
    'scripts/build-app.sh': 'replaces an older "Sol Ghost.app" in ~/Applications',
    'app/bundle.json': 'legacyAppNames: the old app name the installer replaces',
    'lib/cli.mjs': 'the legacy wake word an uncemented install still answers to, and the old solghost:// link',
    'lib/install-config.mjs': 'the legacy wake word an uncemented install still answers to',
    'lib/voice.mjs': 'the legacy wake word an uncemented install still answers to',
    'lib/duress.mjs': 'the voiceprint Keychain item it destroys, by its real name',
    'test/': 'tests that pin the legacy behaviour above',
  } },
  { id: 'secret', re: /sk-ant-api\d\d-[A-Za-z0-9_-]{80,}|sk-proj-[A-Za-z0-9_-]{80,}|\bghp_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{60,}|\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{200,}/ },
  { id: 'cloudflare-account', re: /7e8cd2[0-9a-f]{26}/ },
  // The paid Ronin add-on stays out (the owner, 2026-10-16): no Ronin or Orosolu CRM access, no Mia persona.
  // The one ronininc.org API the free app calls is community learning (api/kingmaker/community), a licence condition.
  { id: 'ronin-crm', re: /ronininc\.org\/(?:api(?!\/kingmaker\/community\b)|mcp|admin)\b|www\.ronininc\.org['"`]|ronin-crm-prod|KINGMAKER_DESK_TOKEN|\bronin_(?:dnc|desk|ownercall|seeker|approver|solomon|local|king|capital)_|RONIN_CRM_(?:URL|MCP|TOKEN)/ },
  { id: 'orosolu', re: /orosolu/i },
  { id: 'mia-persona', re: /\bMia\b|mia_inbox/, allow: { 'catalog/huggingbay.json': 'third-party model names in the public Hugging Bay index' } },
  // Kingmaker only (the owner, 2026-10-17): Solomon/TSS is the private flagship, so the public tree never names it.
  // Kingmaker's abilities are its own. What `except` lets through is the engine's interface, names the bundled
  // engine reads or writes (its env vars, folders and files inside Kingmaker.app, its data and vault folders): renaming
  // one here without the engine's build renaming it too breaks the app.
  { id: 'solomon-name', re: /solomon|\bTSS\b/i, except: new RegExp([
    /\bSOLOMON_[A-Z0-9_*<>]*/, // the engine's environment variables (and SOLOMON_* when docs name them as a family)
    /\.[Ss]olomon(?:-secure)?\b/, // its data folder (refused, never read) and its credentials vault
    /\bsolomon-(?:runtime|build\.json|speaker-id|wake-keywords\.txt|desktop|google-browser|server|update-manifest\.json|system-tts|package-ghost)\b|\bsolomon-\(?(?:index|extract)(?:\|extract\))?-knowledge\\?\.mjs/, // its parts, files and processes
    /MacOS\/Solomon\b|'MacOS', 'Solomon'|\["KingmakerEngine", "Solomon"\]|RUNTIME_BINARY = 'Solomon'|\bSolomonRuntimeBuild\b|\bx-solomon-(?:desktop-nonce|voice-attestation)\b|\bsendToSolomon\b/, // the engine binary, its build key, headers, page hook
    /\bsolomon-[a-z0-9-]+\.mjs\b/, // its bundled scripts (solomon-runtime/scripts/*)
    /\bsolomonResponse\b|\bsolomonBuild\b|\bsolomon\.fleet-(?:receipt|contribution)\.v1\b|Solomon runtime listening on|'Solomon Chrome Connector'/, // its JSON keys, fleet schema ids, ready line, connector folder
    /\bsoftware solomon something\b/, // one word of the vendored fleet classifier's vocabulary (vendor/fleet, generated)
    /\bcom\.ronin\.solomon\b|\bSolomon\.app\b/, // the desktop app, recognised so Kingmaker never fights it for a folder or port
    /\bhey_solomon\b|\basolomonqa\b/, // the desktop spotter's keyword id; a third-party model id
    /FORK_DIR = 'solomon'|\$here\/solomon\b/, // lib/fork.mjs, bin/kingmaker, install.sh: where an operator checkout carries the engine's source
  ].map((r) => r.source).join('|'), 'g') },
]);

/** Pure: the public package.json: no npm script that reaches into an add-on, and the test run over the core only. */
export function publicPackageJson(text) {
  const pkg = JSON.parse(text);
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
    if (k === 'test') pkg.scripts.test = String(v).replace(/\s+"addons\/[^"]*"/g, '');
    else if (/addons\//.test(String(v))) delete pkg.scripts[k];
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Every file the export would carry, from git: tracked and new, never ignored, never excluded, still on disk. */
export function exportFiles(dir = root) {
  const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => !excluded(p) && existsSync(join(dir, p)) && statSync(join(dir, p)).isFile()).sort();
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

/** Pure over its reader: the gate's hits over those files → [{ id, file, line, text }]. */
/** A file as the export writes it (package.json is rewritten). */
const exported = (p) => (p === 'package.json' ? Buffer.from(publicPackageJson(readFileSync(join(root, p), 'utf8'))) : readFileSync(join(root, p)));

export function leakHits(files, read = exported) {
  const hits = [];
  for (const file of files) {
    const buf = read(file);
    if (!isText(buf)) continue;
    const text = buf.toString('utf8');
    for (const rule of RULES) {
      if (rule.allow && Object.keys(rule.allow).some((a) => (a.endsWith('/') ? file.startsWith(a) : a === file))) continue;
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      const spans = rule.except ? [...text.matchAll(rule.except)].map((m) => [m.index, m.index + m[0].length]) : [];
      for (const m of text.matchAll(re)) {
        if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({ id: rule.id, file, line, text: text.split('\n')[line - 1].trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

/** Files the export carries that still import something it leaves out (it would not run). */
export function danglingImports(files, read = (p) => readFileSync(join(root, p), 'utf8')) {
  const out = [];
  for (const file of files.filter((f) => /\.(mjs|js|cjs)$/.test(f))) {
    const text = read(file);
    for (const m of text.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = join(dirname(file), m[1]).replace(/\\/g, '/');
      if (excluded(target)) out.push({ file, imports: m[1] });
    }
  }
  return out;
}

function main(argv) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const files = exportFiles();
  const hits = leakHits(files), dangling = danglingImports(files);
  console.log(`${files.length} files to export; left out: ${Object.keys(EXCLUDE).join(', ')}`);
  for (const d of dangling) console.log(`✗ ${d.file} imports ${d.imports}, which is not exported`);
  for (const h of hits) console.log(`✗ ${h.id}  ${h.file}:${h.line}  ${h.text}`);
  if (hits.length || dangling.length) { console.log(`\nLeak gate: ${hits.length} hit(s), ${dangling.length} dangling import(s). Nothing exported.`); return 1; }
  console.log('Leak gate: clean.');
  if (argv.includes('--check')) return 0;
  const out = arg('--out');
  if (!out) { console.error('usage: node scripts/public-export.mjs --out <empty dir> [--test] | --check'); return 2; }
  const dest = resolve(out);
  if (existsSync(dest) && readdirSync(dest).length) { console.error(`✗ ${dest} is not empty.`); return 2; }
  for (const f of files) {
    const from = join(root, f), to = join(dest, f), st = lstatSync(from);
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to); // bin/sol-ghost → kingmaker stays a link
    else if (f === 'package.json') writeFileSync(to, publicPackageJson(readFileSync(from, 'utf8')));
    else { copyFileSync(from, to); chmodSync(to, st.mode & 0o777); }
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const who = { GIT_AUTHOR_NAME: 'Ronin Inc.', GIT_AUTHOR_EMAIL: '273172618+ronininc@users.noreply.github.com', GIT_COMMITTER_NAME: 'Ronin Inc.', GIT_COMMITTER_EMAIL: '273172618+ronininc@users.noreply.github.com' };
  const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...who }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', `Kingmaker ${version}: source-available release`);
  console.log(`✓ ${dest}: one commit (${git('rev-parse', '--short', 'HEAD').trim()}), ${files.length} files, author Ronin Inc. Not pushed.`);
  if (argv.includes('--test')) {
    const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...readdirSync(join(dest, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => join('test', f))], { cwd: dest, encoding: 'utf8' });
    const tail = `${r.stdout}`.split('\n').filter((l) => /^ℹ (tests|pass|fail|skipped)|^✖/.test(l));
    for (const l of tail) console.log(l);
    return r.status === 0 ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
