// lib/state-conductor.mjs — THE STATE-DRIVEN TOOL CONDUCTOR (4.4.5 chat-route fix, 2026-11-09). General, for any kit.
// A task whose docs expose a command-line tool with a start/init command and a step/act command that returns a JSON
// state is conducted here, deterministically: read the docs → discover the commands (the docs' own command lines, then
// the tool's own --help for each subcommand's flags) → start → loop { read the state → decide every action value with
// method math from a method file → act → read the new state } until the state says it is over (terminal/done/finished/
// game_over) or the step budget ends → run the docs' remaining commands (verify, render, export…) exactly as written.
// Decisions come from method files (JSON, *.method.json in the bundled catalog/methods or Kingmaker's own methods folder),
// picked by how well their required state fields and action names match this tool. A method file is reusable by any tool
// whose state carries the fields it names. With no matching method, the local model picks each step's values from the
// state (one JSON object per step), clamped to the documented ranges. Nothing here knows any particular kit.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, cpSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const PY = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => existsSync(p)) || 'python3';
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) || process.execPath;
const SUB = { init: /^(?:init|start|new|begin|create|setup)$/i, step: /^(?:step|act|move|action|play|turn|control)$/i, observe: /^(?:observe|state|status|look|obs)$/i };
const OVER = ['terminal', 'done', 'finished_or_timeout', 'game_over', 'is_terminal', 'over'];

const exec = (argv, cwd, timeoutMs = 300_000) => new Promise((ok) => {
  const [cmd, ...args] = argv; const file = /^python3?$/.test(cmd) ? PY : cmd === 'node' ? NODE : cmd;
  execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: 'en_US.UTF-8' } },
    (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out || ''), err: String(err || '') }));
});
export const words = (line) => (String(line).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^["']|["']$/g, ''));
/** The JSON object a command printed (the last top-level {...}). */
export function lastJson(text) {
  const s = String(text).trim(); try { const v = JSON.parse(s); if (v && typeof v === 'object') return v; } catch { /* below */ }
  const starts = [...s.matchAll(/(^|\n)\{/g)].map((m) => m.index + m[1].length).reverse();
  for (const i of starts) { try { const v = JSON.parse(s.slice(i)); if (v && typeof v === 'object') return v; } catch { /* earlier */ } }
  return null;
}
/** Command lines the docs give (python3/python/node + a script that exists here). */
export function docCommands(docs, cwd) {
  const out = [];
  for (const raw of String(docs).split('\n')) {
    const line = raw.replace(/^\s*(?:\$|>)\s*/, '').replace(/`/g, '').trim();
    const w = words(line); if (w.length < 2 || !/^(?:python3?|node)$/.test(w[0]) || !existsSync(resolve(cwd, w[1]))) continue;
    if (w.some((a) => isAbsolute(a) || a.split(/[\\/]/).includes('..'))) continue;
    if (!out.some((o) => o.join(' ') === w.join(' '))) out.push(w);
  }
  return out;
}
/** Documented numeric ranges: `--name` (lo to hi) / --name lo..hi / --name between lo and hi. */
export function docRanges(docs) {
  const r = {}; const re = /--([\w-]+)`?\s*\(?\s*(?:from\s+|between\s+)?(-?\d+(?:\.\d+)?)\s*(?:to|\.\.|and|–|-)\s*(-?\d+(?:\.\d+)?)/g;
  for (const m of String(docs).matchAll(re)) r[m[1]] = [Number(m[2]), Number(m[3])];
  return r;
}
/** The flags a subcommand takes, from its own --help (argparse / commander / click style). */
export async function helpFlags(script, sub, cwd) {
  const h = await exec([script[0], script[1], sub, '--help'], cwd, 20_000);
  const text = `${h.out}\n${h.err}`; const usage = (text.match(/usage:[\s\S]*?(?:\n\s*\n|$)/i) || [text])[0];
  const flags = [...new Set([...usage.matchAll(/--([\w-]+)/g)].map((m) => m[1]))].filter((f) => f !== 'help');
  return { flags, ok: h.code === 0 };
}
/** Discover the tool: init + step (+ observe) commands and the step's action flags. → null when the docs show no such tool. */
export async function discover(docs, cwd) {
  const cmds = docCommands(docs, cwd);
  const init = cmds.find((w) => SUB.init.test(w[2] || ''));
  const script = init ? init.slice(0, 2) : cmds[0]?.slice(0, 2);
  if (!script) return null;
  // The step subcommand: the docs' own word ("one `x step` per observation"), else the tool's --help list.
  const top = await exec([script[0], script[1], '--help'], cwd, 20_000);
  const subs = [...new Set([...`${top.out}${top.err}`.matchAll(/\{([\w,-]+)\}/g)].flatMap((m) => m[1].split(',')))];
  const named = [...String(docs).matchAll(/\b([\w-]+\.(?:py|mjs|js))\s+([\w-]+)\b/g)].filter((m) => m[1] === script[1].split('/').pop()).map((m) => m[2]);
  const stepSub = [...named, ...subs].find((s) => SUB.step.test(s));
  if (!init || !stepSub) return null;
  const observeSub = subs.find((s) => SUB.observe.test(s)) || null;
  const step = await helpFlags(script, stepSub, cwd);
  const initArgs = Object.fromEntries(init.slice(3).map((w, i, a) => (w.startsWith('--') ? [w.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true] : null)).filter(Boolean));
  const shared = step.flags.filter((f) => f in initArgs);            // e.g. the run/session/game id the start made
  const ranges = docRanges(docs);
  const actions = step.flags.filter((f) => !shared.includes(f) && ranges[f]);
  const notes = step.flags.filter((f) => !shared.includes(f) && !ranges[f]); // free-text flags (a reason, a note)
  const after = cmds.filter((w) => w !== init && !SUB.step.test(w[2] || '') && !SUB.init.test(w[2] || ''));
  return { script, init, stepSub, observeSub, shared: Object.fromEntries(shared.map((f) => [f, initArgs[f]])), actions, ranges, notes, after };
}
const delta = (a, b) => ((b - a + 540) % 360) - 180;
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const get = (state, ref, scope) => (typeof ref === 'number' ? ref : String(ref).startsWith('$') ? scope[String(ref).slice(1)] : String(ref).split('.').reduce((o, k) => o?.[k], state));
/** Method math: evaluate one method file's rules on a state → { values, why }. */
export function decide(method, state, ranges) {
  const scope = {}; const values = {}; const why = [];
  for (const rule of method.rules || []) {
    let v = null;
    if (rule.type === 'bearing') {          // a wanted direction, kept out of a forbidden cone around another direction
      let want = Number(get(state, rule.toward, scope));
      if (rule.avoid) { const from = Number(get(state, rule.avoid.around, scope)); const off = delta(from, want);
        // A goal with a size (a circle of radius r at distance d) is reached anywhere inside it: aim at its edge nearest
        // the open side, asin(0.8·r/d) off its centre, and go straight when that edge is already outside the cone.
        const r = Number(get(state, rule.radius ?? '', scope)), d = Number(get(state, rule.distance ?? '', scope));
        if (Math.abs(off) < rule.avoid.min && r > 0 && d > r) { const shift = Math.asin(Math.min(1, (rule.radius_factor ?? 0.8) * r / d)) * 180 / Math.PI; const h = Number(get(state, rule.avoid.side_by ?? rule.toward, scope)); const toward = delta(from, h) >= 0 ? 1 : -1; const w2 = want + toward * shift; if (Math.abs(delta(from, w2)) >= rule.avoid.min) want = w2; }
        if (Math.abs(delta(from, want)) < rule.avoid.min) { const heading = Number(get(state, rule.avoid.side_by ?? rule.toward, scope)); const sideA = (from + rule.avoid.min + 360) % 360, sideB = (from - rule.avoid.min + 360) % 360;
          want = Math.abs(delta(heading, sideA)) <= Math.abs(delta(heading, sideB)) ? sideA : sideB; } }
      v = (want + 360) % 360;
    } else if (rule.type === 'turn') {      // proportional correction from the current direction to a wanted one, damped by its rate
      const err = delta(Number(get(state, rule.from, scope)), Number(get(state, rule.to, scope))) - (rule.damp ? Number(get(state, rule.damp.by, scope) || 0) * rule.damp.seconds : 0);
      v = err * rule.gain;
    } else if (rule.type === 'angle_linear') { // a value from the angle between two directions: (|angle| - sub) / div
      v = (Math.abs(delta(Number(get(state, rule.a, scope)), Number(get(state, rule.b, scope)))) - (rule.sub || 0)) / (rule.div || 1);
    } else if (rule.type === 'const') v = rule.value;
    if (v == null || !Number.isFinite(v)) continue;
    if (rule.clip) v = clamp(v, rule.clip);
    scope[rule.name] = v; why.push(`${rule.name}=${Math.round(v * 100) / 100}`);
    if (rule.action) values[rule.action] = Math.round(clamp(v, ranges[rule.action] || [-Infinity, Infinity]) * 1000) / 1000;
  }
  return { values, why: why.join(' ') };
}
/** Method files, best match first: every required field in the state, every action it sets a flag of this tool. */
export function pickMethod(dirs, state, actions) {
  const found = [];
  for (const d of dirs) { if (!existsSync(d)) continue; for (const n of readdirSync(d).filter((x) => x.endsWith('.method.json'))) {
    try { const m = JSON.parse(readFileSync(join(d, n), 'utf8')); m.file = join(d, n);
      const req = m.requires || []; const sets = (m.rules || []).map((r) => r.action).filter(Boolean);
      if (req.every((f) => get(state, f, {}) !== undefined) && actions.every((a) => sets.includes(a))) found.push({ m, score: req.length + (m.tuned_from ? 0.5 : 0) });
    } catch { /* a broken method file is skipped */ } } }
  return found.sort((a, b) => b.score - a.score)[0]?.m || null;
}
const isOver = (s) => OVER.some((k) => s?.[k] === true) || GOAL_FIELDS.some((k) => s?.[k] === true);
const GOAL_FIELDS = ['finished', 'success', 'solved', 'won', 'passed', 'completed', 'complete', 'goal_reached', 'done_ok'];
const PROGRESS = /(?:^|_)(?:mark|marks|checkpoint|checkpoints|progress|level|stage|completed|next_mark|laps?|score)(?:_|$)/i;
const REMAINING = /(?:^|_)(?:goal_distance|distance_to_goal|remaining_distance|distance|remaining)(?:_|$)/i;
const TIME = /^(?:t|time|elapsed|elapsed_s|steps|turns)$/i;
/** The completion goal a state can show: a boolean like finished/success/solved present in the state. */
export function goalOf(state) { const f = GOAL_FIELDS.find((k) => typeof state?.[k] === 'boolean'); return f ? { field: f, text: `${f} = true` } : null; }
/** Grade an end state against the goal: met beats unmet; met → faster is better; unmet → more progress, less left. */
export function grade(state, goal) {
  const met = Boolean(goal && state?.[goal.field] === true);
  const num = (re) => Object.entries(state || {}).filter(([k, v]) => re.test(k) && typeof v === 'number').reduce((a, [, v]) => a + v, 0);
  const time = Object.entries(state || {}).find(([k, v]) => TIME.test(k) && typeof v === 'number')?.[1] ?? 0;
  return { met, score: met ? 1e6 - time : num(PROGRESS) * 1000 - num(REMAINING) - (isOver(state) ? 0 : 500) };
}
/** Owner opt-in permits practice; restrictions in either owner text or kit always win. */
export function executionPolicy(task = '', docs = '') {
  const all = `${task}\n${docs}`;
  const single = /\b(?:single|one|1)\s+(?:(?:scored|official)\s+)?(?:attempt|run)\b/i.test(all);
  const forbidden = /\b(?:no|never|without|do not|don't)\b[^.\n]{0,80}\b(?:practi[cs]e|retries|retry|restart|reset|rerun)\b/i.test(all);
  const ownDecisions = /\b(?:make|choose|decide)\s+(?:every|each)\b[^.\n]{0,70}\b(?:yourself|model)\b|\b(?:no|without|do not|don't)\b[^.\n]{0,90}\b(?:autopilot|delegate|delegated|pre-script)\b/i.test(all);
  const requested = /\b(?:practi[cs]e|retry|retries|iterate|tune|improve)\b/i.test(task);
  return { practice: requested && !single && !forbidden && !ownDecisions, methods: !ownDecisions,
    reason: single || forbidden ? 'single-attempt or no-retry instructions' : ownDecisions ? 'each decision must come from the model' : requested ? 'owner requested iteration' : 'practice was not requested' };
}
const better = (a, b) => a.met !== b.met ? a.met : a.score > b.score;
/** One run of the tool, start to over, with a method (or the model). */
async function runOnce({ tool, cwd, method, complete, task, show = async () => {}, note = () => {}, maxSteps, quiet = false, initial = null, deadline = Infinity }) {
  if (Date.now() >= deadline) return { ok: false, steps: 0, state: initial, why: 'practice time budget exhausted' };
  let state = initial;
  if (!state) {
    const start = await exec(tool.init, cwd, Math.max(1, Math.min(300_000, deadline - Date.now()))); note(`RUN ${tool.init.join(' ')}\n${start.out}${start.err}(exit ${start.code})`);
    state = lastJson(start.out); if (start.code !== 0 || !state) return { ok: false, steps: 0, why: `the start command failed: ${(start.err || start.out).slice(0, 300)}` };
  }
  let steps = 0, same = 0, last = '';
  while (!isOver(state) && steps < maxSteps) {
    if (Date.now() >= deadline) return { ok: false, steps, state, why: 'practice time budget exhausted' };
    let values, why;
    if (method) ({ values, why } = decide(method, state, tool.ranges));
    else if (complete) {
      const reply = await complete(`Task: ${task}\nState: ${JSON.stringify(state).slice(0, 3000)}\nChoose this step's values. Ranges: ${JSON.stringify(Object.fromEntries(tool.actions.map((a) => [a, tool.ranges[a]])))}\nReply with one JSON object only, e.g. ${JSON.stringify(Object.fromEntries(tool.actions.map((a) => [a, tool.ranges[a][0]])))}`);
      const v = lastJson(reply);
      if (!v || tool.actions.some((a) => typeof v[a] !== 'number' || !Number.isFinite(v[a]))) return { ok: false, steps, state, why: 'the model did not return finite numeric controls' };
      values = Object.fromEntries(tool.actions.map((a) => [a, clamp(v[a], tool.ranges[a])])); why = 'model pick';
    } else return { ok: false, steps, state, why: 'no method fits and no model is available' };
    if (tool.actions.some((a) => !Number.isFinite(values[a]))) return { ok: false, steps, state, why: 'the method did not produce every required control' };
    const argv = [...tool.script, tool.stepSub];
    for (const [f, v] of Object.entries(tool.shared)) argv.push(`--${f}`, String(v));
    for (const a of tool.actions) argv.push(`--${a}`, String(values[a]));
    for (const f of tool.notes) argv.push(`--${f}`, `${method ? method.name : 'model'}: ${why}`.slice(0, 160));
    const r = await exec(argv, cwd, Math.max(1, Math.min(300_000, deadline - Date.now()))); steps += 1;
    note(`STEP ${steps} ${argv.slice(2).join(' ')}\n${r.out.slice(0, 3000)}${r.err.slice(0, 500)}(exit ${r.code})`);
    const next = lastJson(r.out);
    if (r.code !== 0 || !next) return { ok: false, steps, state, why: (r.err || r.out).slice(0, 300) };
    const sig = JSON.stringify(next); same = sig === last ? same + 1 : 0; last = sig; state = next;
    if (same >= 3) return { ok: false, steps, state, why: 'the state stopped changing' };
    if (!quiet && steps % 6 === 0) await show(`Step ${steps}: ${tool.actions.map((a) => `${a} ${values[a]}`).join(', ')} → ${Object.entries(state).filter(([, v]) => typeof v !== 'object').slice(0, 8).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(', ')}`);
  }
  return { ok: isOver(state), steps, state, ...(!isOver(state) ? { why: 'step budget exhausted before the tool finished' } : {}) };
}
/** Every tunable number in a method file (not clip bounds, not names): [{ path, value }]. */
export function tunables(method) {
  const out = []; const walk = (o, p) => { for (const [k, v] of Object.entries(o || {})) { if (k === 'clip') continue; if (typeof v === 'number' && v !== 0) out.push({ path: [...p, k], value: v }); else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, [...p, k]); } };
  (method.rules || []).forEach((r, i) => walk(r, ['rules', i])); return out;
}
const setPath = (o, path, v) => { const c = JSON.parse(JSON.stringify(o)); let x = c; for (const k of path.slice(0, -1)) x = x[k]; x[path.at(-1)] = v; return c; };
/**
 * Conduct the tool. With a method file and a goal the state can show, it iterates first (Kingmaker's own practice):
 * attempts on a scratch COPY of the folder, each graded from the tool's own end state, the method's numbers adjusted
 * (coordinate search) until the goal is met or the budget ends; the best variant is saved as a new method file; then
 * ONE final run in the real folder, which is the result. deps: { show, note, methodDirs, complete?, maxSteps, budget }.
 */
export async function conduct({ docs, cwd, task, show = async () => {}, note = () => {}, methodDirs = [], complete = null, maxSteps = 500, budget = { attempts: 32, ms: 120_000 } }) {
  const tool = await discover(docs, cwd); if (!tool || !tool.actions.length) return null;
  await show(`Found the tool's controls in its docs: ${tool.script.join(' ')} ${tool.stepSub} with ${tool.actions.map((a) => `--${a} ${tool.ranges[a].join('..')}`).join(', ')}.`);
  const policy = executionPolicy(task, docs);
  const attemptLimit = Math.max(0, Math.min(160, Number.isFinite(budget.attempts) ? Math.floor(budget.attempts) : 0));
  const timeLimit = Math.max(0, Math.min(480_000, Number.isFinite(budget.ms) ? budget.ms : 0));
  const canPractice = policy.practice && attemptLimit > 0 && timeLimit > 0;
  const deadline = canPractice ? Date.now() + timeLimit : Infinity;
  note(`POLICY ${JSON.stringify({ ...policy, attemptLimit, timeLimit })}`);
  // Single-attempt tasks do not initialize even a scratch copy.
  const scratchRoot = canPractice ? mkdtempSync(join(tmpdir(), 'kingmaker-practice-')) : null;
  const scratch = (i) => { const d = join(scratchRoot, String(i)); cpSync(cwd, d, { recursive: true }); return d; };
  let first, method, goal;
  const practice = { attempts: 0, initializations: 0, met: false, from: null, saved: null, best: null, history: [] };
  try {
    const firstDir = canPractice ? scratch('probe') : cwd;
    if (Date.now() >= deadline) return { ok: false, steps: 0, tool, policy, practice, why: 'practice time budget exhausted before initialization' };
    if (canPractice) practice.initializations += 1;
    const probe = await exec(tool.init, firstDir, Math.max(1, Math.min(300_000, deadline - Date.now())));
    first = lastJson(probe.out);
    note(`INIT ${canPractice ? 'practice probe' : 'real run'} ${tool.init.join(' ')}\n${probe.out}${probe.err}(exit ${probe.code})`);
    if (probe.code !== 0 || !first) return { ok: false, steps: 0, tool, policy, practice, why: 'the start command failed' };
    method = policy.methods ? pickMethod(methodDirs, first, tool.actions) : null;
    goal = goalOf(first); practice.from = method?.name ?? null;
  if (canPractice && method && goal) {
    await show(`Goal: ${goal.text}. Practising on a scratch copy first (never the real folder), starting from the method ${method.name}.`);
    let best = { method, g: { met: false, score: -Infinity } };
    const attempt = async (m) => {
      if (Date.now() >= deadline) return { met: false, score: -Infinity };
      const reuseProbe = practice.attempts === 0;
      practice.attempts += 1;
      const dir = reuseProbe ? firstDir : scratch(practice.attempts);
      if (!reuseProbe && Date.now() < deadline) practice.initializations += 1;
      const r = await runOnce({ tool, cwd: dir, method: m, maxSteps, quiet: true, deadline, initial: reuseProbe ? first : null });
      const g = r.ok ? grade(r.state, goal) : { met: false, score: -Infinity };
      const entry = { attempt: practice.attempts, grade: g, steps: r.steps, why: r.why ?? null, state: r.state, rules: m.rules };
      practice.history.push(entry); note(`PRACTICE ${JSON.stringify(entry)}`);
      if (better(g, best.g)) best = { method: m, g, state: r.state }; return g;
    };
    await attempt(method);
    // Wide first: every number scaled at once by a random factor in ×0.5…×2 (seeded, so a rerun repeats), then narrow.
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 12 && !best.g.met && practice.attempts < attemptLimit && Date.now() < deadline; i++) {
      let m = method; for (const tv of tunables(method)) m = setPath(m, tv.path, Math.round(tv.value * 2 ** (rnd() * 2 - 1) * 1000) / 1000);
      await attempt(m);
    }
    const factors = [0.8, 1.25, 0.6, 1.6, 0.9, 1.1];
    let improved = true;
    while (!best.g.met && improved && practice.attempts < attemptLimit && Date.now() < deadline) {
      improved = false;
      for (const f of factors) for (const tv of tunables(best.method)) {
        if (best.g.met || practice.attempts >= attemptLimit || Date.now() >= deadline) break;
        const before = best.g.score; await attempt(setPath(best.method, tv.path, Math.round(tv.value * f * 1000) / 1000));
        if (best.g.score > before) improved = true;
      }
      await show(`Practice: ${practice.attempts} attempts so far, best ${best.g.met ? 'meets the goal' : 'not there yet'} (grade ${Math.round(best.g.score)}).`);
    }
    practice.met = best.g.met; practice.best = best.g;
    if (best.method !== method) {
      const dir = join(cwd, '.kingmaker-methods'); const name = `${method.name.replace(/\+tuned.*$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}+tuned`;
      const tuned = { ...best.method, name, tuned_from: method.name, tuned_at: new Date().toISOString(), tuned_for: tool.script.join(' '), best_grade: best.g.score, goal: goal.text };
      try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.method.json`), `${JSON.stringify(tuned, null, 2)}\n`); practice.saved = join(dir, `${name}.method.json`); } catch { /* keep it in memory */ }
      method = tuned;
    }
  }
  }
  finally { if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true }); }
  await show(method ? `Final run in the real folder with the method ${method.name}${practice.attempts ? ` (after ${practice.attempts} practice attempts on a scratch copy)` : ''}.` : 'No method file fits this state yet, so the local model picks each step from the state.');
  const run = await runOnce({ tool, cwd, method, complete, task, show, note, maxSteps, initial: canPractice ? null : first });
  goal ||= goalOf(run.state);
  if (!run.ok) return { ...run, method, practice, tool, goal };
  const outputs = [];
  for (const w of tool.after) {
    const r = await exec(w, cwd, 15 * 60_000); note(`RUN ${w.join(' ')}\n${r.out.slice(-3000)}${r.err.slice(-1500)}(exit ${r.code})`);
    outputs.push({ cmd: w.join(' '), code: r.code, out: `${r.out}${r.err}`.trim().slice(-1500) });
    await show(`${w.slice(1).join(' ')} → exit ${r.code}`);
  }
  const met = goal ? run.state?.[goal.field] === true : null;
  const failed = outputs.find((o) => o.code !== 0);
  const ok = met !== false && !failed;
  return { ok, steps: run.steps, state: run.state, method, outputs, tool, goal, practice, policy, met,
    ...(!ok ? { why: failed ? `post-run command failed: ${failed.cmd} (exit ${failed.code})` : `goal not met: ${goal.text}` } : {}) };
}
