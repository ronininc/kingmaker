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
  'protection-feed.mjs', 'agnostic-review.mjs', 'review-worker.mjs', 'review-presentation.mjs', 'review-intake.mjs', 'repository-review.mjs', 'review-controls.mjs', 'review-ejection.mjs', 'sandbox-review.mjs', 'device-protection.mjs', 'device-scan-roots.json', 'key-transition.mjs', 'retired-key-recovery.mjs', 'rotation-candidate.mjs',
  'dns-profiles', 'ghidra-scripts', 'mac', 'linux', 'windows', 'ui',
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
