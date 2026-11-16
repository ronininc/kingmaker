#!/usr/bin/env node
// lib/observe-act-loop.mjs — Kingmaker's observe → decide → act daemon (local-brain, 2026-11-16). For tasks that are a
// sequence of decisions against a live environment (a simulator, a game, a stepwise tool), a method's run-tool step
// starts this daemon. Each turn it runs the OBSERVE command, hands the observation plus the method's GUIDANCE to the
// LOCAL model, and runs the ACT command with the model's decision. The daemon never decides: it does not compute a
// course, a fallback action or a default — an unusable reply ends the run with that reason (no improvising, no
// autopilot). Every decision is logged with its latency; output streams line by line.
//
//   node lib/observe-act-loop.mjs --observe '["python3","sim.py","observe","--run","runs/k"]'
//        --act '["python3","sim.py","step","--run","runs/k","--helm","{helm}","--sheet","{sheet}","--reason","{reason}"]'
//        --fields '{"helm":[-1,1],"sheet":[0,1]}' --guidance guidance.md --model <tag> --terminal terminal --max-steps 60
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const observeCmd = JSON.parse(arg('--observe')); const actCmd = JSON.parse(arg('--act'));
const fields = JSON.parse(arg('--fields')); const policyPath = arg('--policy'); const guidance = policyPath ? '' : readFileSync(arg('--guidance'), 'utf8');
// --policy <method.json> (kingmaker.method/1): each decision is the METHOD evaluated by Kingmaker's state-conductor (the same
// evaluator that flew the 2026-11-09 run), not model judgment. The decision source is recorded on every turn.
const policy = policyPath ? JSON.parse(readFileSync(policyPath, 'utf8')) : null;
// --derive '{"goal_off_bow":["delta","goal_bearing","heading"], …}': PERCEPTION only — signed angle differences (−180..180)
// between two observed fields, added to what the model sees. It never computes or suggests an action; the model decides.
const derive = arg('--derive') ? JSON.parse(arg('--derive')) : {};
const field = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
const perceive = (o) => { const out = {}; for (const [name, [op, a, b]] of Object.entries(derive)) if (op === 'delta') { const d = ((Number(field(o, a)) - Number(field(o, b)) + 540) % 360) - 180; if (Number.isFinite(d)) out[name] = Math.round(d); } return out; };
const { decide } = policy ? await import(new URL('./state-conductor.mjs', import.meta.url)) : {};
const model = arg('--model'); const terminalField = arg('--terminal') ?? 'terminal';
const maxSteps = Number(arg('--max-steps') ?? 60); const log = arg('--log') ?? 'decisions.jsonl';
const base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const run = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

const SYSTEM = `You are Kingmaker's pilot. You make ONE decision per observation using the method below.
Reply with ONLY a JSON object with these keys: ${Object.entries(fields).map(([k, [lo, hi]]) => `"${k}" (number ${lo} to ${hi})`).join(', ')}, "reason" (under 12 words).
METHOD:
${guidance}`;

let obs = JSON.parse(run(observeCmd));
for (let turn = 1; turn <= maxSteps && !obs[terminalField]; turn += 1) {
  const t0 = performance.now();
  if (policy) {
    const d = decide(policy, obs, fields); const ms = Math.round(performance.now() - t0);
    if (Object.keys(fields).some((k) => !Number.isFinite(d.values[k]))) { console.log(`turn ${turn}: STOP — the method produced no value for ${Object.keys(fields).filter((k) => !Number.isFinite(d.values[k])).join(', ')}`); process.exit(4); }
    const reason = `${policy.name}: ${d.why}`.slice(0, 80);
    obs = JSON.parse(run(actCmd.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => (k === 'reason' ? reason : String(d.values[k]))))));
    appendFileSync(log, `${JSON.stringify({ turn, ms, source: 'method-evaluated', method: policy.name, decision: d.values, why: d.why, after: { t: obs.t, next_mark: obs.next_mark, goal_distance: obs.goal_distance, grounded: obs.grounded } })}\n`);
    console.log(`turn ${String(turn).padStart(2)}: ${Object.entries(d.values).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(' ')} [method ${d.why}] → t=${obs.t} mark=${obs.next_mark} dist=${obs.goal_distance}${obs.grounded ? ' GROUNDED' : ''}`);
    continue;
  }
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, stream: false, format: 'json', options: { temperature: 0, num_predict: 80 }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `OBSERVATION:\n${JSON.stringify({ ...obs, ...(Object.keys(derive).length ? { derived: perceive(obs) } : {}) })}` }] }) });
  const j = await r.json(); const ms = Math.round(performance.now() - t0);
  // Every model call is recorded for the parent's report (lib/method-request.mjs reads this ledger): child-process
  // inference is never invisible.
  appendFileSync('.kingmaker-model-calls.jsonl', `${JSON.stringify({ by: 'observe-act-loop', turn, host: new URL(base).host, model, ms, promptTokens: j.prompt_eval_count ?? null, evalTokens: j.eval_count ?? null })}\n`);
  let d; try { d = JSON.parse(String(j.message?.content ?? '')); } catch { d = null; }
  const bad = !d || Object.keys(fields).some((k) => !Number.isFinite(Number(d[k])));
  if (bad) { console.log(`turn ${turn}: STOP — the model's reply was not a usable decision (${String(j.message?.content ?? '').slice(0, 120)}); no action was substituted`); appendFileSync(log, `${JSON.stringify({ turn, ms, stop: 'unusable-decision', raw: j.message?.content ?? null })}\n`); process.exit(4); }
  const vals = Object.fromEntries(Object.entries(fields).map(([k, [lo, hi]]) => [k, Math.min(hi, Math.max(lo, Number(d[k])))]));
  const reason = String(d.reason ?? 'model decision').replace(/[^\w .,;:%°+-]/g, '').slice(0, 80) || 'model decision';
  obs = JSON.parse(run(actCmd.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => (k === 'reason' ? reason : String(vals[k]))))));
  appendFileSync(log, `${JSON.stringify({ turn, ms, decision: vals, reason, evalTokens: j.eval_count ?? null, after: { t: obs.t, next_mark: obs.next_mark, goal_distance: obs.goal_distance, grounded: obs.grounded } })}\n`);
  console.log(`turn ${String(turn).padStart(2)}: ${Object.entries(vals).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')} (${ms} ms) "${reason}" → t=${obs.t} mark=${obs.next_mark} dist=${obs.goal_distance}${obs.grounded ? ' GROUNDED' : ''}`);
}
console.log(obs[terminalField] ? 'terminal state reached' : `stopped after ${maxSteps} turns without a terminal state`);
