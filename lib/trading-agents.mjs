// lib/trading-agents.mjs — TauricResearch/TradingAgents as a Kingmaker ability (the owner, 2026-10-16: "taking what we
// can from it since it's open source and giving it to Kingmaker as an ability"). A desk of LLM analysts (market,
// social, news, fundamentals) studies one ticker as of one date, bull and bear researchers debate it, a risk team
// argues it, and a portfolio manager rates it Buy / Overweight / Hold / Underweight / Sell, with the reports behind
// the rating.
//
// Research only, by construction:
//   • TradingAgents has no broker (its portfolio is "broker-neutral by construction"): it rates, it never orders. This
//     module adds none: there is no order, trade or transfer path here, and every answer says it is research, not
//     financial advice.
//   • Local first: the analysts think on this Mac's own Ollama models. Only the ticker leaves the Mac, to the public
//     market-data sources TradingAgents reads (Yahoo Finance, SEC EDGAR, Polymarket, Reddit, StockTwits); no API key is
//     used, and none is ever put in its environment.
//   • Pinned: cloned at one commit (a git commit hash checksums the whole tree) into Kingmaker's own data folder, read by
//     REA like any repo connector before it may run, and run with connectorEnv (none of Kingmaker's keys) in its own
//     process group, reaped whole on a timeout.
//   • Apache-2.0: its LICENSE stays with the clone. Nothing of TradingAgents is vendored in this repo; the driver
//     (lib/trading-agents-driver.py) is Kingmaker's own.
//   kept in <state>/abilities/trading-agents/ · `kingmaker markets` · core/skills/trading-agents/SKILL.md
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorEnv } from './connectors.mjs';
import { WRITER_MODEL } from './fast-route.mjs';
import { inspect } from './rea.mjs';

/** The pinned source. Verified on GitHub 2026-10-16 (TradingAgents 0.6.0). */
export const TRADING_AGENTS_SOURCE = Object.freeze({
  repo: 'TauricResearch/TradingAgents', url: 'https://github.com/TauricResearch/TradingAgents',
  commit: '1394a3f72aa4393e1a98f51b382434c4b4c2d972', version: '0.6.0', license: 'Apache-2.0',
  bundled: false, note: 'Apache-2.0: its LICENSE stays with the clone. Cloned at this commit, which checksums the tree.',
});
export const DRIVER = fileURLToPath(new URL('./trading-agents-driver.py', import.meta.url));
export const PYTHON_VERSION = '3.12';
export const ANALYSTS = Object.freeze(['market', 'social', 'news', 'fundamentals']);
export const RATINGS = Object.freeze(['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell']);
export const DISCLAIMER = 'Research from AI analysts, not financial advice. Kingmaker never places trades.';
export const RESULT_MARK = 'KINGMAKER_RESULT ';
const RUN_TIMEOUT_MS = 45 * 60_000; // a full desk on a local 8B model takes a while

export const tradingAgentsDir = (state) => join(state, 'abilities', 'trading-agents');
const layout = (dir) => ({ dir, src: join(dir, 'src'), venv: join(dir, '.venv'), python: join(dir, '.venv', 'bin', 'python'), runs: join(dir, 'runs'), receipt: join(dir, 'installed.json') });

/**
 * Pure: the exact, pinned steps to put TradingAgents on this Mac, as argv lists (never a shell line). Cloned at the
 * pinned commit, then a private Python (uv-managed, never the system's) with TradingAgents installed into it.
 */
export function installPlan({ dir, uv }) {
  const L = layout(dir), s = TRADING_AGENTS_SOURCE;
  return {
    ...L, pinned: s.commit, license: s.license,
    steps: [
      ['git', 'clone', '--no-checkout', '--filter=blob:none', s.url, L.src],
      ['git', '-C', L.src, 'fetch', '--depth', '1', 'origin', s.commit],
      ['git', '-C', L.src, 'checkout', '--detach', s.commit],
      [uv, 'venv', '--python', PYTHON_VERSION, '--python-preference', 'only-managed', L.venv],
      [uv, 'pip', 'install', '--python', L.python, L.src],
    ],
  };
}

const run = (argv, opts = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000, ...opts });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message || '') };
};

/**
 * Install (the owner typed `kingmaker markets install`: that is the ask). Stops at the first failed step, refuses a
 * clone whose HEAD isn't the pin, and refuses one REA rejects. Writes a receipt only when all of that passed.
 */
export function install({ state, uv, runImpl = run, inspectImpl = inspect, log = () => {}, now = () => new Date() }) {
  if (!uv) return { ok: false, error: 'No uv on this Mac: Kingmaker.app carries one (Resources/bin/uv); a checkout needs `brew install uv`.' };
  const plan = installPlan({ dir: tradingAgentsDir(state), uv });
  if (existsSync(plan.receipt) && status({ state }).ok) return { ok: true, already: true, ...status({ state }) };
  mkdirSync(plan.dir, { recursive: true });
  const step = (argv) => {
    log(`→ ${argv.map((a) => a.replace(plan.dir, '…')).join(' ')}`);
    const r = runImpl(argv);
    return r.code === 0 ? null : { ok: false, error: `${argv[0] === uv ? 'uv' : 'git'} failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`.slice(0, 600) };
  };
  // The checkout first, then its pin and REA, and only then the Python install: installing a package can run its build
  // hooks, so nothing from the clone runs before REA has read it.
  for (const argv of plan.steps.filter((a) => a[0] === 'git')) {
    if (argv[1] === 'clone' && existsSync(join(plan.src, '.git'))) continue; // a retry after a failed later step
    const failed = step(argv); if (failed) return failed;
  }
  const head = runImpl(['git', '-C', plan.src, 'rev-parse', 'HEAD']).stdout.trim();
  if (head !== plan.pinned) return { ok: false, error: `The clone is at ${head.slice(0, 12) || '?'}, not the pinned ${plan.pinned.slice(0, 12)}: not used.` };
  const rea = inspectImpl([plan.src]);
  if (rea.verdict === 'rejected') return { ok: false, error: `REA rejected TradingAgents: ${rea.summary}` };
  for (const argv of plan.steps.filter((a) => a[0] !== 'git')) { const failed = step(argv); if (failed) return failed; }
  const receipt = { commit: head, version: TRADING_AGENTS_SOURCE.version, license: TRADING_AGENTS_SOURCE.license, rea: { verdict: rea.verdict, summary: rea.summary, sha256: rea.sha256 ?? null }, at: now().toISOString() };
  const tmp = `${plan.receipt}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 1)); renameSync(tmp, plan.receipt);
  return { ok: true, ...receipt };
}

/** Installed at the pin, with its Python? → { ok, why?, commit?, rea? }. */
export function status({ state, exists = existsSync, read = (p) => readFileSync(p, 'utf8') }) {
  const L = layout(tradingAgentsDir(state));
  let receipt = null;
  try { receipt = JSON.parse(read(L.receipt)); } catch { return { ok: false, why: 'not installed (kingmaker markets install)' }; }
  if (receipt.commit !== TRADING_AGENTS_SOURCE.commit) return { ok: false, why: `installed at ${String(receipt.commit).slice(0, 12)}, not the pinned ${TRADING_AGENTS_SOURCE.commit.slice(0, 12)}: run kingmaker markets install again` };
  if (!exists(L.python)) return { ok: false, why: 'its Python is gone: run kingmaker markets install again' };
  return { ok: true, ...receipt };
}

/** Pure: a symbol as Yahoo writes it (NVDA, BRK-B, ^GSPC, GC=F, BTC-USD, 7203.T), or null. */
export function cleanTicker(value) {
  const t = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.=^-]{0,14}$/.test(t) ? t : null;
}
/** Pure: an analysis date (YYYY-MM-DD, a real day, not after today), or null. Defaults to today. */
export function cleanDate(value, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const d = String(value ?? '').trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) return null;
  return d > today ? null : d;
}

/**
 * Pure: how one analysis runs → { command, args, env, cwd } or { error }. The request goes to the driver as one JSON
 * argument; the environment is connectorEnv's (no Kingmaker keys) plus where TradingAgents may write and which Ollama
 * it thinks on. Nothing here can name a broker, an order or a key.
 */
export function runPlan({ state, ticker, date, model = WRITER_MODEL, deepModel, analysts = ANALYSTS, rounds = 1, crypto, language = 'English', ollama = 'http://127.0.0.1:11434', env = process.env, now = new Date() }) {
  const t = cleanTicker(ticker);
  if (!t) return { error: `"${String(ticker ?? '').slice(0, 20)}" isn't a ticker (NVDA, BRK-B, BTC-USD, 7203.T).` };
  const d = cleanDate(date, now);
  if (!d) return { error: `"${String(date).slice(0, 20)}" isn't a date up to today (YYYY-MM-DD).` };
  const picked = [...new Set((Array.isArray(analysts) ? analysts : String(analysts).split(',')).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  const unknown = picked.filter((a) => !ANALYSTS.includes(a));
  if (!picked.length || unknown.length) return { error: `Analysts are ${ANALYSTS.join(', ')}${unknown.length ? ` (not ${unknown.join(', ')})` : ''}.` };
  const r = Number(rounds);
  if (!Number.isInteger(r) || r < 1 || r > 3) return { error: 'Debate rounds are 1 to 3.' };
  const L = layout(tradingAgentsDir(state));
  const request = { ticker: t, date: d, assetType: (crypto ?? /-USD$/.test(t)) ? 'crypto' : 'stock', analysts: picked, rounds: r,
    model: String(model), deepModel: String(deepModel || model), language: String(language).slice(0, 40) };
  return {
    command: L.python, args: ['-I', DRIVER, JSON.stringify(request)], cwd: L.runs, request,
    env: { ...connectorEnv(null, env), PYTHONUNBUFFERED: '1', OLLAMA_BASE_URL: `${String(ollama).replace(/\/+$/, '')}/v1`,
      TRADINGAGENTS_RESULTS_DIR: join(L.runs, 'logs'), TRADINGAGENTS_CACHE_DIR: join(L.runs, 'cache'), TRADINGAGENTS_MEMORY_LOG_PATH: join(L.runs, 'memory', 'trading_memory.md') },
  };
}

/** Pure: the driver's one result line (the last RESULT_MARK line on stdout) → the result, or null. */
export function parseResult(stdout) {
  const line = String(stdout ?? '').split('\n').reverse().find((l) => l.startsWith(RESULT_MARK));
  if (!line) return null;
  try { const r = JSON.parse(line.slice(RESULT_MARK.length)); return r && typeof r === 'object' ? r : null; } catch { return null; }
}

/** Pure: what the owner reads (and Kingmaker says) about a result. */
export function resultLines(r) {
  if (!r?.ok) return [`✗ The trading desk didn't finish${r?.error ? `: ${String(r.error).slice(0, 300)}` : '.'}`];
  const rating = RATINGS.includes(r.rating) ? r.rating : 'no clear rating (REVIEW)';
  const out = [`${r.ticker} as of ${r.date}: ${rating}.`];
  const why = String(r.decision || '').replace(/\s+/g, ' ').trim();
  if (why) out.push(why.length > 600 ? `${why.slice(0, 600)}…` : why);
  if (r.reportDir) out.push(`Full reports: ${r.reportDir}`);
  out.push(DISCLAIMER);
  return out;
}

/**
 * Run one analysis: the driver in its own process group, killed whole on a timeout. → the parsed result
 * ({ ok, ticker, date, rating, decision, reports, reportDir } or { ok: false, error }).
 */
export function analyze(opts, { spawnImpl = spawn, timeoutMs = RUN_TIMEOUT_MS, onLine = () => {}, statusImpl = status } = {}) {
  const st = statusImpl({ state: opts.state });
  if (!st.ok) return Promise.resolve({ ok: false, error: `TradingAgents is ${st.why}.` });
  const plan = runPlan(opts);
  if (plan.error) return Promise.resolve({ ok: false, error: plan.error });
  mkdirSync(plan.cwd, { recursive: true });
  return new Promise((resolve) => {
    const child = spawnImpl(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } finish({ ok: false, error: `stopped after ${Math.round(timeoutMs / 60_000)} minutes` }); }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b; for (const l of String(b).split('\n')) if (l.trim() && !l.startsWith(RESULT_MARK)) onLine(l); });
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-8000); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const r = parseResult(stdout);
      finish(r ?? { ok: false, error: `exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}` });
    });
  });
}
