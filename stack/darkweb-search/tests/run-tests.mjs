/**
 * tests/run-tests.mjs
 *
 * darkweb-search suite entry — the discoverable suite the promotion door
 * (scripts/promote.mjs) runs, same shape as the sibling components'
 * tests/run-tests.mjs. The component's behavioral suite is TypeScript-
 * source + a CommonJS runner (tests/darkweb-search.test.cjs), so this
 * entry does the two steps the .cjs header documents:
 *
 *   1. compile runtime/darkweb-search.ts (and its import graph) with
 *      tsc --strict --module commonjs --moduleResolution node into a
 *      throwaway out dir;
 *   2. run tests/darkweb-search.test.cjs with DW_OUT pointed at it and
 *      propagate its verdict (it prints "darkweb-ts-port: N checks passed").
 *
 * TypeScript MUST be 5.x: TS 7 removed moduleResolution=node, which the
 * extensionless sibling imports in runtime/ rely on. The compiler is
 * resolved locally, in this order, and the first candidate that reports
 * a 5.x version wins:
 *
 *   1. $DARKWEB_TSC — explicit path to a tsc entry (typescript/bin/tsc)
 *   2. <component>/node_modules/typescript/bin/tsc
 *   3. <repo root>/node_modules/typescript/bin/tsc
 *   4. a `tsc` on PATH
 *
 * A candidate that resolves but is not 5.x is skipped with a note, never
 * used. No candidate → the suite refuses with the fix (install TS 5
 * locally, e.g. `npm i -D typescript@^5` in this component or at the repo
 * root, or set DARKWEB_TSC). When the chosen compiler's install carries
 * a sibling @types/node, it is passed via --typeRoots so the node:
 * imports type-check under --strict.
 *
 * Usage: node tests/run-tests.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const REPO_ROOT = join(ROOT, '..', '..');

function tscVersion(tscPath) {
  const r = spawnSync(process.execPath, [tscPath, '--version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /Version (\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? '');
  return m ? { major: Number(m[1]), raw: m[0] } : null;
}

function resolveTsc() {
  const candidates = [];
  if (process.env.DARKWEB_TSC) candidates.push(['$DARKWEB_TSC', process.env.DARKWEB_TSC]);
  candidates.push(['component node_modules', join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')]);
  candidates.push(['repo-root node_modules', join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')]);
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(':')) {
      if (dir) candidates.push(['PATH', join(dir, 'tsc')]);
    }
  }
  const notes = [];
  for (const [where, path] of candidates) {
    if (!existsSync(path)) continue;
    const v = tscVersion(path);
    if (v && v.major === 5) return { path, version: v.raw, where };
    if (v) notes.push(`${where}: ${path} is ${v.raw} — skipped (need 5.x)`);
  }
  console.error('FAIL darkweb-search suite: no locally resolvable TypeScript 5.x compiler.');
  for (const n of notes) console.error(`  ${n}`);
  console.error('  The compile recipe needs moduleResolution=node, removed in TS 7.');
  console.error('  Fix: install TS 5 locally (npm i -D typescript@^5 in this component or at the repo root) or set DARKWEB_TSC to a TS 5 tsc.');
  process.exit(1);
}

const tsc = resolveTsc();
console.log(`darkweb-search suite: compiling with ${tsc.version} (${tsc.where}: ${tsc.path})`);

const out = mkdtempSync(join(tmpdir(), 'dw-out-'));
let exitCode = 1;
try {
  const args = [
    tsc.path,
    '--outDir', out,
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--target', 'es2022',
    '--strict',
  ];
  // @types/node sibling of the chosen install (e.g. /tmp/ts5 layout or a
  // project node_modules) → make the node: imports type-check.
  const typesDir = join(dirname(dirname(tsc.path)), '..', '@types');
  if (existsSync(join(typesDir, 'node'))) args.push('--typeRoots', typesDir);
  args.push(join('runtime', 'darkweb-search.ts'));

  const compile = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (compile.status !== 0) {
    console.error('FAIL darkweb-search suite: tsc --strict compile failed');
    process.stdout.write(compile.stdout ?? '');
    process.stderr.write(compile.stderr ?? '');
  } else {
    const suite = spawnSync(process.execPath, [join('tests', 'darkweb-search.test.cjs')], {
      cwd: ROOT,
      env: { ...process.env, DW_OUT: out },
      stdio: 'inherit',
    });
    exitCode = suite.status ?? 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(exitCode);
