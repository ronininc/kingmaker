// lib/method-cli.mjs — the headless surfaces for local-brain methods (2026-11-16):
//   kingmaker ask "<plain language>" [--json] [--dir <workdir>]   the request → method → dispatch → checks → report
//   kingmaker method list                                          every method this device can run, by layer
//   kingmaker method new "<task>" --sample "<input>" [--expect "<text>"] [--source <file>]
//                                                                  write your own method: draft, test, promote
//   kingmaker method chain "<request>" "<request>" … [--json]      chain methods; {{steps.N.answer}} binds outputs
//   kingmaker device [--json] [--pull]                             this device's facts + the explained starting brain
// Everything runs on this device; no hosted model is called.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolvePaths } from './paths.mjs';
import { LAYER_NAMES, createLocalBrain, handleMethodRequest, withNetworkLedger } from './method-request.mjs';
import { localModelTurn } from './local-turn.mjs';
import { detectDevice, firstRunModelPlan } from './mac-profiles.mjs';
import { writeMethod } from './method-writing.mjs';

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const positional = (args, valueFlags = []) => args.filter((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const base = () => process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function installed() { try { return (await (await fetch(`${base()}/api/tags`)).json()).models.map((m) => m.name); } catch { return []; } }

export async function cmdAsk(args) {
  const text = positional(args, ['--dir']).join(' ').trim();
  if (!text) { console.error('usage: kingmaker ask "<what you want done>" [--json] [--dir <workdir>]'); return 2; }
  const paths = resolvePaths();
  const workDir = flag(args, '--dir') ?? join(paths.state, 'tasks', `ask-${stamp()}`);
  mkdirSync(workDir, { recursive: true });
  const report = await handleMethodRequest(text, { brain: createLocalBrain({ state: paths.state }), workDir });
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2)); else for (const l of report.lines) console.log(l);
  return report.outcome === 'completed' ? 0 : 1;
}

export async function cmdMethod(args) {
  const paths = resolvePaths();
  const [verb, ...rest] = args;
  if (verb === 'list') {
    const brain = createLocalBrain({ state: paths.state });
    for (const m of await brain.loop.conductor.listMethods()) console.log(`${(LAYER_NAMES[m.layer] ?? m.layer).padEnd(16)} ${m.id.padEnd(34)} v${m.version}  ${m.title}`);
    return 0;
  }
  if (verb === 'new') {
    const task = positional(rest, ['--sample', '--expect', '--source']).join(' ').trim();
    const sample = flag(rest, '--sample');
    if (!task || !sample) { console.error('usage: kingmaker method new "<task>" --sample "<test input>" [--expect "<text the answer must contain>"] [--source <file>]'); return 2; }
    const plan = firstRunModelPlan(detectDevice(), { installed: await installed() });
    const model = flag(rest, '--model') ?? plan.use?.tag;
    const { value: r, ledger } = await withNetworkLedger(() => writeMethod({
      task, sample, expect: flag(rest, '--expect') ?? '', sourcePath: flag(rest, '--source'), model,
      draft: (prompt) => localModelTurn(model, prompt, { temperature: 0, base: base() }),
      reasoner: ({ preamble, prompt }) => localModelTurn(model, prompt, { brief: preamble, temperature: 0, base: base() }),
      userStore: join(paths.state, 'abilities', 'methods'), draftsDir: join(paths.state, 'abilities', 'drafts'),
    }));
    if (args.includes('--json')) console.log(JSON.stringify({ ...r, network: ledger }, null, 2));
    else {
      console.log(r.status === 'promoted' ? `Saved your method ${r.id} to your library (${r.path}).` : `Not saved: ${r.reason}. The draft and its test trace are in ${r.draftDir}.`);
      console.log(`Test on "${r.receipt.test.sample}": ${r.receipt.test.status}, check ${r.receipt.test.verify} — answer: ${r.receipt.test.answer}`);
      console.log(`Armor scan: ${r.receipt.scan.verdict} (${r.receipt.scan.limitation}). Network: ${ledger.requests.length} request(s), ${ledger.external} off-device, external inference ${ledger.externalInference}.`);
    }
    return r.status === 'promoted' ? 0 : 1;
  }
  if (verb === 'chain') {
    const steps = positional(rest, ['--dir']).map((request) => ({ request, inputs: { prompt: request } }));
    if (steps.length < 2) { console.error('usage: kingmaker method chain "<request 1>" "<request 2 — may use {{steps.0.answer}}>" …'); return 2; }
    const brain = createLocalBrain({ state: paths.state });
    const workDir = flag(rest, '--dir') ?? join(paths.state, 'tasks', `chain-${stamp()}`);
    const t0 = performance.now();
    const { value: chain, ledger } = await withNetworkLedger(() => brain.loop.runChain(steps, { workDir }));
    const out = { status: chain.status, haltedAt: chain.haltedAt ?? null, reason: chain.reason ?? null, ms: Math.round(performance.now() - t0), network: { requests: ledger.requests.length, external: ledger.external, externalInference: ledger.externalInference },
      steps: chain.steps.map((s) => ({ method: s.conduction?.method?.id ?? null, status: s.refused ? 'refused' : s.conduction?.status, answer: String(s.conduction?.outputs?.answer ?? '').slice(0, 300), hunt: s.trace.find((x) => x.phase === 'method-hunt')?.result?.status ?? null })), workDir };
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else { for (const [i, s] of out.steps.entries()) console.log(`step ${i}: ${s.method} ${s.status}${s.hunt ? ` (hunt ${s.hunt})` : ''} — ${s.answer}`); console.log(`chain ${out.status}${out.reason ? `: ${out.reason}` : ''} in ${out.ms} ms; network ${out.network.requests} request(s), external inference ${out.network.externalInference}.`); }
    return chain.status === 'completed' ? 0 : 1;
  }
  console.error('usage: kingmaker method list | new "<task>" --sample "<input>" | chain "<req>" "<req>" …');
  return 2;
}

export async function cmdDevice(args) {
  const plan = firstRunModelPlan(detectDevice(), { installed: await installed() });
  if (args.includes('--pull') && plan.use?.needsPull) {
    console.log(`Pulling ${plan.use.tag} (${plan.use.gb} GB) into the local runner…`);
    const r = await fetch(`${base()}/api/pull`, { method: 'POST', body: JSON.stringify({ model: plan.use.tag, stream: false }) });
    console.log(r.ok ? 'Pulled.' : `Pull failed: HTTP ${r.status}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2)); else for (const l of plan.why) console.log(l);
  return 0;
}
