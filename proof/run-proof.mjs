// proof/run-proof.mjs — the 10M token proof runner: executes a workload plan (proof/workload.mjs)
// through the tree's real seams, meters every stage, and renders the verdict against the
// 200 tok/s target with the arithmetic shown.
//
// Seams, all real exports of this tree:
//   reflex stages → lib/decision-router.mjs DecisionRouter (Ollama /v1/systemone), the same
//                   router the reflex layer and the pre-warm use;
//   read/write    → Ollama /api/generate through an injectable transport (proof/transport.mjs);
//   metering      → lib/token-meter.mjs meter() conventions: counts from the provider's own
//                   report (prompt_eval_count / eval_count), lane + kind + model on every call.
//                   Reflex calls carry no provider token report, so they are metered with the
//                   payload estimate and their stages say countSource 'payload-estimate'.
//
// The verdict's honesty rule (same doctrine as the cold-start bench): PROVEN requires every
// stage REAL and sustained ≥ target. Any simulated stage ⇒ UNMEASURED, however fast the fake
// was — the report then lists exactly what the Mac run needs. A real run under target ⇒ FAILED.

import { createHash } from 'node:crypto';
import { totalmem } from 'node:os';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { macClassForGb } from '../lib/model-warm.mjs';
import { meter as treeMeter } from '../lib/token-meter.mjs';
import { assembleReport, TARGET_TOK_S } from './report-schema.mjs';
import { scheduledWallMs, createSimulatedSystemOneFetch } from './transport.mjs';

const round1 = (n) => Math.round(n * 10) / 10;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Pure: the verdict. Statuses: proven | failed | unmeasured | aborted. The arithmetic string
 *  is part of the verdict — a claim without its numbers is not a proof. */
export function verdictFor({ mode, totals, targetTokS = TARGET_TOK_S, totalTokens, aborted = false }) {
  const sustained = totals?.sustainedTokS ?? null;
  const arith = sustained === null
    ? 'no tokens over no wall time — nothing to divide'
    : `${round1(sustained)} tok/s = ${totals.tokens.toLocaleString('en-US')} tokens / ${(totals.wallMs / 1000).toFixed(1)} s of stage wall`;
  if (aborted) return { status: 'aborted', targetTokS, sustainedTokS: sustained, arithmetic: `${arith} — the run was stopped before finishing; no target claim`, reason: 'stopped by the operator' };
  if (mode !== 'real') {
    return { status: 'unmeasured', targetTokS, sustainedTokS: sustained, arithmetic: `${arith} — but ${mode === 'mixed' ? 'some stages were simulated' : 'every stage was simulated'}`, reason: 'harness proven, target unmeasured — the Mac run is owed (see macRun)' };
  }
  if (sustained !== null && sustained >= targetTokS) {
    return { status: 'proven', targetTokS, sustainedTokS: sustained, arithmetic: `${arith} ≥ target ${targetTokS} tok/s, all stages REAL`, reason: null };
  }
  return { status: 'failed', targetTokS, sustainedTokS: sustained, arithmetic: `${arith} < target ${targetTokS} tok/s with all stages REAL`, reason: 'the target was missed on real measurement' };
}

/** Pure: what the Mac run needs, sized from the plan — including the honest duration math at
 *  target (10,000,000 / 200 = 50,000 s ≈ 13.9 h) and the 1M smoke run to do first. */
export function macRunRequirements({ totalTokens, targetTokS = TARGET_TOK_S, models, baseUrl = 'http://127.0.0.1:11434' }) {
  const seconds = totalTokens / targetTokS;
  return {
    baseUrl,
    modelsToPull: [...new Set(Object.values(models).filter(Boolean))],
    corpus: 'point --corpus at the brain-library / knowledge text directory for the real run; omit it and the seeded synthetic corpus stands in (labeled in the report)',
    expectedSecondsAtTarget: Math.round(seconds),
    expectedHoursAtTarget: round1(seconds / 3600),
    smokeFirst: {
      tokens: 1_000_000,
      expectedMinutesAtTarget: round1(1_000_000 / targetTokS / 60),
      command: `node scripts/run-10m-proof.mjs --tokens 1000000 --base-url ${baseUrl}`,
    },
    fullCommand: `node scripts/run-10m-proof.mjs --tokens ${totalTokens} --base-url ${baseUrl} --state proof-run-state.json --out proof-out`,
    notes: [
      'warm the seats first (--warm) so no stage pays a cold model load inside the measurement',
      'run it on the plugged-in 8 GB M3 with the disk headroom the lean install leaves; stage walls are summed, so an interrupted run resumes with --resume instead of restarting',
    ],
  };
}

async function pool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length || 1)) }, async () => {
    while (next < items.length) { const i = next; next += 1; results[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return results;
}

const defaultReflexModel = () => DecisionRouter.pickModelForMac(macClassForGb(totalmem() / 2 ** 30)).name;

/**
 * Run a plan. Options:
 *   plan          buildPlan() output (required)
 *   transport     proof transport for read/write (required) — .kind labels every such stage
 *   reflex        { model?, baseUrl?, fetchImpl?, simulated? } — a real DecisionRouter is built
 *                 from it; simulated:true swaps in the simulated System One fetch
 *   models        { read, write } Ollama tags for the generative lanes
 *   concurrency   pool width for calls inside a stage (default 4)
 *   now           clock (default performance.now) — tests inject a manual clock
 *   meterSink     (default lib/token-meter.mjs meter) — called once per model call
 *   completedStages  stage rows from an earlier partial report, to resume past
 *   signal        AbortSignal — checked between stages; a stop yields an 'aborted' report
 *   onProgress    ({type, ...}) => void — stage-start / stage-done / done events for the CLI
 *   targetTokS    the target line (default 200)
 */
export async function runProof({
  plan,
  transport,
  reflex = {},
  models = {},
  concurrency = 4,
  now = () => performance.now(),
  meterSink = treeMeter,
  completedStages = [],
  signal = null,
  onProgress = () => {},
  targetTokS = TARGET_TOK_S,
} = {}) {
  if (!plan?.stages?.length) throw new Error('run-proof: a workload plan with stages is required');
  if (!transport || typeof transport.generate !== 'function') throw new Error('run-proof: a transport with generate() is required');

  const reflexModel = reflex.model ?? defaultReflexModel();
  const simReflex = reflex.simulated ? createSimulatedSystemOneFetch({ rates: reflex.rates }) : null;
  const router = new DecisionRouter({
    model: reflexModel,
    baseUrl: reflex.baseUrl ?? 'http://127.0.0.1:11434',
    fetchImpl: simReflex ? simReflex.fetchImpl : reflex.fetchImpl,
    ...(reflex.calibration ? { calibration: reflex.calibration } : {}),
  });
  const readModel = models.read ?? 'proof-reader';
  const writeModel = models.write ?? readModel;
  const safeMeter = (j, opts) => { try { meterSink(j, opts); } catch { /* metering never breaks a run */ } };

  const done = new Map(completedStages.map((s) => [s.id, s]));
  const startedRealMs = Date.now();
  const rows = [];
  const outcomeKinds = {};
  let decisions = 0, artifacts = 0, errors = 0;

  const runGenerativeStage = async (stage) => {
    const model = stage.lane === 'write' ? writeModel : readModel;
    const t0 = now();
    const results = await pool(stage.calls, concurrency, async (call) => {
      const raw0 = now();
      const r = await transport.generate({ model, prompt: call.prompt, genTokens: call.plannedGenTokens });
      safeMeter(r.raw ?? { prompt_eval_count: r.promptTokens, eval_count: r.generatedTokens, model }, { lane: `proof-${stage.lane}`, kind: 'turn', model });
      artifacts += 1;
      return { ...r, rawMs: now() - raw0 };
    });
    const wallMs = transport.kind === 'simulated'
      ? scheduledWallMs(results.map((r) => r.durationMs ?? r.rawMs), concurrency)
      : now() - t0;
    const promptTokens = results.reduce((s, r) => s + r.promptTokens, 0);
    const generatedTokens = results.reduce((s, r) => s + r.generatedTokens, 0);
    const wall = Math.round(wallMs);
    return {
      row: {
        id: stage.id, lane: stage.lane, model, kind: stage.lane, calls: results.length,
        tokens: promptTokens + generatedTokens, promptTokens, generatedTokens,
        wallMs: wall, tokS: wall > 0 ? ((promptTokens + generatedTokens) * 1000) / wall : null,
        measured: transport.kind === 'real' ? 'real' : 'simulated',
        countSource: transport.kind === 'real' ? 'provider' : 'payload-estimate',
        source: transport.kind === 'real'
          ? `ollama /api/generate · ${model} · provider-reported counts`
          : `counting transport · ${plan.estimator} · simulated`,
        error: null,
      },
    };
  };

  const runReflexStage = async (stage) => {
    const t0 = now();
    const results = await pool(stage.calls, concurrency, async (call) => {
      const raw0 = now();
      const outcomes = await router.decide({ state: call.state, questions: call.questions });
      const answered = outcomes.filter((o) => o.kind !== 'transport-failed');
      for (const o of answered) { outcomeKinds[o.kind] = (outcomeKinds[o.kind] ?? 0) + 1; }
      decisions += answered.length;
      if (answered.length < outcomes.length) errors += 1;
      safeMeter({ prompt_eval_count: call.plannedPromptTokens, eval_count: answered.length, model: reflexModel }, { lane: 'proof-reflex', kind: 'router', model: reflexModel });
      return { promptTokens: call.plannedPromptTokens, generatedTokens: answered.length, rawMs: now() - raw0 };
    });
    const wallMs = simReflex
      ? scheduledWallMs(simReflex.takeDurations(), concurrency)
      : now() - t0;
    const promptTokens = results.reduce((s, r) => s + r.promptTokens, 0);
    const generatedTokens = results.reduce((s, r) => s + r.generatedTokens, 0);
    const wall = Math.round(wallMs);
    return {
      row: {
        id: stage.id, lane: 'reflex', model: reflexModel, kind: 'reflex', calls: results.length,
        tokens: promptTokens + generatedTokens, promptTokens, generatedTokens,
        wallMs: wall, tokS: wall > 0 ? ((promptTokens + generatedTokens) * 1000) / wall : null,
        measured: simReflex ? 'simulated' : 'real',
        countSource: 'payload-estimate',
        source: simReflex
          ? `simulated systemone fetch · ${reflexModel} · payload-estimate counts · simulated`
          : `ollama /v1/systemone · ${reflexModel} · payload-estimate counts`,
        error: null,
      },
    };
  };

  let aborted = false;
  for (const [index, stage] of plan.stages.entries()) {
    if (done.has(stage.id)) { rows.push(done.get(stage.id)); continue; }
    if (signal?.aborted) { aborted = true; break; }
    onProgress({ type: 'stage-start', stage: stage.id, lane: stage.lane, index, totalStages: plan.stages.length });
    const { row } = stage.lane === 'reflex' ? await runReflexStage(stage) : await runGenerativeStage(stage);
    rows.push(row);
    const cumulative = rows.reduce((s, r) => s + r.tokens, 0);
    const wallSoFar = rows.reduce((s, r) => s + r.wallMs, 0);
    onProgress({ type: 'stage-done', stage: row.id, lane: row.lane, row, tokens: row.tokens, cumulativeTokens: cumulative, sustainedTokS: wallSoFar > 0 ? (cumulative * 1000) / wallSoFar : null, index, totalStages: plan.stages.length });
  }

  const wallMs = rows.reduce((s, r) => s + r.wallMs, 0);
  const mode = rows.every((r) => r.measured === 'real') ? 'real' : rows.every((r) => r.measured === 'simulated') ? 'simulated' : 'mixed';
  const totalsPreview = { tokens: rows.reduce((s, r) => s + r.tokens, 0), wallMs, sustainedTokS: wallMs > 0 ? (rows.reduce((s, r) => s + r.tokens, 0) * 1000) / wallMs : null };
  const verdict = verdictFor({ mode, totals: totalsPreview, targetTokS, totalTokens: plan.totalTokens, aborted });
  const perMillion = totalsPreview.tokens > 0
    ? { decisions: round1(decisions / (totalsPreview.tokens / 1e6)), artifacts: round1(artifacts / (totalsPreview.tokens / 1e6)) }
    : { decisions: 0, artifacts: 0 };
  const report = assembleReport({
    target: { totalTokens: plan.totalTokens, sustainedTokS: targetTokS },
    mode,
    startedAt: new Date(startedRealMs).toISOString(),
    finishedAt: new Date(Date.now()).toISOString(),
    wallMs,
    stages: rows,
    outcomes: { decisions, decisionsByKind: outcomeKinds, artifacts, errors, perMillionTokens: perMillion, planDigest: sha256(JSON.stringify(plan.stages.map((s) => [s.id, s.plannedTokens]))) },
    verdict,
    macRun: macRunRequirements({ totalTokens: plan.totalTokens, targetTokS, models: { reflex: reflexModel, read: readModel, write: writeModel }, baseUrl: reflex.baseUrl ?? 'http://127.0.0.1:11434' }),
    aborted,
  });
  onProgress({ type: 'done', report });
  return report;
}

/** The markdown summary: tiles first (the headline), then one evidence row per card — the
 *  same rows, in the same order, carrying the same source lines the UI cards will show. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# 10M Token Proof — verdict: ${report.verdict.status.toUpperCase()}`);
  lines.push('');
  lines.push(`mode: ${report.mode}${report.aborted ? ' · aborted' : ''} · wall: ${(report.wallMs / 1000).toFixed(1)} s of stage wall · target: ${report.target.totalTokens.toLocaleString('en-US')} tokens at ${report.target.sustainedTokS} tok/s sustained`);
  lines.push('');
  lines.push('| tile | value |');
  lines.push('| --- | --- |');
  for (const t of report.tiles) lines.push(`| ${t.label} | ${t.value} |`);
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push('| stage | lane | tokens | tok/s | measured | source |');
  lines.push('| --- | --- | ---: | ---: | --- | --- |');
  for (const c of report.cards) lines.push(`| ${c.stage} | ${c.lane} | ${c.tokens.toLocaleString('en-US')} | ${c.tokS === null ? '—' : round1(c.tokS)} | ${c.measured} | ${c.source} |`);
  lines.push('');
  lines.push('## Lanes');
  lines.push('');
  lines.push('| lane | tokens | stages | tok/s |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [lane, r] of Object.entries(report.lanes)) lines.push(`| ${lane} | ${r.tokens.toLocaleString('en-US')} | ${r.stages} | ${r.tokS === null ? '—' : round1(r.tokS)} |`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(report.verdict.arithmetic + (report.verdict.reason ? ` — ${report.verdict.reason}` : ''));
  lines.push('');
  lines.push(`outcomes: ${report.outcomes.decisions.toLocaleString('en-US')} reflex decisions, ${report.outcomes.artifacts.toLocaleString('en-US')} artifacts — ${report.outcomes.perMillionTokens.decisions} decisions and ${report.outcomes.perMillionTokens.artifacts} artifacts per 1M tokens`);
  if (report.verdict.status === 'unmeasured') {
    lines.push('');
    lines.push('## The Mac run this is owed');
    lines.push('');
    lines.push(`- models to pull: ${report.macRun.modelsToPull.join(', ') || '—'}`);
    lines.push(`- corpus: ${report.macRun.corpus}`);
    lines.push(`- expected at target: ${report.macRun.expectedSecondsAtTarget.toLocaleString('en-US')} s ≈ ${report.macRun.expectedHoursAtTarget} h for the full run`);
    lines.push(`- smoke first (${report.macRun.smokeFirst.tokens.toLocaleString('en-US')} tokens, ≈${report.macRun.smokeFirst.expectedMinutesAtTarget} min at target): \`${report.macRun.smokeFirst.command}\``);
    lines.push(`- full: \`${report.macRun.fullCommand}\``);
    for (const n of report.macRun.notes) lines.push(`- ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}
