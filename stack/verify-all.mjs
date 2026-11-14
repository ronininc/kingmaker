#!/usr/bin/env node
/**
 * verify-all.mjs (kingmaker-stack)
 *
 * One runner for the whole folded stack: every component's own test
 * suite, plus the cross-component seam checks (seams.test.mjs). Each
 * suite runs in its own process, in its component's home directory,
 * exactly as its header documents. Pass counts are parsed from each
 * suite's own summary line — the suites' exit codes are the verdict;
 * the counts are the receipt. The eleven absorbed components folded
 * in 2026-10-20 (wordcraft … lazy-frames) run from their homes in
 * this directory, after the original five builds' suites.
 *
 * Usage: node verify-all.mjs [--json]
 * Exit: 0 iff every suite passes; 1 if any suite fails.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACK_DIR = dirname(fileURLToPath(import.meta.url));
const WS = dirname(STACK_DIR);
const TIMEOUT_MS = 900_000;

const summaryCount = (re) => (out) => {
  const m = out.match(re);
  return m ? { passed: Number(m[1]), total: Number(m[1]) } : null;
};
const ratioCount = (re) => (out) => {
  const m = out.match(re);
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
};

const SUITES = [
  {
    id: 'router/governed-router', component: 'router-phase2',
    cwd: join(WS, 'router-phase2'), file: 'tests/governed-router.test.mjs',
    parse: summaryCount(/All (\d+) test groups passed/),
  },
  {
    id: 'router/federation-memory', component: 'router-phase2',
    cwd: join(WS, 'router-phase2'), file: 'tests/federation-memory.test.mjs',
    parse: summaryCount(/All (\d+) federation\/memory\/drift checks passed/),
  },
  {
    id: 'router/guardrails-doctor', component: 'router-phase2',
    cwd: join(WS, 'router-phase2'), file: 'tests/guardrails-doctor.test.mjs',
    parse: summaryCount(/ALL PART-3 TESTS PASSED \((\d+) groups\)/),
  },
  {
    id: 'router/guardrails-router-wiring', component: 'router-phase2',
    cwd: join(WS, 'router-phase2'), file: 'tests/guardrails-router-wiring.test.mjs',
    parse: summaryCount(/All (\d+) test groups passed/),
  },
  {
    id: 'littlebrother/acceptance', component: 'littlebrother',
    cwd: join(WS, 'littlebrother'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'stack-littlebrother/acceptance', component: 'littlebrother',
    cwd: join(STACK_DIR, 'littlebrother'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'harness2/acceptance', component: 'harness2',
    cwd: join(STACK_DIR, 'harness2'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'weight-synthesis/acceptance', component: 'weight-synthesis',
    cwd: join(STACK_DIR, 'weight-synthesis'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'weight-synthesis/host', component: 'weight-synthesis',
    cwd: join(STACK_DIR, 'weight-synthesis'), file: 'tests/host.test.mjs',
    parse: summaryCount(/weightsynth-host: (\d+) checks passed/),
  },
  {
    id: 'harness2/model-transport', component: 'harness2',
    cwd: join(STACK_DIR, 'harness2'), file: 'tests/model-transport.test.mjs',
    parse: summaryCount(/harness2-model-transport: (\d+) checks passed/),
  },
  {
    id: 'slash-buckets/acceptance', component: 'slash-buckets',
    cwd: join(STACK_DIR, 'slash-buckets'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'unlimited-ocr/contract', component: 'unlimited-ocr',
    cwd: join(WS, 'kingmaker-v042', 'unlimited-ocr'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'space-cell/cell', component: 'space-cell',
    cwd: join(WS, 'kingmaker-v041', 'space-cell'), file: 'tests/space-cell.test.mjs',
    parse: ratioCount(/(\d+)\/(\d+) passed/),
  },
  {
    id: 'training-data-pipeline/pipeline', component: 'training-data-pipeline',
    cwd: join(WS, 'training-data-pipeline'), file: 'tests/run-tests.mjs',
    parse: (out) => {
      const passed = (out.match(/^PASS /gm) || []).length;
      const failed = (out.match(/^FAIL /gm) || []).length;
      return passed + failed > 0 ? { passed, total: passed + failed } : null;
    },
  },
  {
    id: 'edge0-augmentation/truth-pass+lane-policy', component: 'edge0-minicpm-augmentation',
    cwd: join(WS, 'edge0-minicpm-augmentation'), file: 'tests/run-tests.mjs',
    parse: summaryCount(/(\d+) checks passed/),
  },
  {
    id: 'wordcraft/contract', component: 'wordcraft',
    cwd: join(STACK_DIR, 'wordcraft'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'artemis/contract', component: 'artemis',
    cwd: join(STACK_DIR, 'artemis'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'anatomy/gate', component: 'anatomy',
    cwd: join(STACK_DIR, 'anatomy'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'solidcraft/contract', component: 'solidcraft',
    cwd: join(STACK_DIR, 'solidcraft'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'xerj/contract', component: 'xerj',
    cwd: join(STACK_DIR, 'xerj'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'unsloth/contract', component: 'unsloth',
    cwd: join(STACK_DIR, 'unsloth'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'check-if-email-exists/gate', component: 'check-if-email-exists',
    cwd: join(STACK_DIR, 'check-if-email-exists'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'stop-slop/skill-pin', component: 'stop-slop',
    cwd: join(STACK_DIR, 'stop-slop'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'humanizer/skill-pin', component: 'humanizer',
    cwd: join(STACK_DIR, 'humanizer'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'exifcleaner/external', component: 'exifcleaner',
    cwd: join(STACK_DIR, 'exifcleaner'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'lazy-frames/triage', component: 'lazy-frames',
    cwd: join(STACK_DIR, 'lazy-frames'), file: 'tests/run-tests.mjs',
    parse: ratioCount(/(\d+)\/(\d+) checks passed/),
  },
  {
    id: 'stack/seams', component: 'kingmaker-stack',
    cwd: STACK_DIR, file: 'seams.test.mjs',
    parse: ratioCount(/(\d+)\/(\d+) seam checks passed/),
  },
];

const asJson = process.argv.includes('--json');
const results = [];

for (const suite of SUITES) {
  const started = Date.now();
  const run = spawnSync('node', [suite.file], {
    cwd: suite.cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const counts = suite.parse(out);
  const ok = run.status === 0 && !run.error;
  results.push({
    id: suite.id, component: suite.component, ok,
    exit: run.status, ms: Date.now() - started,
    passed: counts?.passed ?? null, total: counts?.total ?? null,
    error: run.error ? String(run.error.message) : null,
    tail: ok ? null : out.trim().split('\n').slice(-8).join('\n'),
  });
  if (!asJson) {
    const count = counts ? `${counts.passed}/${counts.total}` : 'count n/a';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.id} — ${count} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (!ok) console.log(out.trim().split('\n').slice(-8).map((l) => `      ${l}`).join('\n'));
  }
}

const suitesPassed = results.filter((r) => r.ok).length;
const checksPassed = results.reduce((n, r) => n + (r.passed ?? 0), 0);
const checksTotal = results.reduce((n, r) => n + (r.total ?? 0), 0);
const allOk = suitesPassed === results.length;

if (asJson) {
  console.log(JSON.stringify({ ok: allOk, suites: results, suitesPassed, suitesTotal: results.length, checksPassed, checksTotal }, null, 2));
} else {
  console.log(`\n${allOk ? 'STACK GREEN' : 'STACK RED'} — ${suitesPassed}/${results.length} suites passed; ${checksPassed}/${checksTotal} checks counted across suites.`);
}
process.exitCode = allOk ? 0 : 1;
