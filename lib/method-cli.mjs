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
  const approve = async ({ tool, path, args: argv }) => {
    console.log(`Kingmaker wants to run: ${path} ${argv.map((a) => JSON.stringify(a)).join(' ')}  (in ${workDir})`);
    if (args.includes('--approve')) { console.log('Approved by --approve.'); return true; }
    if (!process.stdin.isTTY) { console.log('Not approved (no terminal to ask; pass --approve to allow this one run).'); return false; }
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y(es)?$/i.test((await rl.question(`Run ${tool}? [y/N] `)).trim()); rl.close(); return ok;
  };
  const onOutput = (stream, line) => { if (!args.includes('--json')) process.stdout.write(`${stream === 'stderr' ? '!' : '|'} ${line}\n`); };
  const report = await handleMethodRequest(text, { brain: createLocalBrain({ state: paths.state }), workDir, approve, onOutput });
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
    const steps = positional(rest, ['--dir']).map((request) => ({ request: request.replace(/\{\{steps\.[^}]+\}\}/g, '').trim(), inputs: { prompt: request } }));
    if (steps.length < 2) { console.error('usage: kingmaker method chain "<request 1>" "<request 2 — may use {{steps.0.answer}}>" …'); return 2; }
    const brain = createLocalBrain({ state: paths.state });
    const workDir = flag(rest, '--dir') ?? join(paths.state, 'tasks', `chain-${stamp()}`);
    const t0 = performance.now();
    const { toolRunnerFor } = await import('./method-request.mjs');
    const toolRunner = toolRunnerFor(paths.state, { approve: async ({ tool, args: argv }) => { console.log(`approval ${rest.includes('--approve') ? 'given (--approve)' : 'REFUSED (no --approve)'}: ${tool} ${argv.join(' ')}`); return rest.includes('--approve'); },
      onOutput: (stream, line) => { if (!rest.includes('--json')) process.stdout.write(`${stream === 'stderr' ? '!' : '|'} ${line}\n`); } });
    const { value: chain, ledger } = await withNetworkLedger(() => brain.loop.runChain(steps, { workDir, toolRunner }));
    const out = { status: chain.status, haltedAt: chain.haltedAt ?? null, reason: chain.reason ?? null, ms: Math.round(performance.now() - t0), network: { requests: ledger.requests.length, external: ledger.external, externalInference: ledger.externalInference },
      steps: chain.steps.map((s) => {
        const tool = Object.values(s.conduction?.outputs ?? {}).filter((v) => v && typeof v === 'object' && Array.isArray(v.lines) && !(v.argv ?? []).includes('--version')).at(-1);
        const objective = (s.conduction?.trace ?? []).some((t) => t.type === 'verify' && t.objective === true && t.status === 'executed');
        return { method: s.conduction?.method?.id ?? null, status: s.refused ? 'refused' : s.conduction?.status, verified: objective, argv: tool?.argv ?? null,
          output: tool ? String(tool.stdout ?? '').trim().slice(0, 300) : String(s.conduction?.outputs?.answer ?? '').slice(0, 300), hunt: s.trace.find((x) => x.phase === 'method-hunt')?.result?.status ?? null };
      }), workDir };
    out.verified = out.status === 'completed' && out.steps.every((st) => st.verified);
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else { for (const [i, s] of out.steps.entries()) console.log(`step ${i}: ${s.method} ${s.status}, ${s.verified ? 'objective verified' : 'result NOT verified'}${s.argv ? ` — ran ${JSON.stringify(s.argv)}` : ''} — output: ${s.output || '(nothing)'}`); console.log(`chain ${out.status === 'completed' ? (out.verified ? 'completed and verified' : 'ran every step, but the results are NOT verified') : out.status}${out.reason ? `: ${out.reason}` : ''} in ${out.ms} ms; network ${out.network.requests} request(s), external inference ${out.network.externalInference}.`); }
    return chain.status === 'completed' ? 0 : 1;
  }
  console.error('usage: kingmaker method list | new "<task>" --sample "<input>" | chain "<req>" "<req>" …');
  return 2;
}

export async function cmdDevice(args) {
  const plan = firstRunModelPlan(detectDevice(), { installed: await installed() });
  if (args.includes('--pull') && plan.pull) { plan.use = { tag: plan.pull, gb: plan.best.gb, needsPull: true };
    console.log(`Pulling ${plan.use.tag} (${plan.use.gb} GB) into the local runner…`);
    const r = await fetch(`${base()}/api/pull`, { method: 'POST', body: JSON.stringify({ model: plan.use.tag, stream: false }) });
    console.log(r.ok ? 'Pulled.' : `Pull failed: HTTP ${r.status}`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(plan, null, 2)); else for (const l of plan.why) console.log(l);
  return 0;
}

/** kingmaker tools scan [--yes|--no] [--select a,b] [--confirm-use a,b] [--json] — consent-first discovery + adoption. */
export async function cmdToolsScan(args) {
  const { SCAN_CONSENT, scanPath, adoptTool } = await import('./tool-discovery.mjs');
  const paths = resolvePaths();
  for (const l of SCAN_CONSENT) console.log(l);
  let consent = args.includes('--yes') ? true : args.includes('--no') ? false : null;
  if (consent === null) {
    if (!process.stdin.isTTY) { console.log('No answer given (not a terminal): the scan was skipped. Run with --yes to scan, or skip it.'); return 0; }
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    consent = /^y(es)?$/i.test((await rl.question('Scan for installed tools now? [y/N] ')).trim()); rl.close();
  }
  if (!consent) { console.log('Skipped. Nothing was scanned. You can run `kingmaker tools scan` any time.'); return 0; }
  const found = scanPath();
  const select = (flag(args, '--select') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const confirmed = new Set((flag(args, '--confirm-use') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  console.log(`Found ${found.length} installed program(s) on your PATH (installed — not necessarily used).`);
  if (!select.length) { console.log('Choose the ones Kingmaker should support: kingmaker tools scan --yes --select jq,git'); if (args.includes('--json')) console.log(JSON.stringify(found.map((t) => t.name))); return 0; }
  const results = [];
  for (const name of select) {
    const t = found.find((x) => x.name === name);
    if (!t) { console.log(`${name}: not found on PATH — skipped`); results.push({ name, status: 'not-found' }); continue; }
    let docs = null;
    if (args.includes('--docs')) {
      const { fetchOfficialDocs, OFFICIAL_DOCS } = await import('./tool-docs.mjs');
      if (OFFICIAL_DOCS[name]) { try { docs = await fetchOfficialDocs(name); console.log(`${name}: official docs ${docs.url} (${docs.licence}) — ${docs.quoted.length} examples quoted with attribution`); } catch (e) { console.log(`${name}: official docs not retrieved (${e.message}); the draft says so`); } }
      else console.log(`${name}: no registered official documentation source — none fetched`);
    }
    const r = await adoptTool({ name, path: t.path, state: paths.state, userConfirmedUse: confirmed.has(name), docs });
    console.log(`${name}: ${r.probe.version ?? 'version unknown'} → method ${r.id} ${r.methodStatus ?? ''} (${r.status}) at ${r.path}`);
    results.push({ name, ...r, probe: { version: r.probe.version, path: r.probe.path, sources: r.probe.sources } });
  }
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  return results.every((r) => r.status !== 'not-found') ? 0 : 1;
}
