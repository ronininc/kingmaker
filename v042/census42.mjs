/**
 * census42.mjs — refresh stack42-manifest.json with the byte census and
 * per-component file lists (mtimes as version stamps; the component
 * homes carry no git metadata).
 *
 *   node ~/workspace/kingmaker-v042/census42.mjs
 *
 * The founder's rule stands behind this file: capability is PROVEN in
 * bytes. "Code" = .mjs under a component's lib/ and tests/, plus the
 * integration layer's root modules. Everything else the fold-in
 * carries (descriptors, triage records, docs, this registry) is
 * counted separately as "other" — no weights, no binaries, no vendored
 * upstream code exist in this tree to count.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const MANIFEST_PATH = join(ROOT, 'stack42-manifest.json');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function homeAbs(home) {
  return home === '~/workspace/kingmaker-v042' ? ROOT : join(ROOT, home.split('/').pop());
}

const censusComponents = {};
let totalCode = 0, totalCodeFiles = 0, totalOther = 0, totalOtherFiles = 0;

for (const comp of manifest.components) {
  const home = homeAbs(comp.home);
  const files = walk(home);
  const modules = [];
  const testSuites = [];
  let codeBytes = 0, codeFiles = 0, otherBytes = 0, otherFiles = 0;
  for (const file of files) {
    const rel = relative(home, file);
    // The root component's walk sees the whole tree; only its own
    // top-level files + shared lib belong to it.
    if (comp.id === 'kingmaker-v042' && rel.includes('/') && !rel.startsWith('lib/')) continue;
    if (comp.id !== 'kingmaker-v042' && rel === 'stack42-manifest.json') continue;
    const { size, mtime } = statSync(file);
    const isCode = file.endsWith('.mjs');
    if (isCode) {
      codeBytes += size; codeFiles++;
      const entry = { path: rel, mtime: mtime.toISOString() };
      if (rel.startsWith('tests/') || rel === 'seams42.test.mjs') testSuites.push(entry);
      else modules.push(entry);
    } else {
      otherBytes += size; otherFiles++;
    }
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));
  testSuites.sort((a, b) => a.path.localeCompare(b.path));
  comp.modules = modules;
  comp.testSuites = testSuites;
  censusComponents[comp.id] = { codeBytes, codeFiles, otherBytes, otherFiles };
  totalCode += codeBytes; totalCodeFiles += codeFiles;
  totalOther += otherBytes; totalOtherFiles += otherFiles;
}

manifest.generatedAt = new Date().toISOString();
manifest.byteCensus = {
  generatedAt: manifest.generatedAt,
  methodology:
    "code = .mjs under each component's lib/ and tests/ plus the integration layer's root modules (verify-42, census42, seams42) and shared lib/; other = descriptor JSONs, triage records, STACK42.md, NOTICE, and this registry. Exact file bytes, no estimates.",
  scope:
    'The fold-in carries NO binaries, NO model weights, and NO vendored upstream code — by design (registrations, contracts, stubs, and paper only).',
  components: censusComponents,
  totals: {
    codeBytes: totalCode,
    codeFiles: totalCodeFiles,
    otherBytes: totalOther,
    otherFiles: totalOtherFiles,
    allBytes: totalCode + totalOther,
  },
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`census: code ${totalCode} bytes across ${totalCodeFiles} files; other ${totalOther} bytes across ${totalOtherFiles} files`);
for (const [id, c] of Object.entries(censusComponents)) {
  console.log(`  ${id.padEnd(16)} code ${String(c.codeBytes).padStart(7)}  other ${String(c.otherBytes).padStart(7)}`);
}
