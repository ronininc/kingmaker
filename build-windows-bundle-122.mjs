// Windows standalone bundle driver, 1.2.2 — the Nov 7 driver's lineage
// (build/build-windows-bundle.mjs in armor-platform-packages-2026-11-07),
// with the version bumped and the roots parameterizable so it runs on any
// host:  ARMOR_TREE=<consolidated kingmaker checkout>
//        ARMOR_GHIDRA=<route-b full-bundle ghidra home>
//        ARMOR_OUT=<output bundle dir>
// Assembles through build-standalone.mjs's OWN exported staging functions,
// in the builder's own order, with ONE deliberate omission: the JDK payload
// (no Windows JDK exists on a Linux build host; the omission is declared in
// the manifest, exactly as in the 1.2.1 build).
import fs from 'node:fs';
import path from 'node:path';

const TREE = process.env.ARMOR_TREE || '/home/hatch/workspace/armor-item2-lb-wiring-2026-11-06/kingmaker';
const GHIDRA_HOME = process.env.ARMOR_GHIDRA || '/home/hatch/workspace/armor-route-b-2026-11-05/work/full-bundle/tools/ghidra';
const OUT = process.env.ARMOR_OUT || '/home/hatch/workspace/armor-next-build-2026-11-11/build/windows-bundle';
const REA_DIR = path.join(TREE, 'lib');

const {
  stageStandaloneSources, copyRuntime, applyGhidraPrune, collectBundleRecords,
} = await import(path.join(TREE, 'scripture-armor', 'build-standalone.mjs'));

stageStandaloneSources(OUT, { reaDir: REA_DIR, flavor: 'full' });
copyRuntime(GHIDRA_HOME, path.join(OUT, 'tools', 'ghidra'), {});
const prune = applyGhidraPrune(path.join(OUT, 'tools', 'ghidra'));
console.log(`ghidra prune: removed ${prune.removedFiles} files, ${prune.removedBytes} bytes (${prune.entries} manifest entries, ${prune.skippedIfPresent} build-product entries absent)`);

const records = collectBundleRecords(OUT);
const required = [
  'armor.mjs', 'vaultd.mjs', 'dashboard.mjs', 'credential-vault.mjs', 'scan.mjs', 'daemon-transport.mjs',
  'entitlement-client.mjs', 'account-session.mjs', 'account-session-store.mjs', 'submit-request.mjs', 'submit-transport-guard.mjs', 'installation-health.mjs', 'activation-flow.mjs', 'paid-activation.mjs',
  'rea/rea.mjs', 'rea/rea-rules.mjs', 'lib/keychain-seal.mjs', 'ghidra-scripts/ScriptureScan.java',
  'ui/scripture-armor-crest-ronin.png',
  'mac/ScriptureArmorApp.swift', 'mac/build-native-app.sh',
  'tools/ghidra/support/analyzeHeadless.bat',
  'tools/ghidra/Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe',
  'tools/ghidra/Ghidra/Features/Decompiler/os/win_x86_64/sleigh.exe',
  'tools/ghidra/GPL/DemanglerGnu/os/win_x86_64/demangler_gnu_v2_41.exe',
  'windows/install-armor.ps1', 'windows/builds.json', 'windows/select-build.mjs',
];
for (const rel of required) {
  if (!records.some((r) => r.path === rel && r.size > 0)) throw new Error(`release refused: empty or missing component: ${rel}`);
}
if (records.some((r) => r.path.startsWith('tools/jdk/'))) throw new Error('release refused: tools/jdk present in the Windows bundle (must be absent — labeled gap)');

const manifest = {
  schema: 'scripture-armor.standalone-bundle/1',
  version: '1.2.2',
  product: 'standalone',
  prerequisites: {
    schema: 'scripture-armor.prerequisites/1',
    platform: 'win32',
    arch: 'x64',
    ghidraVersion: '12.2',
    javaVersion: null,
    nodeVersion: process.version,
    requiresExternalNode: true,
    jdkPayload: 'NOT BUNDLED — no Windows JDK exists on the (Linux) build host. The Ghidra lane on the target resolves a JDK via policy jdk_home, SCRIPTURE_GHIDRA_HOME-adjacent tools/jdk dropped in beside this bundle, or a system JDK (scan.mjs findJdk). Every other lane is pure Node and unaffected.',
    builtOn: 'linux',
    checks: ['sources-staged-by-builder', 'ghidra-payload-copied-and-pruned-by-builder', 'analyzeHeadless.bat-present', 'win_x86_64-decompiler-natives-present', 'jdk-payload-absent-by-design'],
  },
  files: records.sort((a, b) => a.path.localeCompare(b.path)),
};
fs.writeFileSync(path.join(OUT, 'BUNDLE.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${OUT}: ${records.length} verified files`);
