#!/usr/bin/env node
// Clone Solomon into Kingmaker and strip its UI — repeatably.
//
//   node scripts/import-solomon.mjs --from ~/Projects/TSS --ref <commit|branch>
//
// Copies the TSS tree at <ref> (git archive: tracked files only, no history, no node_modules) into
// solomon/, removes everything solomon-strip.json lists (the UI, the window shell, tests that need them),
// and records where it came from in solomon/IMPORTED_FROM.json. Re-running with a newer ref replaces
// solomon/ wholesale, so Ghost keeps every engine fix TSS makes and never drifts by hand edits.
// Fails if anything left behind still imports a removed path.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const from = resolve(String(arg('--from', join(homedir(), 'Projects', 'TSS'))).replace(/^~(?=\/)/, homedir()));
const ref = String(arg('--ref', 'origin/main'));
const manifest = JSON.parse(readFileSync(join(root, 'solomon-strip.json'), 'utf8'));

const git = (...a) => execFileSync('git', ['-C', from, ...a], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', `${ref}^{commit}`);
const staging = join(root, `.solomon-import-${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync('/bin/sh', ['-c', `git -C '${from.replaceAll("'", "'\\''")}' archive --format=tar ${sha} | tar -x -C '${staging.replaceAll("'", "'\\''")}'`]);

const removed = [];
for (const [path, why] of Object.entries(manifest.remove)) {
  const target = join(staging, path);
  if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); removed.push({ path, why }); }
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== 'node_modules') yield* files(p); } else yield p;
  }
}
const testRules = manifest.removeTestsReferencing.map((s) => new RegExp(s));
const testsRoot = join(staging, 'tests');
const removedTests = [];
if (existsSync(testsRoot)) {
  for (const name of readdirSync(testsRoot)) {
    const dir = join(testsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const hit = [...files(dir)].some((f) => /\.(m?[jt]sx?|cjs)$/.test(f) && testRules.some((rx) => rx.test(readFileSync(f, 'utf8'))));
    if (hit) { rmSync(dir, { recursive: true, force: true }); removedTests.push(name); }
  }
}

// The suite list (tests/run-all.ts) still names every suite TSS has. Drop the entries the strip made unrunnable,
// so the orchestrator reports real results instead of "module not found" for files that were removed on purpose:
// a suite whose file is gone, or whose own args point into a removed path (e.g. --tsconfig ../app/tsconfig.json).
// One entry per line is TSS's format; anything else is left untouched.
const runAll = join(staging, 'tests', 'run-all.ts');
const prunedSuites = [];
if (existsSync(runAll)) {
  const removedRoots = Object.keys(manifest.remove).map((p) => p.replace(/\/$/, ''));
  const entry = /^\s*\{\s*name:\s*'([^']+)',\s*file:\s*'([^']+)'(.*)\},?\s*$/;
  const kept = [];
  for (const line of readFileSync(runAll, 'utf8').split('\n')) {
    const m = line.match(entry);
    if (m) {
      const [, name, file, rest] = m;
      const missing = !existsSync(resolve(staging, 'server', file));
      const args = (rest.match(/args:\s*\[([^\]]*)\]/) ?? [])[1] ?? '';
      const argPaths = [...args.matchAll(/'([^']+)'/g)].map((a) => relative(staging, resolve(staging, 'server', a[1])));
      const intoRemoved = argPaths.find((a) => removedRoots.some((r) => a === r || a.startsWith(`${r}/`)));
      if (missing || intoRemoved) { prunedSuites.push({ name, why: missing ? `file removed: ${file}` : `args use removed path: ${intoRemoved}` }); continue; }
    }
    kept.push(line);
  }
  if (prunedSuites.length) writeFileSync(runAll, kept.join('\n'));
}

// Nothing kept may still import what was stripped (server and desktop modules are the engines).
const dangling = [];
const importsRemoved = /(?:from\s+|import\(\s*)['"]([^'"]*(?:\/app\/src\/|desktop\/(?:main|preload)\.mjs|^electron$)[^'"]*)['"]/g;
for (const top of ['server/src', 'desktop', 'scripts']) {
  const base = join(staging, top);
  if (!existsSync(base)) continue;
  for (const f of files(base)) {
    if (!/\.(m?[jt]sx?|cjs)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(importsRemoved)) dangling.push(`${relative(staging, f)} → ${m[1]}`);
  }
}

writeFileSync(join(staging, 'IMPORTED_FROM.json'), `${JSON.stringify({
  repo: 'ronininc/TSS', ref, sha, importedAt: new Date().toISOString(),
  removed, removedTests, prunedRunAllSuites: prunedSuites, danglingImports: dangling,
}, null, 2)}\n`);

const dest = join(root, 'solomon');
rmSync(dest, { recursive: true, force: true });
renameSync(staging, dest);
console.log(`solomon/ ← TSS ${sha.slice(0, 9)} (${ref}); removed ${removed.length} paths and ${removedTests.length} UI test suites; pruned ${prunedSuites.length} unrunnable entries from tests/run-all.ts`);
if (dangling.length) {
  console.log(`dangling imports into stripped paths (${dangling.length}) — scripts that build the UI, not engines, unless listed under server/src:`);
  for (const d of dangling.slice(0, 40)) console.log(`  ${d}`);
  if (dangling.some((d) => d.startsWith('server/src/'))) { console.error('✗ server code imports a stripped path'); process.exit(1); }
}
