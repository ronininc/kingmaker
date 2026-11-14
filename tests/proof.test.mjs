// Tests for the 10M token proof harness (proof/): metering arithmetic, the verdict's honesty
// rules, workload determinism, the report schema the light-runtime UI consumes, smoke-mode
// exactness, resume, and clean stops. Everything here runs against fakes — a green suite proves
// the HARNESS, never a hardware throughput number (that is the Mac run's job, by design).
// Run: node tests/proof.test.mjs
import assert from 'node:assert/strict';
import { estimateTokens, textForTokens, syntheticCorpus, buildPlan, REFLEX_BATCH } from '../proof/workload.mjs';
import { createCountingTransport, createOllamaTransport, createSimulatedSystemOneFetch, scheduledWallMs } from '../proof/transport.mjs';
import { runProof, verdictFor, macRunRequirements, renderMarkdown } from '../proof/run-proof.mjs';
import { validateReport, TILE_LABELS, TARGET_TOK_S } from '../proof/report-schema.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };
const near = (a, b, eps = 0.11) => Math.abs(a - b) <= eps;

const smallCorpus = () => syntheticCorpus({ seed: 7, chunks: 6, chunkChars: 16000 });
const smallPlan = () => buildPlan({ totalTokens: 60_000, seed: 7, corpus: smallCorpus() });
const recordingSink = () => { const calls = []; const sink = (j, opts) => calls.push({ j, opts }); sink.calls = calls; return sink; };
const simRun = async (plan, extra = {}) => runProof({
  plan,
  transport: createCountingTransport(),
  reflex: { model: 'tev1', simulated: true },
  models: { read: 'reader-x', write: 'writer-x' },
  meterSink: recordingSink(),
  ...extra,
});

/* ---------------- estimator + exact-token text ---------------- */
{
  ok('estimator counts word runs', estimateTokens('one two three') === 3);
  ok('estimator counts punctuation separately', estimateTokens('a, b!') === 4);
  ok('textForTokens is exact under the estimator', estimateTokens(textForTokens(257)) === 257);
  ok('textForTokens(0) is empty', textForTokens(0) === '');
}

/* ---------------- scheduled wall (simulated time model) ---------------- */
{
  ok('one slot sums durations', scheduledWallMs([10, 10, 10], 1) === 30);
  ok('three slots take the max', scheduledWallMs([10, 10, 10], 3) === 10);
  ok('greedy fill balances slots', scheduledWallMs([5, 10, 5], 2) === 10);
}

/* ---------------- workload determinism ---------------- */
{
  const a = smallPlan(); const b = smallPlan();
  ok('same seed + corpus ⇒ identical plan', JSON.stringify(a) === JSON.stringify(b));
  ok('planned total is the sum of stage plans', a.plannedTokens === a.stages.reduce((s, x) => s + x.plannedTokens, 0));
  ok('planned total lands at or under the target', a.plannedTokens <= 60_000);
  ok('planned total hugs the target (within 20k on a 60k plan)', 60_000 - a.plannedTokens < 20_000);
  const reflexCalls = a.stages.filter((s) => s.lane === 'reflex').flatMap((s) => s.calls);
  ok('reflex batches carry 64 fixed-space questions', reflexCalls.length > 0 && reflexCalls.every((c) => Object.keys(c.questions).length === REFLEX_BATCH && Object.values(c.questions).every((q) => Array.isArray(q.options) && q.options.length >= 2)));
  ok('write lane is the sliver (under 10% of planned tokens)', a.plannedByLane.write / a.plannedTokens < 0.10);
  ok('read lane dominates (over 75% of planned tokens)', a.plannedByLane.read / a.plannedTokens > 0.75);
  const stages = a.stages.map((s) => s.lane);
  ok('stages interleave lanes instead of front-loading', stages.indexOf('reflex') > 0 && stages.indexOf('reflex') < stages.length - 1);
}

/* ---------------- verdict logic (the honesty rules) ---------------- */
{
  const totals = (sustainedTokS) => ({ tokens: 10_000_000, wallMs: 10_000_000 / sustainedTokS * 1000, sustainedTokS });
  ok('real + ≥200 sustained ⇒ proven', verdictFor({ mode: 'real', totals: totals(250) }).status === 'proven');
  ok('real + exactly 200 ⇒ proven', verdictFor({ mode: 'real', totals: totals(200) }).status === 'proven');
  ok('real + under target ⇒ failed', verdictFor({ mode: 'real', totals: totals(150) }).status === 'failed');
  ok('simulated + fast ⇒ still unmeasured', verdictFor({ mode: 'simulated', totals: totals(99999) }).status === 'unmeasured');
  ok('mixed + fast ⇒ still unmeasured', verdictFor({ mode: 'mixed', totals: totals(99999) }).status === 'unmeasured');
  ok('aborted beats every other verdict', verdictFor({ mode: 'real', totals: totals(250), aborted: true }).status === 'aborted');
  ok('verdict carries its arithmetic', verdictFor({ mode: 'real', totals: totals(250) }).arithmetic.includes('250'));
}

/* ---------------- mac run requirements (the owed-run math) ---------------- */
{
  const mac = macRunRequirements({ totalTokens: 10_000_000, targetTokS: 200, models: { reflex: 'tev1', read: 'granite', write: 'granite' } });
  ok('10M at 200 tok/s is 50,000 s', mac.expectedSecondsAtTarget === 50000);
  ok('50,000 s is 13.9 h', mac.expectedHoursAtTarget === 13.9);
  ok('smoke run is 1M tokens', mac.smokeFirst.tokens === 1_000_000 && mac.smokeFirst.command.includes('--tokens 1000000'));
  ok('models to pull are deduped', mac.modelsToPull.length === 2);
}

/* ---------------- transports ---------------- */
{
  const fakeFetch = async () => ({ ok: true, json: async () => ({ prompt_eval_count: 123, eval_count: 45, prompt_eval_duration: 1000, eval_duration: 2000, response: 'x' }) });
  const t = createOllamaTransport({ fetchImpl: fakeFetch });
  const r = await t.generate({ model: 'm', prompt: 'p', genTokens: 10 });
  ok('real transport reports provider counts verbatim', t.kind === 'real' && r.promptTokens === 123 && r.generatedTokens === 45);
  const sim = createSimulatedSystemOneFetch();
  const res = await sim.fetchImpl('http://x/v1/systemone', { body: JSON.stringify({ model: 'tev1', state: 's', questions: { a: { options: ['x', 'y'] } } }) });
  const j = await res.json();
  ok('simulated systemone answers every question with probabilities', res.ok && j.answers.a.probabilities.x > 0.9 && sim.takeDurations().length === 1);
}

/* ---------------- the simulated run: smoke totals exact, metering complete ---------------- */
{
  const plan = smallPlan();
  const sink = recordingSink();
  const report = await simRun(plan, { meterSink: sink });
  ok('smoke total is EXACTLY the planned total under the counting transport', report.totals.tokens === plan.plannedTokens);
  ok('every stage token count is prompt+generated', report.stages.every((s) => s.tokens === s.promptTokens + s.generatedTokens));
  ok('stage sums equal the totals', report.stages.reduce((s, x) => s + x.tokens, 0) === report.totals.tokens);
  ok('sustained is tokens over summed stage wall', near(report.totals.sustainedTokS, report.totals.tokens * 1000 / report.wallMs, 0.2));
  ok('peak is the fastest stage rate', near(report.totals.peakTokS, Math.max(...report.stages.map((s) => s.tokS)), 0.2));
  ok('every stage is labeled simulated', report.mode === 'simulated' && report.stages.every((s) => s.measured === 'simulated'));
  ok('a simulated run can never claim proven', report.verdict.status === 'unmeasured');
  const totalCalls = plan.stages.reduce((s, x) => s + x.calls.length, 0);
  ok('the meter saw every model call exactly once', sink.calls.length === totalCalls);
  const metered = sink.calls.reduce((s, c) => s + (c.j.prompt_eval_count || 0) + (c.j.eval_count || 0), 0);
  ok('metered tokens equal reported tokens', metered === report.totals.tokens);
  ok('meter calls carry lane + kind + model (the tree conventions)', sink.calls.every((c) => c.opts.lane?.startsWith('proof-') && c.opts.kind && c.opts.model));
  ok('reflex decisions were counted as outcomes', report.outcomes.decisions === plan.calls.reflex * REFLEX_BATCH);
  ok('artifacts were counted (one digest per generative call)', report.outcomes.artifacts === plan.calls.read + plan.calls.write);
  ok('outcome-per-token summary is populated', report.outcomes.perMillionTokens.decisions > 0 && report.outcomes.perMillionTokens.artifacts > 0);
  ok('write share is the write lane share', near(report.totals.writeSharePct, plan.plannedByLane.write / plan.plannedTokens * 100, 0.6));
}

/* ---------------- report schema (what the UI consumes) ---------------- */
{
  const report = await simRun(smallPlan());
  const problems = validateReport(report);
  ok('a real harness report validates clean', problems.length === 0);
  if (problems.length) console.log('    problems:', problems);
  ok('cards mirror stages 1:1 in order', report.cards.length === report.stages.length && report.cards.every((c, i) => c.stage === report.stages[i].id && c.tokens === report.stages[i].tokens));
  ok('tiles are the four schema tiles in order', report.tiles.map((t) => t.label).join('|') === TILE_LABELS.join('|'));
  ok('TOTAL TOKENS tile shows the total', report.tiles[0].value === report.totals.tokens.toLocaleString('en-US'));
  const md = renderMarkdown(report);
  ok('markdown carries every card row', report.cards.every((c) => md.includes(c.stage) && md.includes(c.source)));
  ok('markdown states the verdict arithmetic', md.includes(report.verdict.arithmetic));
  ok('markdown lists the owed Mac run when unmeasured', md.includes(report.macRun.fullCommand));
  ok('target line is 200 tok/s by default', TARGET_TOK_S === 200 && report.target.sustainedTokS === 200);
}

/* ---------------- resume: a stopped run finishes without double-counting ---------------- */
{
  const plan = smallPlan();
  const first = await simRun(plan);
  const head = first.stages.slice(0, 2);
  const sink = recordingSink();
  const resumed = await simRun(plan, { completedStages: head, meterSink: sink });
  ok('resumed totals equal the single-run totals', resumed.totals.tokens === first.totals.tokens && resumed.wallMs === first.wallMs);
  ok('resumed stages are the same rows', JSON.stringify(resumed.stages) === JSON.stringify(first.stages));
  const remainingCalls = plan.stages.slice(2).reduce((s, x) => s + x.calls.length, 0);
  ok('resume meters only the remaining calls', sink.calls.length === remainingCalls);
}

/* ---------------- clean stop ---------------- */
{
  const controller = new AbortController();
  controller.abort();
  const report = await simRun(smallPlan(), { signal: controller.signal });
  ok('a pre-stopped run reports aborted, no stages run', report.aborted === true && report.verdict.status === 'aborted' && report.stages.length === 0);
  ok('an aborted report still validates', validateReport(report).length === 0);
}

console.log(`\nproof.test: ${passed} checks passed`);
