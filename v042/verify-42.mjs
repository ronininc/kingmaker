/**
 * verify-42.mjs — run every kingmaker-v042 suite and report one verdict.
 *
 *   node ~/workspace/kingmaker-v042/verify-42.mjs          (human report)
 *   node ~/workspace/kingmaker-v042/verify-42.mjs --json   (machine report)
 *
 * Exit 0 only if every suite passes. Check counts are parsed from each
 * suite's own summary line, so a suite that lies about passing (bad exit
 * code, no summary) fails the whole run. Zero network anywhere: every
 * transport is an injected fake, every runner a stub, every record
 * paper.
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Each 4.2 suite prints "N/N checks passed"; the seam suite prints
// "N/N seam checks passed" — the generic pair parser covers both.
const ratioCount = (out) => {
  const m = out.match(/(\d+)\s*\/\s*(\d+)\s+(?:seam\s+)?checks passed/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

const SUITES = [
  { id: 'scrapling/adapter', component: 'Scrapling adapter', cwd: `${ROOT}/scrapling`, file: `${ROOT}/scrapling/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'obscura/contract', component: 'Obscura registration', cwd: `${ROOT}/obscura`, file: `${ROOT}/obscura/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'blender-mcp/contract', component: 'Blender MCP registration', cwd: `${ROOT}/blender-mcp`, file: `${ROOT}/blender-mcp/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'whatsapp-mcp/gate', component: 'WhatsApp gate', cwd: `${ROOT}/whatsapp-mcp`, file: `${ROOT}/whatsapp-mcp/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'angelslim/job', component: 'AngelSlim workload', cwd: `${ROOT}/angelslim`, file: `${ROOT}/angelslim/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'freemocap/external', component: 'FreeMoCap external-only', cwd: `${ROOT}/freemocap`, file: `${ROOT}/freemocap/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'triage/records', component: 'Triage records', cwd: `${ROOT}/triage`, file: `${ROOT}/triage/tests/run-tests.mjs`, parse: ratioCount },
  { id: 'stack42/seams', component: '4.2 seams', cwd: ROOT, file: `${ROOT}/seams42.test.mjs`, parse: ratioCount },
];

const jsonMode = process.argv.includes('--json');
const results = [];
let allOk = true;
let totalChecks = 0;
let totalPassed = 0;

for (const suite of SUITES) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [suite.file], {
    cwd: suite.cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const counts = suite.parse ? suite.parse(out) : null;
  const ok =
    run.status === 0 &&
    counts !== null &&
    counts[0] === counts[1] &&
    counts[1] > 0;
  if (counts) {
    totalPassed += counts[0];
    totalChecks += counts[1];
  }
  if (!ok) allOk = false;
  results.push({
    id: suite.id,
    component: suite.component,
    ok,
    checks: counts ? `${counts[0]}/${counts[1]}` : 'unparsed',
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    output: ok ? undefined : out.trim().slice(-3000),
  });
}

if (jsonMode) {
  console.log(JSON.stringify({ ok: allOk, suites: results, totalPassed, totalChecks }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} ${r.checks} (${r.seconds}s)`);
    if (!r.ok && r.output) console.log(r.output);
  }
  console.log(
    allOk
      ? `\nSTACK42 GREEN — ${results.length}/${results.length} suites passed; ${totalPassed}/${totalChecks} checks counted`
      : `\nSTACK42 FAILED — ${results.filter((r) => r.ok).length}/${results.length} suites passed`
  );
}

process.exit(allOk ? 0 : 1);
