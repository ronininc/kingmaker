// Defensive regression: compile inert C fixtures, inspect them with Ghidra, NEVER run them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runGhidraExporter, normalizeBinaryFindings, scanFile } from '../scan.mjs';

const run = promisify(execFile), root = fileURLToPath(new URL('..', import.meta.url));
const jdk = process.env.JAVA_HOME;
const java = jdk && path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javac = jdk && path.join(jdk, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const hasJdk = Boolean(java && fs.existsSync(java) && fs.existsSync(javac));
let harness;
test.before(async () => {
  if (!hasJdk) return;
  harness = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-symbol-unit-'));
  const source = fs.readFileSync(path.join(root, 'ghidra-scripts', 'ScriptureScan.java'), 'utf8');
  const start = source.indexOf('    private static String baseName(String n, String executableFormat) {');
  const end = source.indexOf('\n    private String baseName(String n)', start);
  assert.ok(start >= 0 && end > start, 'Exercise the exact exporter normalization method, not a JavaScript reimplementation');
  const method = source.slice(start, end);
  fs.writeFileSync(path.join(harness, 'Symbols.java'), 'public class Symbols {\n' + method + '\npublic static void main(String[] a) { System.out.print(baseName(a[1], a[0])); }\n}\n');
  await run(javac, [path.join(harness, 'Symbols.java')], { timeout: 30000 });
});
test.after(() => { if (harness) fs.rmSync(harness, { recursive: true, force: true }); });
async function check(format, symbol, expected) {
  const result = await run(java, ['-cp', harness, 'Symbols', format, symbol], { timeout: 10000 });
  assert.equal(result.stdout, expected, format + ': ' + symbol);
}
test('Mach-O removes exactly one C ABI underscore, preserving actual underscored function names', { skip: !hasJdk && 'Set JAVA_HOME to a verified JDK' }, async () => {
  for (const [symbol, expected] of [['_main', 'main'], ['_system', 'system'], ['_strcpy', 'strcpy'], ['_getenv', 'getenv'], ['__spawnv', '_spawnv'], ['___isoc99_scanf', '__isoc99_scanf'], ['system', 'system'], ['_', '_']]) await check('Mac OS X Mach-O', symbol, expected);
});
test('ELF preserves meaningful underscores while retaining GLIBC suffix normalization', { skip: !hasJdk && 'Set JAVA_HOME to a verified JDK' }, async () => {
  for (const [symbol, expected] of [['system@GLIBC_2.2.5', 'system'], ['_spawnv', '_spawnv'], ['__isoc99_scanf@GLIBC_2.7', '__isoc99_scanf'], ['_start', '_start'], ['_system', '_system']]) await check('Executable and Linking Format (ELF)', symbol, expected);
});
test('PE and unknown loader formats preserve _spawn variants and do not borrow Mach-O rules', { skip: !hasJdk && 'Set JAVA_HOME to a verified JDK' }, async () => {
  for (const format of ['Portable Executable (PE)', 'Raw Binary']) {
    for (const [symbol, expected] of [['_spawnl', '_spawnl'], ['_spawnv', '_spawnv'], ['__spawnv', '__spawnv'], ['_system', '_system'], ['CreateProcessW', 'CreateProcessW']]) await check(format, symbol, expected);
  }
});
test('real Ghidra recognizes canonical Mach-O sinks while preserving raw symbol evidence', {
  skip: !(process.platform === 'darwin' && hasJdk && process.env.SCRIPTURE_GHIDRA_HOME) && 'Requires macOS, verified Ghidra and JAVA_HOME', timeout: 360000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-mach-o-regression-'));
  try {
    for (const name of ['bad']) {
      await run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', path.join(dir, name + '.bin'), path.join(root, 'test', 'fixtures-src', name + '.c')], { timeout: 30000 });
    }
    const policy = { scan: { timeout_s: 150 } };
    const { obs, engineVersion } = await runGhidraExporter(path.join(dir, 'bad.bin'), { policy, storeDir: dir });
    assert.equal(obs.loader, 'Mac OS X Mach-O');
    for (const name of ['system', 'strcpy']) assert.ok(obs.imports.some(x => x.name === name && x.raw_name === '_' + name), name + ' keeps canonical and raw import evidence');
    // This Ghidra loader can label the stripped compiler entry as "entry"
    // rather than recover main. _main -> main is exercised above; real root
    // evidence must preserve whichever name the engine actually observed.
    assert.ok(obs.entry_points.some(x => x === 'main' || x === 'entry'));
    assert.equal(obs.entry_points_raw.length, obs.entry_points.length);
    for (let i = 0; i < obs.entry_points.length; i++) {
      const raw = obs.entry_points_raw[i];
      assert.equal(obs.entry_points[i], raw.startsWith('_') ? raw.slice(1) : raw);
    }
    assert.ok(obs.call_paths.some(x => x.sink === 'system' && x.sink_raw === '_system' && x.arg_literal === false));
    assert.ok(obs.call_sites.some(x => x.callee === 'strcpy' && x.callee_raw === '_strcpy'));
    const findings = normalizeBinaryFindings(obs, '0'.repeat(64), dir).findings;
    assert.ok(findings.some(x => x.rule === 'sink-reachability' && x.severity === 'critical'));
    assert.ok(findings.some(x => x.rule === 'unbounded-copy-call' && x.severity === 'medium'));
    t.diagnostic(JSON.stringify({ engineVersion, loader: obs.loader, imports: obs.imports, entry_points: obs.entry_points, entry_points_raw: obs.entry_points_raw, paths: obs.call_paths.map(x => ({ from: x.from, sink: x.sink, sink_raw: x.sink_raw, arg_literal: x.arg_literal })), decompile: obs.decompile, badFindings: findings.map(x => ({ rule: x.rule, severity: x.severity })) }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('real Ghidra keeps the bounded literal-only Mach-O control passing', {
  skip: !(process.platform === 'darwin' && hasJdk && process.env.SCRIPTURE_GHIDRA_HOME) && 'Requires macOS, verified Ghidra and JAVA_HOME', timeout: 180000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-mach-o-clean-control-'));
  try {
    const target = path.join(dir, 'clean.bin');
    await run('gcc', ['-O1', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-o', target, path.join(root, 'test', 'fixtures-src', 'clean.c')], { timeout: 30000 });
    const clean = (await scanFile(target, { policy: { scan: { timeout_s: 150 } }, storeDir: dir })).record;
    // Missing/failed native decompilation must not be silently accepted as a
    // passing literal control. Keep this assertion until that prerequisite works.
    assert.equal(clean.verdict, 'pass', JSON.stringify(clean));
    assert.ok(clean.findings.some(x => x.rule === 'sink-reachability' && x.severity === 'low' && x.detail.includes('compile-time literal')));
    assert.ok(!clean.findings.some(x => ['high', 'critical'].includes(x.severity)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
