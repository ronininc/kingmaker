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
import { perceive as perceiveState } from './perception.mjs';
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
// op 'side': the same signed difference stated in WORDS ("35 degrees to your LEFT") — the 2026-11-16 scored run showed the
// 3B pilot mis-reading the sign of a number; words carry the direction. Still perception only, never an action.
// Perception lives in lib/perception.mjs (shared with every decision checker): state in words, never an action.
const perceive = (o) => perceiveState(o, derive, previous);
let previous = null; // the pilot's own previous decision + the observation it was made on (state history, not a plan)
const { decide } = policy ? await import(new URL('./state-conductor.mjs', import.meta.url)) : {};
const model = arg('--model'); const terminalField = arg('--terminal') ?? 'terminal';
const maxSteps = Number(arg('--max-steps') ?? 60); const log = arg('--log') ?? 'decisions.jsonl';
const base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const run = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

// --turn <field>: the pilot answers "turn" (left | straight | right) and "amount" (0..1) in WORDS; the daemon only converts
// that to the kit's signed <field> (left = negative), logging the raw answer. Measured 2026-11-16 (isolated rule test):
// Granite 3B gave the right turn direction 6/12 answering a signed number, 12/12 answering in words with words guidance.
const turnField = arg('--turn');
const VOTES = Math.max(1, Math.min(7, Number(arg('--votes') ?? 1) || 1));
const shownFields = turnField ? Object.fromEntries(Object.entries(fields).filter(([k]) => k !== turnField)) : fields;
const SYSTEM = `You are Kingmaker's pilot. You make ONE decision per observation using the method below.\nReply with ONLY a JSON object with these keys: ${turnField ? '"turn" (one of "left", "straight", "right"), "amount" (number 0 to 1, how hard to turn), ' : ''}${Object.entries(shownFields).map(([k, [lo, hi]]) => `"${k}" (number ${lo} to ${hi})`).join(', ')}, "rule" (the number of the method rule you applied), "reason" (under 12 words).
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
  // --votes N (small deciders, 2026-11-16): N samples of the SAME model decision (seeded, temperature 0.4); the turn
  // word given by a majority wins and that sample's values are used. No majority → one more deterministic call
  // (temperature 0) decides. Every sample is a model call and is logged; the daemon never chooses an action.
  const userMsg = `OBSERVATION:\n${JSON.stringify({ ...obs, ...(Object.keys(derive).length ? { derived: perceive(obs) } : {}) })}`;
  const ask = async (options) => {
    const t1 = performance.now();
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, stream: false, think: false, format: 'json', options: { num_predict: 80, ...options }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }] }) });
    const jj = await r.json();
    appendFileSync('.kingmaker-model-calls.jsonl', `${JSON.stringify({ by: 'observe-act-loop', turn, host: new URL(base).host, model, ms: Math.round(performance.now() - t1), promptTokens: jj.prompt_eval_count ?? null, evalTokens: jj.eval_count ?? null, options })}\n`);
    let dd; try { dd = JSON.parse(String(jj.message?.content ?? '')); } catch { dd = null; }
    return { j: jj, d: dd };
  };
  let j, d, votes = null;
  if (VOTES > 1 && turnField) {
    const samples = []; for (let k = 0; k < VOTES; k += 1) samples.push(await ask({ temperature: 0.4, seed: 1000 + k }));
    const word = (x) => String(x.d?.turn ?? '').toLowerCase();
    const tally = {}; for (const x of samples) if (['left', 'right', 'straight'].includes(word(x))) tally[word(x)] = (tally[word(x)] ?? 0) + 1;
    const [best, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const pick = n > VOTES / 2 ? samples.find((x) => word(x) === best) : await ask({ temperature: 0 });
    votes = { samples: samples.map((x) => x.d ? { turn: x.d.turn, amount: x.d.amount } : null), majority: n > VOTES / 2 ? best : null, tieBreak: n > VOTES / 2 ? null : 'deterministic model call' };
    ({ j, d } = pick);
  } else ({ j, d } = await ask({ temperature: 0 }));
  const ms = Math.round(performance.now() - t0);
  const raw = d ? { ...d } : null;
  if (d && turnField) { const sgn = { left: -1, right: 1, straight: 0 }[String(d.turn ?? '').toLowerCase()]; d[turnField] = sgn === undefined || !Number.isFinite(Number(d.amount)) ? NaN : sgn * Math.min(1, Math.max(0, Number(d.amount))); }
  const bad = !d || Object.keys(fields).some((k) => !Number.isFinite(Number(d[k])));
  if (bad) { console.log(`turn ${turn}: STOP — the model's reply was not a usable decision (${String(j.message?.content ?? '').slice(0, 120)}); no action was substituted`); appendFileSync(log, `${JSON.stringify({ turn, ms, stop: 'unusable-decision', raw: j.message?.content ?? null })}\n`); process.exit(4); }
  const vals = Object.fromEntries(Object.entries(fields).map(([k, [lo, hi]]) => [k, Math.min(hi, Math.max(lo, Number(d[k])))]));
  const reason = String(d.reason ?? 'model decision').replace(/[^\w .,;:%°+-]/g, '').slice(0, 80) || 'model decision';
  const decidedOn = obs;
  obs = JSON.parse(run(actCmd.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => (k === 'reason' ? reason : String(vals[k]))))));
  previous = turnField ? { turn: String(d.turn ?? '').toLowerCase(), obs: decidedOn } : null;
  appendFileSync(log, `${JSON.stringify({ turn, ms, source: 'model', raw, votes, decision: vals, reason, evalTokens: j.eval_count ?? null, after: { t: obs.t, next_mark: obs.next_mark, goal_distance: obs.goal_distance, grounded: obs.grounded } })}\n`);
  console.log(`turn ${String(turn).padStart(2)}: ${Object.entries(vals).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')} (${ms} ms) "${reason}" → t=${obs.t} mark=${obs.next_mark} dist=${obs.goal_distance}${obs.grounded ? ' GROUNDED' : ''}`);
}
console.log(obs[terminalField] ? 'terminal state reached' : `stopped after ${maxSteps} turns without a terminal state`);
