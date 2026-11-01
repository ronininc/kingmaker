// lib/model-bench.mjs — `kingmaker models bench`: measure each candidate model on THIS Mac, so the per-Mac profiles
// (lib/mac-profiles.mjs) are chosen from measured numbers, not claims. For each model, through Ollama's HTTP API:
//   • load time (cold: the model is unloaded first), prompt and generation tok/s on a fixed 150-word paragraph;
//   • memory: peak RSS of the model's runner process (sampled every 250 ms), its phys_footprint peak, what Ollama
//     reports resident and on the GPU, the swap used before and after, and the lowest kern.memorystatus_level seen;
//   • tool calling, two ways (lib/tool-call.mjs): 'twoStep' (Kingmaker's way: pick, then args, each held to a JSON
//     schema) and 'native' (Ollama's `tools` field). 18 cases: single tool, multi-argument, two chained tools (the
//     first tool's result is fed back), and refusing when no tool fits;
//   • routing: 12 commands the rules can't place, the router's own schema-held answer (lib/fast-route.mjs);
//   • writing: 3 short tasks with checkable constraints (sentence count, bullet count, word limit).
// `--as 8` simulates an 8 GB Mac on a bigger one, honestly and only as far as it can: a second Ollama server with the
// GPU budget an 8 GB Mac reports (5.3 GiB), one model at a time, one request at a time, a 4k context. It cannot take
// away the bigger Mac's RAM or bandwidth, so swap and speed must be measured on a real 8 GB Mac (the same command,
// without --as). Results: catalog/bench/<chip>-<ram>gb[-as-8gb].json. Uses only Node built-ins and stock macOS tools
// (sysctl, ps, footprint), so it runs on a stock Mac with Kingmaker's own runtime.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { LANE_SCHEMA, ROUTER_SYSTEM } from './fast-route.mjs';
import { LOCAL_SYSTEM } from './local-turn.mjs';
import { chat, nativeCall, NO_TOOL, twoStepCall } from './tool-call.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The suites (pure data) ──
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
export const BENCH_TOOLS = Object.freeze([
  tool('send_message', 'Send a text message to a person or phone number.', { to: { type: 'string', description: 'who gets it: a name or a phone number' }, text: { type: 'string', description: 'the message itself' } }, ['to', 'text']),
  tool('create_invoice', 'Create an invoice for a customer.', { customer: { type: 'string', description: 'the customer or business billed' }, amount: { type: 'number', description: 'the amount in dollars, a number' }, due_date: { type: 'string', description: 'when it is due, as said' } }, ['customer', 'amount', 'due_date']),
  tool('lookup_contact', 'Find a contact\'s phone number and email by name.', { name: { type: 'string', description: 'the person\'s name' } }, ['name']),
  tool('set_reminder', 'Set a reminder for the owner.', { text: { type: 'string', description: 'what to be reminded of' }, when: { type: 'string', description: 'when, as said' } }, ['text', 'when']),
  tool('open_app', 'Open an app on this Mac.', { app: { type: 'string', description: 'the app name' } }, ['app']),
]);

const want = (name, args = {}) => ({ name, args });
/** kind: single | multi | chain | refuse. A chain has two steps; `result` is what the first tool "returned". */
export const TOOL_CASES = Object.freeze([
  { id: 's1', kind: 'single', prompt: 'Text Maria that I\'m running 10 minutes late', steps: [want('send_message', { to: /maria/i, text: /(10|ten).*late|late.*(10|ten)/i })] },
  { id: 's2', kind: 'single', prompt: 'Open Spotify', steps: [want('open_app', { app: /spotify/i })] },
  { id: 's3', kind: 'single', prompt: 'Remind me to call the bank tomorrow at 9am', steps: [want('set_reminder', { text: /bank/i, when: /tomorrow|9/i })] },
  { id: 's4', kind: 'single', prompt: 'Let Maria know I\'ll be 10 min late', steps: [want('send_message', { to: /maria/i, text: /10|ten/i })] },
  { id: 'm1', kind: 'multi', prompt: 'Make an invoice for Hector Tacos for $450 due November 1', steps: [want('create_invoice', { customer: /hector/i, amount: 450, due_date: /nov|11/i })] },
  { id: 'm2', kind: 'multi', prompt: 'Bill Ana Ruiz 1,200 dollars, due on 2026-12-15', steps: [want('create_invoice', { customer: /ana/i, amount: 1200, due_date: /2026-12-15|dec(ember)?\s*15/i })] },
  { id: 'm3', kind: 'multi', prompt: 'Send a text to +1 602 555 0147 saying the proposal is ready', steps: [want('send_message', { to: /602\D*555\D*0147/, text: /proposal/i })] },
  { id: 'm4', kind: 'multi', prompt: 'Invoice Hector Tacos four hundred fifty dollars, due the first of November', steps: [want('create_invoice', { customer: /hector/i, amount: 450, due_date: /nov|11/i })] },
  { id: 'm5', kind: 'multi', prompt: 'Text Ana: the $300 invoice is due Friday', steps: [want('send_message', { to: /ana/i, text: /300.*fri|fri.*300/i })] },
  { id: 'c1', kind: 'chain', prompt: 'Look up Hector\'s number, then text him that the proposal is ready', steps: [want('lookup_contact', { name: /hector/i }), want('send_message', { to: /602\D*555\D*0147/, text: /proposal/i })], result: { name: 'Hector Ruiz', phone: '+16025550147', email: 'hector@hectortacos.com' } },
  { id: 'c2', kind: 'chain', prompt: 'Find Ana\'s contact, then invoice her 300 dollars due Friday', steps: [want('lookup_contact', { name: /ana/i }), want('create_invoice', { customer: /ana/i, amount: 300, due_date: /fri/i })], result: { name: 'Ana Ruiz', phone: '+14805550199', email: 'ana@ruizbakery.com' } },
  { id: 'c3', kind: 'chain', prompt: 'Look up Maria Lopez, then remind me to call her at 5pm', steps: [want('lookup_contact', { name: /maria/i }), want('set_reminder', { text: /maria|call/i, when: /5/ })], result: { name: 'Maria Lopez', phone: '+16235550111', email: 'maria@lopezcleaning.com' } },
  { id: 'c4', kind: 'chain', prompt: 'Get Ana Ruiz\'s email address and text it to Maria', steps: [want('lookup_contact', { name: /ana/i }), want('send_message', { to: /maria/i, text: /ana@ruizbakery\.com/i })], result: { name: 'Ana Ruiz', phone: '+14805550199', email: 'ana@ruizbakery.com' } },
  { id: 'r1', kind: 'refuse', prompt: 'What is the capital of France?', steps: [want(NO_TOOL)] },
  { id: 'r2', kind: 'refuse', prompt: 'Book me a flight to Miami next week', steps: [want(NO_TOOL)] },
  { id: 'r3', kind: 'refuse', prompt: 'Write me a haiku about tacos', steps: [want(NO_TOOL)] },
  { id: 'r4', kind: 'refuse', prompt: 'Fax my tax return to the IRS', steps: [want(NO_TOOL)] },
  { id: 'r5', kind: 'refuse', prompt: 'Delete all my contacts', steps: [want(NO_TOOL)] },
]);

/** Commands the rules leave to the router (lib/fast-route.mjs ruleLane returns null or would be unsure). */
export const ROUTE_CASES = Object.freeze([
  ['a haiku about Phoenix heat', 'write'], ['tell Hector the tacos are ready', 'act'], ['can you get the weather radar up in safari', 'open'],
  ['I need a logo for my food truck, red and gold', 'image'], ['the population of Arizona', 'lookup'], ['let my landlord know rent will be late', 'act'],
  ['youtube please', 'open'], ['give me three taglines for a barber shop', 'write'], ['a picture of a cat wearing a crown', 'image'],
  ['the date of the next full moon', 'lookup'], ['thank-you note for my first customer', 'write'], ['pay the electric bill', 'act'],
].map(([text, lane]) => Object.freeze({ text, lane })));

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const sentences = (s) => String(s).replace(/\b(Mr|Mrs|Ms|Dr|St)\./g, '$1').split(/[.!?]+(\s|$)/).map((x) => x?.trim()).filter((x) => x && /\w/.test(x)).length;
const bullets = (s) => String(s).split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
export const WRITE_CASES = Object.freeze([
  { id: 'w1', prompt: 'Write a text to a customer saying their order is delayed by one day. Exactly two sentences, nothing else.', check: (t) => sentences(t) === 2 && words(t) <= 60 && /delay|late|tomorrow|one day|extra day/i.test(t) },
  { id: 'w2', prompt: 'Give three tips for a small taco shop to get more online reviews. Exactly three bullet points, each starting with "- ", nothing else.', check: (t) => bullets(t) === 3 && /review/i.test(t) },
  { id: 'w3', prompt: 'In under 30 words, explain what an invoice is.', check: (t) => words(t) < 30 && /invoice|bill|pay/i.test(t) },
]);
export const SPEED_PROMPT = 'Write a 150-word paragraph about why a small business should keep clean books.';

// ── Scoring (pure) ──
const argOk = (v, m) => (m instanceof RegExp ? m.test(String(v ?? '')) : typeof m === 'number' ? Number(String(v).replace(/[$,]/g, '')) === m : v === m);
/** Pure: does one call match one expected step? */
export function stepMatches(call, step) {
  if (!call || call.name !== step.name) return false;
  return Object.entries(step.args).every(([k, m]) => argOk(call.arguments?.[k], m));
}

/** Pure: the per-kind and overall score of a list of case results [{ kind, pass }]. */
export function summarize(results) {
  const by = {};
  for (const r of results) { by[r.kind] ??= { pass: 0, of: 0 }; by[r.kind].of += 1; if (r.pass) by[r.kind].pass += 1; }
  const pass = results.filter((r) => r.pass).length;
  return { pass, of: results.length, pct: results.length ? Math.round((pass / results.length) * 100) : 0, by };
}

// ── This Mac ──
const sysctl = (key, exec = execFileSync) => { try { return String(exec('/usr/sbin/sysctl', ['-n', key], { encoding: 'utf8' })).trim(); } catch { return ''; } };
export const swapUsedMb = (exec) => { const m = /used = ([\d.]+)M/.exec(sysctl('vm.swapusage', exec)); return m ? Number(m[1]) : null; };
const memLevel = (exec) => { const n = Number(sysctl('kern.memorystatus_level', exec)); return Number.isFinite(n) && n > 0 ? n : null; };

/** A system brief the size of an owner's instructions (about 1,500 characters), for the prefix measurement. */
const PREFIX_BRIEF = `How the owner wants you to behave and think (their standing instructions):\n${'Write for a small business owner: short sentences, plain words, numbers as digits, prices with the currency, no jargon, and never promise what the business has not said it offers. '.repeat(8)}`;
/** Pure: how much of a repeated system brief the model read again on the second turn (Ollama reports only what it had to
 *  evaluate; a reused prefix is not counted). reusedPct near 100: the cached prefix holds across turns. */
export function prefixReuse(first, second) {
  const a = first?.prompt_eval_count ?? null, b = second?.prompt_eval_count ?? null;
  return { firstTokens: a, secondTokens: b, firstMs: first?.prompt_eval_duration == null ? null : Math.round(first.prompt_eval_duration / 1e6),
    secondMs: second?.prompt_eval_duration == null ? null : Math.round(second.prompt_eval_duration / 1e6),
    reusedPct: a && b != null && a > 0 ? Math.max(0, Math.round((1 - b / a) * 100)) : null };
}

/** Pure: a file-name slug for this Mac: "Apple M3" + 8 GiB → "m3-8gb"; "Apple M5 Pro" + 24 → "m5-pro-24gb". */
export function benchSlug(brand, ramGb, asGb = null) {
  const chip = String(brand || 'unknown').replace(/^Apple\s+/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  return `${chip}-${Math.round(ramGb)}gb${asGb ? `-as-${asGb}gb` : ''}`;
}

/**
 * What made a bench file (after olmo-core's ConfigSaverCallback: a result keeps the exact code and settings behind it):
 * Kingmaker's version and the checkout's commit. The commit is read from .git's files, never by running git: on a Mac
 * without the developer tools /usr/bin/git opens an install dialog. null where there is no checkout (the app, the VM's
 * share without .git).
 */
export function benchProvenance(root = new URL('..', import.meta.url), read = (f) => readFileSync(f, 'utf8')) {
  const at = (rel) => { try { return read(new URL(rel, root)).trim(); } catch { return null; } };
  let version = null; try { version = JSON.parse(at('package.json') ?? '{}').version ?? null; } catch { /* unreadable */ }
  const head = at('.git/HEAD');
  const ref = /^ref: (.+)$/.exec(head ?? '')?.[1] ?? null;
  const packed = (name) => (at('.git/packed-refs') ?? '').split('\n').map((l) => l.split(' ')).find(([, n]) => n === name)?.[0] ?? null;
  const commit = ref ? at(`.git/${ref}`) ?? packed(ref) : head;
  return { version, commit: /^[0-9a-f]{40}$/.test(commit ?? '') ? commit : null, branch: ref?.replace(/^refs\/heads\//, '') ?? null };
}

/** Pure: the runner rows of `ps -axo pid=,ppid=,rss=,args=` holding one model's blob, under one server (its pid) when
 *  given, so a second server holding the same model is never counted. */
export function runnerRows(psText, { blob = null, serverPid = null } = {}) {
  return String(psText).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => /llama-server|ollama runner/.test(m[4]) && (!blob || m[4].includes(blob)) && (!serverPid || Number(m[2]) === serverPid))
    .map((m) => ({ pid: Number(m[1]), rssKb: Number(m[3]) }));
}
function runners(blob, serverPid) {
  try { return runnerRows(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8', maxBuffer: 8 << 20 }), { blob, serverPid }); } catch { return []; }
}
/** The pid of the `ollama serve` answering on a port (lsof is on every Mac), or null. */
export function serverPidFor(base) {
  try {
    const port = new URL(base).port || '11434';
    const out = String(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim().split('\n')[0];
    return out ? Number(out) : null;
  } catch { return null; }
}
function footprintPeakMb(pid) {
  try {
    const out = String(execFileSync('/usr/bin/footprint', ['--noCategories', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const m = /phys_footprint_peak:\s*([\d.]+)\s*(KB|MB|GB)/.exec(out);
    return m ? Math.round(Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1)) : null;
  } catch { return null; }
}

/** Sample the model's runner RSS and the Mac's memory level until stopped. */
function startSampler(getBlob, serverPid = null) {
  // The largest single runner: a runner being replaced can overlap its successor for a moment, and adding the two
  // would count the weights twice (seen: 7.6 GB "peak" for a model that holds 3.0–3.5 GB).
  const s = { peakRssMb: 0, lastRssMb: 0, minMemLevel: null, pid: null, runnersSeen: 0, stop: null };
  const tick = () => {
    const rs = runners(getBlob(), serverPid);
    s.runnersSeen = Math.max(s.runnersSeen, rs.length);
    const top = rs.reduce((a, r) => (r.rssKb > (a?.rssKb ?? -1) ? r : a), null);
    const rss = (top?.rssKb ?? 0) / 1024;
    if (top) { s.pid = top.pid; s.lastRssMb = Math.round(rss); }
    if (rss > s.peakRssMb) s.peakRssMb = Math.round(rss);
    const lvl = memLevel(); if (lvl != null) s.minMemLevel = s.minMemLevel == null ? lvl : Math.min(s.minMemLevel, lvl);
  };
  const timer = setInterval(tick, 250); tick();
  s.stop = () => { clearInterval(timer); tick(); };
  return s;
}

// ── Heat: the bench is the Mac's main load, so it cools down between models and waits out any thermal warning ──
/** Pure: `pmset -g therm` → { warning, speedLimit } (a stock-macOS tool). No warning and no limit = cool enough. */
export function parseTherm(text) {
  const t = String(text ?? '');
  const level = /thermal warning level.*?(\d+)|Thermal_Level\s*=\s*(\d+)/i.exec(t);
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(t);
  const warning = /No thermal warning level has been recorded/i.test(t) ? null : level ? Number(level[1] ?? level[2]) : null;
  return { warning: warning ? warning : null, speedLimit: limit ? Number(limit[1]) : null };
}
const therm = () => { try { return parseTherm(execFileSync('/usr/bin/pmset', ['-g', 'therm'], { encoding: 'utf8' })); } catch { return { warning: null, speedLimit: null }; } };
export const isHot = (t) => Boolean(t.warning) || (t.speedLimit != null && t.speedLimit < 100);
/** The least free memory (kern.memorystatus_level, %) a model may start at: the owner uses this Mac while it benches. */
export const MIN_FREE_PCT = 20;
/** Pure: may the next model start? Not while macOS reports heat or a CPU limit, nor below MIN_FREE_PCT free memory. */
export const mayStart = (t, freePct) => !isHot(t) && (freePct == null || freePct >= MIN_FREE_PCT);
/** Wait `cooldownS`, then longer while macOS reports a thermal warning or a CPU speed limit, or free memory is under
 *  MIN_FREE_PCT (at most `maxWaitS`; past that the run stops rather than squeeze the owner's Mac). */
async function coolDown({ cooldownS = 30, maxWaitS = 900, print = () => {} } = {}) {
  if (cooldownS > 0) await sleep(cooldownS * 1000);
  const t0 = Date.now();
  let t = therm(), free = memLevel();
  if (!mayStart(t, free)) print(`… waiting: ${isHot(t) ? `the Mac is hot (pmset: warning ${t.warning ?? 'none'}, CPU limit ${t.speedLimit ?? 100}%)` : `${free}% memory free (< ${MIN_FREE_PCT}%)`}`);
  while (!mayStart(t, free) && Date.now() - t0 < maxWaitS * 1000) { await sleep(30_000); t = therm(); free = memLevel(); }
  if (!mayStart(t, free)) throw new Error(`stopped: still ${isHot(t) ? 'hot' : `at ${free}% free memory`} after ${Math.round(maxWaitS / 60)} minutes`);
  return { ...t, freePct: free };
}

// ── Ollama ──
async function api(base, path, body, { timeoutMs = 600_000, method = 'POST' } = {}) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${String(j?.error ?? text).slice(0, 200)}`);
  return j;
}
async function ollamaVersion(base) { try { return (await api(base, '/api/version', null, { method: 'GET', timeoutMs: 5000 }))?.version ?? null; } catch { return null; } }
/** Pure: is a model installed, with or without the implicit ":latest"? */
export const hasModel = (names, model) => (names ?? []).some((n) => n === model || n === `${model}:latest` || `${n}:latest` === model);
async function blobOf(base, model) {
  try { const s = await api(base, '/api/show', { model }, { timeoutMs: 20_000 }); return /sha256-[0-9a-f]{64}/.exec(String(s?.modelfile ?? ''))?.[0] ?? null; } catch { return null; }
}
async function unloadAll(base) {
  try { const ps = await api(base, '/api/ps', null, { method: 'GET', timeoutMs: 5000 }); for (const m of ps?.models ?? []) await api(base, '/api/generate', { model: m.name, keep_alive: 0 }, { timeoutMs: 30_000 }).catch(() => {}); } catch { /* none */ }
}
async function resident(base, model) {
  try { const ps = await api(base, '/api/ps', null, { method: 'GET', timeoutMs: 5000 }); const m = (ps?.models ?? []).find((x) => hasModel([x.name, x.model], model)); return m ? { sizeGb: +(m.size / 1e9).toFixed(2), gpuGb: +(m.size_vram / 1e9).toFixed(2), contextLength: m.context_length ?? null } : null; } catch { return null; }
}

/** Where the ollama binary is on this Mac (the app's, Homebrew's, or ~/Applications'), or null. */
export function findOllamaBin({ env = process.env, exists = existsSync, home = homedir() } = {}) {
  const c = [env.OLLAMA_BIN, '/Applications/Ollama.app/Contents/Resources/ollama', join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'), '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'].filter(Boolean);
  return c.find((p) => exists(p)) ?? null;
}

/** The GPU budget an 8 GB Mac's Ollama reports (Metal's recommended working set). Seen in a real 8 GB Mac's Ollama
 *  log: total 8.0 GiB, gpu free 5.3 GiB. */
export const GPU_BUDGET_8GB_GIB = 5.3;

/**
 * Start a second Ollama server that behaves like an 8 GB Mac's as far as software can make it: the GPU budget cut to
 * 5.3 GiB (OLLAMA_GPU_OVERHEAD reserves the rest), one model loaded, one request at a time, 4k context. Shares this
 * Mac's model store, so nothing is downloaded twice. Returns { base, stop, gpuTotalGib }.
 */
export async function startSimServer({ bin = findOllamaBin(), port = 11439, budgetGib = GPU_BUDGET_8GB_GIB, context = 4096, log = () => {} } = {}) {
  if (!bin) throw new Error('no ollama binary found (set OLLAMA_BIN)');
  const base = `http://127.0.0.1:${port}`;
  const launch = (overheadBytes) => new Promise((resolve, reject) => {
    const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_CONTEXT_LENGTH: String(context), OLLAMA_GPU_OVERHEAD: String(Math.max(0, Math.round(overheadBytes))), OLLAMA_KEEP_ALIVE: '5m' };
    const child = spawn(bin, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Keep only the scheduler's memory lines (the runner logs every token slot), as they arrive.
    let total = null, err = '', pending = '';
    child.stderr.on('data', (d) => {
      pending += String(d); const lines = pending.split('\n'); pending = lines.pop();
      for (const l of lines) if (/inference compute|system memory|gpu memory|offload|msg="(load|loading|model)|layers|memory|level=(WARN|ERROR)/i.test(l) && !/^slot /.test(l)) err = (err + l + '\n').slice(-200_000);
      const m = /inference compute.*?total="([\d.]+) GiB"/.exec(err); if (m) total = Number(m[1]);
    });
    child.once('error', reject);
    (async () => {
      for (let i = 0; i < 60; i += 1) { await sleep(500); if ((await ollamaVersion(base)) && total != null) break; }
      resolve({ child, total, stderr: () => err, gpuLine: () => [...err.matchAll(/msg="gpu memory".*?available="([\d.]+ [GM]iB)" free="([\d.]+ [GM]iB)"/g)].map((m) => ({ available: m[1], free: m[2] })).pop() ?? null, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); setTimeout(r, 4000); }) });
    })();
  });
  const probe = await launch(0);
  const total = probe.total ?? (totalmem() / 2 ** 30) * 0.75;
  await probe.stop();
  const overhead = Math.max(0, (total - budgetGib) * 2 ** 30);
  const real = await launch(overhead);
  log('sim_server', { base, gpuTotalGib: total, gpuBudgetGib: budgetGib, overheadGib: +(overhead / 2 ** 30).toFixed(2) });
  return { base, stop: real.stop, stderr: real.stderr, gpuTotalGib: total, gpuBudgetGib: budgetGib, overheadGib: +(overhead / 2 ** 30).toFixed(2), gpuLine: real.gpuLine };
}

// ── One model ──
async function runToolCase(mode, model, c, { base, options }) {
  const call = mode === 'native' ? nativeCall : twoStepCall;
  const messages = [{ role: 'user', content: c.prompt }];
  const got = [];
  for (let i = 0; i < c.steps.length; i += 1) {
    let r;
    try { r = await call({ model, base, messages, tools: BENCH_TOOLS, options, timeoutMs: 120_000 }); }
    catch (e) { return { id: c.id, kind: c.kind, pass: false, got, error: String(e.message).slice(0, 160) }; }
    got.push({ name: r.name, arguments: r.arguments, ms: r.ms });
    if (!stepMatches(r, c.steps[i])) return { id: c.id, kind: c.kind, pass: false, got };
    if (i + 1 < c.steps.length) {
      // Feed the first tool's result back, the way each mode carries it.
      if (mode === 'native') messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: r.name, arguments: r.arguments } }] }, { role: 'tool', content: JSON.stringify(c.result) });
      else messages.push({ role: 'assistant', content: `I called ${r.name} with ${JSON.stringify(r.arguments)}.` }, { role: 'user', content: `${r.name} returned ${JSON.stringify(c.result)}. Now do the rest of what I asked.` });
    }
  }
  return { id: c.id, kind: c.kind, pass: true, got };
}

/** Benchmark one model. Never throws: a model that fails to load or answer is recorded with its error. */
export async function benchModel(model, { base, context = 4096, log = () => {}, suites = ['speed', 'tools', 'route', 'write'] } = {}) {
  const out = { model, context, at: new Date().toISOString() };
  const options = { num_ctx: context };
  await unloadAll(base); await sleep(1500);
  const blob = await blobOf(base, model);
  try { out.capabilities = (await api(base, '/api/show', { model }, { timeoutMs: 20_000 }))?.capabilities ?? null; } catch { /* unknown */ }
  if (!blob) { out.error = 'not installed on this Ollama (pull it first)'; return out; }
  const swap0 = swapUsedMb();
  const sampler = startSampler(() => blob, serverPidFor(base));
  try {
    const t0 = Date.now();
    const warm = await api(base, '/api/generate', { model, prompt: 'Hi', stream: false, think: false, keep_alive: '10m', options: { ...options, num_predict: 1 } }).catch(async (e) => {
      if (/think/i.test(e.message)) return api(base, '/api/generate', { model, prompt: 'Hi', stream: false, keep_alive: '10m', options: { ...options, num_predict: 1 } });
      throw e;
    });
    out.loadS = +((warm?.load_duration ?? 0) / 1e9).toFixed(2); out.firstReplyS = +((Date.now() - t0) / 1000).toFixed(2);
    out.resident = await resident(base, model);
    if (suites.includes('speed')) {
      const r = await chat({ model, base, options: { ...options, num_predict: 220 }, messages: [{ role: 'user', content: SPEED_PROMPT }] });
      out.speed = { promptTokS: +((r.prompt_eval_count ?? 0) / Math.max(1e-9, (r.prompt_eval_duration ?? 1) / 1e9)).toFixed(1), genTokS: +((r.eval_count ?? 0) / Math.max(1e-9, (r.eval_duration ?? 1) / 1e9)).toFixed(1), genTokens: r.eval_count ?? 0 };
      out.speed.promptTokens = r.prompt_eval_count ?? null; out.speed.promptMs = r.prompt_eval_duration == null ? null : Math.round(r.prompt_eval_duration / 1e6);
      // Two turns with the same system brief and different words (lib/local-turn.mjs): what the second had to read again.
      const brief = `${LOCAL_SYSTEM}\n\n${PREFIX_BRIEF}`, turn = (q) => chat({ model, base, options: { ...options, num_predict: 1 }, messages: [{ role: 'system', content: brief }, { role: 'user', content: q }] });
      out.speed.prefix = prefixReuse(await turn('What is a good name for a bakery?'), await turn('Write one line for a flyer about a sale.'));
      log('bench_speed', { model, ...out.speed });
    }
    if (suites.includes('tools')) {
      out.tools = {};
      for (const mode of ['twoStep', 'native']) {
        const t = Date.now();
        const cases = [];
        for (const c of TOOL_CASES) cases.push(await runToolCase(mode, model, c, { base, options }));
        out.tools[mode] = { ...summarize(cases), avgMs: Math.round((Date.now() - t) / TOOL_CASES.length), cases };
        log('bench_tools', { model, mode, pass: out.tools[mode].pass, of: out.tools[mode].of });
      }
    }
    if (suites.includes('route')) {
      const cases = [];
      const t = Date.now();
      for (const c of ROUTE_CASES) {
        let lane = null;
        try { const r = await chat({ model, base, format: LANE_SCHEMA, options: { ...options, num_predict: 20 }, messages: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: c.text }] }); lane = /"lane"\s*:\s*"(\w+)"/.exec(r?.message?.content ?? '')?.[1] ?? null; }
        catch { /* counted as a miss */ }
        cases.push({ text: c.text, want: c.lane, got: lane, pass: lane === c.lane, kind: 'route' });
      }
      out.route = { ...summarize(cases), avgMs: Math.round((Date.now() - t) / ROUTE_CASES.length), cases };
      log('bench_route', { model, pass: out.route.pass });
    }
    if (suites.includes('write')) {
      const cases = [];
      for (const c of WRITE_CASES) {
        let text = '';
        try { const r = await chat({ model, base, options: { ...options, num_predict: 300, temperature: 0.3 }, messages: [{ role: 'user', content: c.prompt }] }); text = String(r?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); }
        catch { /* a miss */ }
        cases.push({ id: c.id, kind: 'write', pass: c.check(text) && !/<think>/.test(text), text: text.slice(0, 400) });
      }
      out.write = { ...summarize(cases), cases };
      log('bench_write', { model, pass: out.write.pass });
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 240);
  } finally {
    sampler.stop();
    // steadyRssGb: the runner after every suite ran (weights, a used context, the compute buffers): what it holds.
    // peakRssGb also catches the moment of loading, when the file's pages and the GPU copy overlap.
    out.memory = { steadyRssGb: +(sampler.lastRssMb / 1024).toFixed(2), peakRssGb: +(sampler.peakRssMb / 1024).toFixed(2), footprintPeakGb: sampler.pid ? +((footprintPeakMb(sampler.pid) ?? 0) / 1024).toFixed(2) : null, minMemLevel: sampler.minMemLevel, runnersSeen: sampler.runnersSeen, swapDeltaMb: swap0 == null ? null : Math.round((swapUsedMb() ?? swap0) - swap0) };
    await api(base, '/api/generate', { model, keep_alive: 0 }, { timeoutMs: 30_000 }).catch(() => {});
  }
  return out;
}

/** Pure: a model's measured verdict against a resident budget (GB): does it fit, and what it scored. */
export function verdict(r, { maxResidentGb = Infinity } = {}) {
  if (!r || r.error) return { fits: false, why: r?.error ?? 'no result' };
  // What it holds: the runner's RSS, or Ollama's own resident size when larger. Under memory pressure macOS evicts the
  // runner's file pages and RSS reads low (seen: a 14B "holding" 6.0 GB that Ollama sized at 12.0 GB).
  const rss = Math.max(r.memory?.steadyRssGb || r.memory?.peakRssGb || 0, r.resident?.sizeGb ?? 0) || Infinity;
  const onGpu = !r.resident || r.resident.gpuGb >= r.resident.sizeGb - 0.05;
  const swapped = (r.memory?.swapDeltaMb ?? 0) > 256;
  const pressed = r.memory?.minMemLevel != null && r.memory.minMemLevel <= 10;
  const fits = rss <= maxResidentGb && onGpu && !swapped && !pressed;
  return { fits, why: fits ? 'fits' : rss > maxResidentGb ? `holds ${+rss.toFixed(2)} GB > ${maxResidentGb} GB` : !onGpu ? `only ${r.resident.gpuGb} of ${r.resident.sizeGb} GB on the GPU` : swapped ? `swap grew ${r.memory.swapDeltaMb} MB` : `memory pressure (${r.memory.minMemLevel}% free)`,
    tools: r.tools?.twoStep?.pct ?? null, nativeTools: r.tools?.native?.pct ?? null, route: r.route?.pct ?? null, write: r.write?.pct ?? null, genTokS: r.speed?.genTokS ?? null, loadS: r.loadS ?? null };
}

/**
 * The whole run: this Mac's facts, each model in turn, the file written after every model (a long run that is stopped
 * keeps what it measured). Returns { file, report }.
 */
export async function runBench({ models, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', asGb = null, context = 4096, outDir, maxResidentGb = null, cooldownS = 30, log = () => {}, print = () => {} }) {
  const brand = sysctl('machdep.cpu.brand_string') || 'unknown';
  const ramGb = Number(sysctl('hw.memsize')) / 2 ** 30 || totalmem() / 2 ** 30;
  let sim = null;
  // A simulated run: the main server's models are unloaded first, so they neither share memory nor get counted.
  if (asGb) { await unloadAll(base); sim = await startSimServer({ context, log }); base = sim.base; }
  const report = {
    schema: 1, slug: benchSlug(brand, ramGb, asGb),
    host: { chip: brand, model: sysctl('hw.model'), ramGb: Math.round(ramGb), macos: sysctl('kern.osproductversion') || release(), ollama: await ollamaVersion(base) },
    simulated: asGb ? { asGb, gpuBudgetGib: sim.gpuBudgetGib, gpuTotalGib: sim.gpuTotalGib, overheadGib: sim.overheadGib, schedulerSaw: null, maxLoadedModels: 1, numParallel: 1, context,
      honest: `Software limits only: the GPU budget, one model at a time and the context are an ${asGb} GB Mac's; this Mac's RAM, bandwidth and swap are not. Speeds are this Mac's, and swap can only be judged on a real ${asGb} GB Mac.` } : null,
    kingmaker: benchProvenance(), cooldownS,
    context, maxResidentGb, startedAt: new Date().toISOString(), results: [],
  };
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${report.slug}.json`);
  // Keep earlier results for models not re-run, so one model can be re-measured without losing the rest.
  try { const prev = JSON.parse(readFileSync(file, 'utf8')); report.results = (prev.results ?? []).filter((r) => !models.includes(r.model)); } catch { /* first run */ }
  try {
    for (const [i, model] of models.entries()) {
      const heat = await coolDown({ cooldownS: i ? cooldownS : 0, print });   // every model, the first too
      print(`… ${model}`);
      const r = await benchModel(model, { base, context, log });
      r.thermal = { before: heat, after: therm() };
      report.results.push(r);
      if (sim) report.simulated.schedulerSaw = sim.gpuLine();   // Ollama's own "gpu memory" line: what it let the model use
      report.finishedAt = new Date().toISOString();
      writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
      const v = verdict(r, { maxResidentGb: maxResidentGb ?? Infinity });
      print(r.error ? `✗ ${model}: ${r.error}` : `✓ ${model}: load ${r.loadS}s, ${r.speed?.genTokS} tok/s, holds ${r.memory.steadyRssGb} GB (peak ${r.memory.peakRssGb}), tools ${v.tools}% (native ${v.nativeTools}%), route ${v.route}%, write ${v.write}%${maxResidentGb ? `, ${v.fits ? 'fits' : v.why}` : ''}`);
    }
  } finally {
    if (sim) { try { writeFileSync(join(outDir, `${report.slug}.ollama.log`), sim.stderr()); } catch { /* best effort */ } }
    await sim?.stop();
  }
  return { file, report };
}
