/**
 * tests/run-tests.mjs (harness2, kingmaker-stack)
 *
 * Acceptance tests for the governed Harness² reconstruction.
 * FAKE RUNNERS AND EDITORS ONLY — no model calls, no network.
 * globalThis.fetch is patched to throw so any network reach fails loudly.
 *
 * Usage: node tests/run-tests.mjs
 */

globalThis.fetch = () => {
  throw new Error('TEST VIOLATION: network access is forbidden in tests');
};

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const { createHarnessImprover, HARNESS_COMPONENTS } = await import(
  pathToFileURL(join(ROOT, 'lib/harness2-governed.mjs')).href
);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'harness2-test-'));
const freshAudit = () => join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
const baseHarness = () => ({
  components: Object.fromEntries(HARNESS_COMPONENTS.map((c) => [c, `base:${c}`])),
});
const task = { id: 'task-1' };
// Runner scores by content: any trial whose skills component mentions
// 'sharper' scores 10, memory mentioning 'indexed' scores 7, else 3.
const runner = async (trial) => {
  if (trial.components.skills.includes('sharper')) return { score: 10, signal: 'skills sharper' };
  if (trial.components.memory.includes('indexed')) return { score: 7, signal: 'memory indexed' };
  return { score: 3, signal: 'baseline' };
};
const editors = [
  () => ({ component: 'skills', content: 'sharper skills', rationale: 'tighten skill text' }),
  () => ({ component: 'memory', content: 'indexed memory', rationale: 'index the memory' }),
];
const verifyTap = (token) => token === 'founder-tap-ok';

await check('propose: valid edits become candidates', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: join(dir, 'lib1.json'), runner, verifyTap });
  const r = await imp.propose({ task, harness: baseHarness(), editors });
  assert(r.ok && r.candidates.length === 2, `expected 2 candidates, got ${JSON.stringify(r)}`);
});

await check('propose: unknown component is dropped, not adopted into the cycle', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), runner, verifyTap });
  const r = await imp.propose({ task, harness: baseHarness(), editors: [() => ({ component: 'weights', content: 'retrain' })] });
  assert(r.ok && r.candidates.length === 0, `weights edit must be dropped, got ${JSON.stringify(r.candidates)}`);
});

await check('propose: CSAM-screened content never becomes a candidate', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), runner, verifyTap });
  const r = await imp.propose({ task, harness: baseHarness(), editors: [() => ({ component: 'skills', content: 'child porn index' })] });
  assert(r.ok && r.candidates.length === 0, 'screened content must not reach the candidate list');
});

await check('probe: no runner configured refuses (fail-closed)', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), verifyTap });
  const p = await imp.propose({ task, harness: baseHarness(), editors });
  const r = await imp.probe({ task, harness: baseHarness(), candidates: p.candidates });
  assert(r.ok === false && r.refused === true, `probe without runner must refuse, got ${JSON.stringify(r)}`);
});

await check('compose: highest probe score wins', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: join(dir, 'lib2.json'), runner, verifyTap });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  assert(cycle.ok && cycle.winner.component === 'skills' && cycle.winner.score === 10, `wrong winner: ${JSON.stringify(cycle.winner)}`);
  assert(cycle.adopted === false, 'runCycle must never adopt');
});

await check('adopt: no tap token refuses and changes nothing', async () => {
  const libPath = join(dir, 'lib3.json');
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: libPath, runner, verifyTap });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  const r = await imp.adopt({ task, harness: baseHarness(), winner: cycle.winner });
  assert(r.ok === false && r.refused === true, `untapped adoption must refuse, got ${JSON.stringify(r)}`);
  assert(!existsSync(libPath) || JSON.parse(readFileSync(libPath, 'utf8')).length === 0, 'refused adoption must not write lessons');
});

await check('adopt: wrong tap token refuses', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: join(dir, 'lib4.json'), runner, verifyTap });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  const r = await imp.adopt({ task, harness: baseHarness(), winner: cycle.winner, tapToken: 'not-the-founder' });
  assert(r.ok === false && r.refused === true, 'wrong token must refuse');
});

await check('adopt: no tap verifier configured refuses everything (fail-closed)', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), runner });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  const r = await imp.adopt({ task, harness: baseHarness(), winner: cycle.winner, tapToken: 'founder-tap-ok' });
  assert(r.ok === false && r.refused === true, 'absent verifier must refuse even a plausible token');
});

await check('adopt: verified tap applies ONLY the winning component', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: join(dir, 'lib5.json'), runner, verifyTap });
  const harness = baseHarness();
  const cycle = await imp.runCycle({ task, harness, editors });
  const r = await imp.adopt({ task, harness, winner: cycle.winner, tapToken: 'founder-tap-ok' });
  assert(r.ok === true, `adoption failed: ${JSON.stringify(r)}`);
  assert(r.harness.components.skills === 'sharper skills', 'winner component not applied');
  assert(r.harness.components.memory === 'base:memory', 'non-winning component must stay at base');
  assert(harness.components.skills === 'base:skills', 'original harness must not be mutated');
});

await check('library: lessons carry across improver instances (next task inherits)', async () => {
  const libPath = join(dir, 'lib6.json');
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: libPath, runner, verifyTap });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  await imp.adopt({ task, harness: baseHarness(), winner: cycle.winner, tapToken: 'founder-tap-ok' });
  const imp2 = createHarnessImprover({ auditPath: freshAudit(), libraryPath: libPath, runner, verifyTap });
  const lessons = imp2.lessons();
  assert(lessons.length === 1 && lessons[0].component === 'skills' && lessons[0].authorizedBy === 'founder-tap',
    `lesson did not carry: ${JSON.stringify(lessons)}`);
});

await check('audit: the full cycle + adoption chain verifies', async () => {
  const imp = createHarnessImprover({ auditPath: freshAudit(), libraryPath: join(dir, 'lib7.json'), runner, verifyTap });
  const cycle = await imp.runCycle({ task, harness: baseHarness(), editors });
  await imp.adopt({ task, harness: baseHarness(), winner: cycle.winner, tapToken: 'founder-tap-ok' });
  const v = imp.verifyAudit();
  assert(v.ok === true, `audit chain broken: ${JSON.stringify(v)}`);
});

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
