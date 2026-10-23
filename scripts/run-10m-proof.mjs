#!/usr/bin/env node
// scripts/run-10m-proof.mjs — the minimal control surface for the 10M token proof: start it,
// watch it, stop it clean, resume it where it stopped. Standalone on purpose — the proof does
// not wait for the console, and the console's files stay untouched.
//
//   node scripts/run-10m-proof.mjs                          simulated run (VM): harness proof
//   node scripts/run-10m-proof.mjs --tokens 1000000 --base-url http://127.0.0.1:11434 --warm
//                                                           the 1M smoke run on the Mac
//   node scripts/run-10m-proof.mjs --base-url http://127.0.0.1:11434 --state proof-state.json --out proof-out
//                                                           the full 10M, resumable
//   node scripts/run-10m-proof.mjs --base-url ... --state proof-state.json --resume
//
// Live lines print stage, cumulative tokens, and the sustained rate so far. SIGINT/SIGTERM
// stop between stages and still write the (aborted) report + state. Exit codes: 0 proven or
// simulated-complete, 1 target failed on a real run, 130 stopped, 2 usage.

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildPlan, loadCorpus, syntheticCorpus } from '../proof/workload.mjs';
import { createCountingTransport, createOllamaTransport } from '../proof/transport.mjs';
import { runProof, renderMarkdown } from '../proof/run-proof.mjs';
import { TARGET_TOK_S, DEFAULT_TOTAL_TOKENS } from '../proof/report-schema.mjs';
import { classRole } from '../lib/mac-profiles.mjs';
import { prewarmModels, prewarmReflex } from '../lib/model-warm.mjs';

const { values } = parseArgs({
  options: {
    tokens: { type: 'string', default: String(DEFAULT_TOTAL_TOKENS) },
    seed: { type: 'string', default: '1' },
    corpus: { type: 'string' },
    'base-url': { type: 'string' },
    'reflex-model': { type: 'string' },
    'read-model': { type: 'string' },
    'write-model': { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    simulate: { type: 'boolean', default: false },
    warm: { type: 'boolean', default: false },
    out: { type: 'string' },
    state: { type: 'string' },
    resume: { type: 'boolean', default: false },
    'target-tok-s': { type: 'string', default: String(TARGET_TOK_S) },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log('usage: run-10m-proof.mjs [--tokens N] [--seed N] [--corpus DIR] [--base-url URL] [--simulate] [--warm] [--reflex-model M] [--read-model M] [--write-model M] [--concurrency N] [--state FILE] [--resume] [--out DIR] [--target-tok-s N]');
  process.exit(0);
}

const totalTokens = Number(values.tokens);
const targetTokS = Number(values['target-tok-s']);
if (!Number.isFinite(totalTokens) || totalTokens <= 0 || !Number.isFinite(targetTokS) || targetTokS <= 0) {
  console.error('run-10m-proof: --tokens and --target-tok-s must be positive numbers');
  process.exit(2);
}
const simulated = values.simulate || !values['base-url'];
const baseUrl = values['base-url'] ?? 'http://127.0.0.1:11434';

const corpus = values.corpus
  ? loadCorpus(values.corpus).chunks
  : syntheticCorpus({ seed: Number(values.seed) });
const plan = buildPlan({ totalTokens, seed: Number(values.seed), corpus });
const planKey = createHash('sha256').update(JSON.stringify([plan.seed, plan.totalTokens, plan.stages.map((s) => [s.id, s.plannedTokens])])).digest('hex');

let completedStages = [];
if (values.resume) {
  if (!values.state || !existsSync(values.state)) { console.error('run-10m-proof: --resume needs an existing --state file'); process.exit(2); }
  const saved = JSON.parse(readFileSync(values.state, 'utf8'));
  if (saved.planKey !== planKey) { console.error('run-10m-proof: the state file belongs to a different plan (seed/tokens/corpus changed) — refusing to resume across plans'); process.exit(2); }
  completedStages = saved.completedStages ?? [];
  console.log(`[proof] resuming: ${completedStages.length} stage(s) already done`);
}

const readModel = values['read-model'] ?? classRole('writer');
const writeModel = values['write-model'] ?? readModel;
const transport = simulated ? createCountingTransport() : createOllamaTransport({ baseUrl });

if (values.warm && !simulated) {
  console.log('[proof] warming seats…');
  const warmReflex = await prewarmReflex({ baseUrl, ...(values['reflex-model'] ? { model: values['reflex-model'] } : {}) });
  console.log(`[proof] reflex warm: ${warmReflex.model} ${warmReflex.ok ? 'ok' : `missed (${warmReflex.error})`}`);
  const warmSeats = await prewarmModels({ models: [readModel, writeModel], baseUrl });
  for (const w of warmSeats) console.log(`[proof] seat warm: ${w.model} ${w.ok ? 'ok' : `missed (${w.error})`}`);
}

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`\n[proof] ${sig} — stopping after the current stage…`); controller.abort(); });

const stateRows = [...completedStages];
const saveState = () => {
  if (!values.state) return;
  const tmp = `${values.state}.tmp`;
  writeFileSync(tmp, JSON.stringify({ planKey, savedAt: new Date().toISOString(), completedStages: stateRows }, null, 2));
  renameSync(tmp, values.state);
};

console.log(`[proof] plan: ${plan.stages.length} stages, ${plan.plannedTokens.toLocaleString('en-US')} planned tokens (read ${plan.calls.read} calls · reflex ${plan.calls.reflex} · write ${plan.calls.write}) — mode: ${simulated ? 'SIMULATED (harness proof only)' : `REAL against ${baseUrl}`}`);
const report = await runProof({
  plan,
  transport,
  reflex: { baseUrl, simulated, ...(values['reflex-model'] ? { model: values['reflex-model'] } : {}) },
  models: { read: readModel, write: writeModel },
  concurrency: Number(values.concurrency) || 4,
  completedStages,
  signal: controller.signal,
  targetTokS,
  onProgress: (ev) => {
    if (ev.type === 'stage-done') {
      stateRows.push(ev.row);
      saveState();
      console.log(`[proof] stage ${ev.index + 1}/${ev.totalStages} · ${ev.stage} · +${ev.tokens.toLocaleString('en-US')} tokens · total ${ev.cumulativeTokens.toLocaleString('en-US')} · sustained ${ev.sustainedTokS === null ? '—' : ev.sustainedTokS.toFixed(1)} tok/s`);
    }
  },
});

if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(values.out, 'report.md'), renderMarkdown(report));
  console.log(`[proof] report written to ${values.out}/report.json and report.md`);
}
console.log('');
for (const t of report.tiles) console.log(`  ${t.label}: ${t.value}`);
console.log(`  verdict: ${report.verdict.status.toUpperCase()} — ${report.verdict.arithmetic}`);
if (report.verdict.status === 'unmeasured') console.log(`  the Mac run: ${report.macRun.fullCommand} (smoke first: ${report.macRun.smokeFirst.command})`);

process.exit(report.aborted ? 130 : report.verdict.status === 'failed' ? 1 : 0);
