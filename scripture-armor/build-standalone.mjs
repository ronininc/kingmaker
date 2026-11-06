#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyPrerequisites } from './prerequisite-readiness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_COMPONENTS = [
  'armor.mjs', 'vaultd.mjs', 'cell.mjs', 'airlock.mjs', 'scan.mjs', 'launch.mjs',
  'terms.mjs', 'open-standalone.mjs', 'dashboard.mjs', 'dashboard-view.mjs', 'credential-vault.mjs',
  'entitlement-client.mjs', 'account-session.mjs', 'account-session-store.mjs', 'installation-health.mjs', 'activation-flow.mjs', 'paid-activation.mjs',
  'refit-net.mjs', 'package.json', 'README.md', 'FORMAT.md', 'LICENSE',
  'product-paths.mjs', 'product.json', 'vault-paths.mjs', 'prerequisite-readiness.mjs',
  'installation-metadata.mjs', 'protection-status.mjs', 'analysis-runtime.mjs',
  'protection-feed.mjs', 'agnostic-review.mjs', 'format-inspect.mjs', 'review-worker.mjs', 'review-presentation.mjs', 'review-intake.mjs', 'repository-review.mjs', 'repository-stream.mjs', 'review-controls.mjs', 'review-ejection.mjs', 'sandbox-review.mjs', 'sandbox-review-linux.mjs', 'linux-review-inner.sh', 'device-protection.mjs', 'device-scan-roots.json', 'key-transition.mjs', 'retired-key-recovery.mjs', 'rotation-candidate.mjs',
  'dns-profiles', 'ghidra-scripts', 'mac', 'linux', 'windows', 'ui',
  'ghidra-prune-manifest.json',
];
export function buildStandalone(args = process.argv.slice(2)) {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const out = path.resolve(opt('--out') || 'dist/scripture-armor');
  const ghidraHome = opt('--ghidra-home') || process.env.SCRIPTURE_GHIDRA_HOME;
  const jdkHome = opt('--jdk-home') || process.env.SCRIPTURE_JDK_HOME || process.env.JAVA_HOME;
  const reaDir = path.resolve(opt('--rea-dir') || path.join(HERE, '..', 'lib'));
  const readiness = verifyPrerequisites({ ghidraHome, jdkHome });

  if (!ghidraHome || !fs.existsSync(path.join(ghidraHome, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless'))) {
    throw new Error('release refused: a runnable Ghidra home is required (--ghidra-home or SCRIPTURE_GHIDRA_HOME)');
  }
  if (!jdkHome || !fs.existsSync(path.join(jdkHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    throw new Error('release refused: a runnable JDK is required (--jdk-home, SCRIPTURE_JDK_HOME, or JAVA_HOME)');
  }
  for (const file of ['rea.mjs', 'rea-rules.mjs']) {
    if (!fs.existsSync(path.join(reaDir, file))) throw new Error(`release refused: REA component missing: ${file}`);
  }
  if (fs.existsSync(out)) throw new Error(`release refused: output already exists: ${out}`);


  stageStandaloneSources(out, { reaDir });
  copyRuntime(ghidraHome, path.join(out, 'tools', 'ghidra'), { cloneRuntimes: args.includes('--clone-runtimes') });
  // Route B (2026-11-05): the staged Ghidra is pruned per the manifest kept
  // as data beside this builder. The source Ghidra home is never modified —
  // the Mac native build compiles from it before staging — and the JDK copy
  // is unchanged (the bundled JDK is pre-signed upstream and drew no flags).
  const prune = applyGhidraPrune(path.join(out, 'tools', 'ghidra'));
  console.log(`ghidra prune: removed ${prune.removedFiles} files, ${prune.removedBytes} bytes (${prune.entries} manifest entries, ${prune.skippedIfPresent} build-product entries absent)`);
  copyRuntime(jdkHome, path.join(out, 'tools', 'jdk'), { cloneRuntimes: args.includes('--clone-runtimes') });

  const records = collectBundleRecords(out);
  const required = [
    'armor.mjs', 'vaultd.mjs', 'dashboard.mjs', 'credential-vault.mjs', 'scan.mjs',
    'entitlement-client.mjs', 'account-session.mjs', 'account-session-store.mjs', 'installation-health.mjs', 'activation-flow.mjs', 'paid-activation.mjs',
    'rea/rea.mjs', 'rea/rea-rules.mjs', 'lib/keychain-seal.mjs', 'ghidra-scripts/ScriptureScan.java',
    'ui/scripture-armor-crest-ronin.png',
    'mac/ScriptureArmorApp.swift', 'mac/build-native-app.sh',
  ];
  for (const rel of required) if (!records.some((r) => r.path === rel && r.size > 0)) throw new Error(`release refused: empty or missing component: ${rel}`);
  if (!records.some((r) => /(^|\/)support\/analyzeHeadless(\.bat)?$/.test(r.path) && r.size > 0)) throw new Error('release refused: packaged Ghidra analyzeHeadless missing');
  if (!records.some((r) => /(^|\/)tools\/jdk\/bin\/java(\.exe)?$/.test(r.path) && r.size > 0)) throw new Error('release refused: packaged JDK java missing');
  const manifest = { schema: 'scripture-armor.standalone-bundle/1', version: '1.2.1', product: 'standalone', prerequisites: readiness, files: records.sort((a, b) => a.path.localeCompare(b.path)) };
  fs.writeFileSync(path.join(out, 'BUNDLE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`built ${out}: ${records.length} verified files`);

}

export function stageStandaloneSources(out, { reaDir = path.join(HERE, '..', 'lib') } = {}) {
  if (fs.existsSync(out)) throw new Error('release refused: source output already exists: ' + out);
  fs.mkdirSync(out, { recursive: true });
  for (const rel of SOURCE_COMPONENTS) {
    const source = path.join(HERE, rel);
    if (!fs.existsSync(source)) throw new Error(`release refused: mandatory component missing: ${rel}`);
    fs.cpSync(source, path.join(out, rel), { recursive: true, errorOnExist: true });
  }
  // The source checkout is Kingmaker-bundled; the independent distribution has
  // its own explicit, shipped product policy instead of rewriting key paths.
  fs.writeFileSync(path.join(out, 'product.json'), JSON.stringify({ schema: 'scripture-armor.product/1', product: 'standalone' }) + '\n');
  fs.mkdirSync(path.join(out, 'rea'));
  for (const file of ['rea.mjs', 'rea-rules.mjs']) fs.copyFileSync(path.join(reaDir, file), path.join(out, 'rea', file), fs.constants.COPYFILE_EXCL);

  const adapter = path.join(HERE, '..', 'lib', 'keychain-seal.mjs');
  fs.mkdirSync(path.join(out, 'lib'));
  fs.copyFileSync(adapter, path.join(out, 'lib', 'keychain-seal.mjs'), fs.constants.COPYFILE_EXCL);
  const store = path.join(out, 'account-session-store.mjs');
  const original = fs.readFileSync(store, 'utf8');
  const needle = "from '../lib/keychain-seal.mjs'";
  if (original.split(needle).length !== 2) throw new Error('release refused: unexpected account session adapter import');
  fs.writeFileSync(store, original.replace(needle, "from './lib/keychain-seal.mjs'"));
}

export function loadGhidraPruneManifest(manifestPath = path.join(HERE, 'ghidra-prune-manifest.json')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'scripture-armor.ghidra-prune/1' || !Array.isArray(manifest.deny) || !manifest.deny.length) {
    throw new Error('release refused: invalid Ghidra prune manifest: ' + manifestPath);
  }
  for (const entry of manifest.deny) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path)
      || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('release refused: invalid Ghidra prune manifest entry: ' + JSON.stringify(entry));
    }
  }
  if (manifest.denyIfPresent !== undefined) {
    if (!Array.isArray(manifest.denyIfPresent)) throw new Error('release refused: invalid Ghidra prune manifest denyIfPresent');
    for (const entry of manifest.denyIfPresent) {
      if (!entry || typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path)
        || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('release refused: invalid Ghidra prune manifest denyIfPresent entry: ' + JSON.stringify(entry));
      }
    }
  }
  return manifest;
}

// Removes the manifest's deny paths from a STAGED COPY of the Ghidra home
// (never from a source home: callers pass the bundle-internal destination).
// Fail-closed by this tree's convention: a Ghidra version other than the
// manifest's basis, or a deny path that is absent (layout drift), refuses
// the release instead of silently shipping an unpruned or wrongly pruned
// payload. Deny paths that are bundles of locally built natives the REA
// runtime actually loads (Decompiler/os, GPL/DemanglerGnu/os) are refused
// as manifest errors — the prune exists to cut what REA never loads.
export function applyGhidraPrune(stagedGhidraHome, { manifest = loadGhidraPruneManifest() } = {}) {
  const root = fs.realpathSync(stagedGhidraHome);
  const props = fs.readFileSync(path.join(root, 'Ghidra', 'application.properties'), 'utf8');
  const version = /^application.version=(.+)$/m.exec(props)?.[1]?.trim();
  if (version !== manifest.ghidraVersion) {
    throw new Error(`release refused: Ghidra prune manifest is written for Ghidra ${manifest.ghidraVersion}, staged home is ${version || 'unknown'}`);
  }
  for (const entry of manifest.deny) {
    if (/(^|\/)os$/.test(entry.path) || entry.path.includes('/os/')) {
      throw new Error('release refused: Ghidra prune manifest may not deny a native os payload: ' + entry.path);
    }
  }
  let removedFiles = 0, removedBytes = 0, skippedIfPresent = 0;
  const removeEntry = (entry, { required }) => {
    const target = path.join(root, entry.path);
    if (!fs.existsSync(target)) {
      if (required) throw new Error('release refused: Ghidra prune target absent (layout drift?): ' + entry.path);
      skippedIfPresent += 1;
      return;
    }
    const real = fs.realpathSync(target);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('release refused: Ghidra prune target escapes the staged home: ' + entry.path);
    const tally = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name), st = fs.lstatSync(file);
        if (st.isDirectory()) tally(file);
        else if (st.isFile()) { removedFiles += 1; removedBytes += st.size; }
      }
    };
    const st = fs.lstatSync(target);
    if (st.isDirectory()) tally(target);
    else if (st.isFile()) { removedFiles += 1; removedBytes += st.size; }
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(target)) throw new Error('release refused: Ghidra prune failed to remove: ' + entry.path);
  };
  for (const entry of manifest.deny) {
    if (/(^|\/)os$/.test(entry.path) || entry.path.includes('/os/')) {
      throw new Error('release refused: Ghidra prune manifest may not deny a native os payload: ' + entry.path);
    }
    removeEntry(entry, { required: true });
  }
  // denyIfPresent covers build products (gradle buildNatives output trees)
  // that exist only on a home where natives were built locally — on the Mac
  // release home they are duplicate native copies and are removed; on any
  // other home their absence is normal and is not drift.
  for (const entry of manifest.denyIfPresent || []) {
    if (/(^|\/)os$/.test(entry.path) || entry.path.includes('/os/')) {
      throw new Error('release refused: Ghidra prune manifest may not deny a native os payload: ' + entry.path);
    }
    removeEntry(entry, { required: false });
  }
  return { entries: manifest.deny.length, removedFiles, removedBytes, skippedIfPresent };
}

export function copyRuntime(source, destination, { cloneRuntimes = false } = {}) {
  if (cloneRuntimes && typeof fs.constants.COPYFILE_FICLONE_FORCE !== 'number') throw new Error('release refused: forced filesystem cloning is unavailable');
  const root = fs.realpathSync(source), seen = new Set();
  function validate(dir) {
    const real = fs.realpathSync(dir);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('release refused: prerequisite link escapes its runtime root');
    if (seen.has(real)) return;
    if (fs.statSync(dir).isDirectory()) { seen.add(real); for (const name of fs.readdirSync(dir)) validate(path.join(dir, name)); }
  }
  validate(root);
  // The validation above resolves every source link and refuses anything that
  // escapes the runtime root. Preserve those relative internal links verbatim:
  // Node's dereferencing copier rewrites them to absolute Homebrew Cellar
  // targets, which would make the distributable depend on this build machine.
  fs.cpSync(root, destination, { recursive: true, errorOnExist: true, dereference: false, verbatimSymlinks: true, ...(cloneRuntimes ? { mode: fs.constants.COPYFILE_FICLONE_FORCE } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildStandalone();

export function collectBundleRecords(out) {
  const records = [];
  // macOS exposes the temp directory through both /var and /private/var. Use
  // the canonical bundle root for containment comparisons so an internal link
  // is not falsely classified as external because of that path alias.
  const bundleRoot = fs.realpathSync(out);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const rel = path.relative(out, file).split(path.sep).join('/');
        const bytes = fs.readFileSync(file);
        records.push({ path: rel, size: bytes.length, mode: fs.statSync(file).mode & 0o777, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      } else if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(file);
        if (real !== bundleRoot && !real.startsWith(bundleRoot + path.sep)) throw new Error('release refused: bundle symlink points outside the bundle: ' + file);
        records.push({ path: path.relative(out, file).split(path.sep).join('/'), type: 'symlink', target: path.relative(bundleRoot, real).split(path.sep).join('/') });
      }
    }
  }
  walk(out);
  return records;
}
